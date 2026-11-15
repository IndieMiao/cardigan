// Bounded lock-wait experiment. Uses only private fixture files and processes.
// After tsc -b: node .../lock-wait-profile.mjs <full-baseline-sha>
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ownChildrenTicks = () => {
  const text = readFileSync("/proc/self/stat", "utf8");
  const fields = text.slice(text.lastIndexOf(") ") + 2).split(" ");
  return Number(fields[13]) + Number(fields[14]);
};
const message = () =>
  new Promise((resolve) => process.once("message", resolve));
if (process.argv[2] === "participant") {
  const [role, module, root, slots, calls, hz] = process.argv.slice(3);
  const concurrency = Number(slots),
    socket = join(root, "hc.sock"),
    session = "fixture";
  const handles = [];
  let client;
  if (role === "holder") {
    await mkdir(join(root, "locks"), { recursive: true, mode: 0o700 });
    const hash = createHash("sha256")
      .update(JSON.stringify([socket, session]))
      .digest("hex");
    for (let i = 0; i < concurrency; i++) {
      const handle = await open(
        join(root, "locks", `hc-${hash}-${i}.lock`),
        "a+",
        0o600,
      );
      handles.push(handle);
      // flock(1) acquires the shared open-file-description lock. This Node
      // holder retains the fd after the cold helper exits, exactly as before.
      const child = spawn("flock", ["--exclusive", "3"], {
        stdio: ["ignore", "ignore", "ignore", handle.fd],
      });
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(Error("Fixture lock failed")),
        );
      });
    }
  } else {
    const { governHcClient } = await import(module);
    client = governHcClient(
      {
        available: async () => true,
        async *lines() {},
        exec: async () => {
          throw Error("Occupied slot executed IO");
        },
      },
      {
        socket,
        session,
        dataDir: root,
        policy: { concurrency, queueWaitMs: 3000 },
      },
    );
  }
  const start = message();
  process.send({ type: "ready" });
  await start;
  const cpu = process.cpuUsage(),
    childTicks = ownChildrenTicks(),
    started = performance.now();
  let outcomes;
  if (role === "holder") {
    await message();
    for (const handle of handles) await handle.close();
  } else {
    outcomes = (
      await Promise.allSettled(
        Array.from({ length: Number(calls) }, () => client.exec(["get", "t1"])),
      )
    ).map((r) => r.reason?.code ?? "unexpected");
    if (outcomes.some((r) => r !== "runtime_queue_timeout"))
      throw Error("Unexpected fixture outcome");
  }
  const wall_ms = performance.now() - started,
    usage = process.cpuUsage(cpu);
  const own_cpu_ms = (usage.user + usage.system) / 1000;
  process.send({
    type: "result",
    role,
    outcomes,
    wall_ms,
    own_cpu_ms,
    own_cpu_percent: (own_cpu_ms * 100) / wall_ms,
    reaped_child_cpu_ms:
      ((ownChildrenTicks() - childTicks) * 1000) / Number(hz),
  });
  process.disconnect();
} else {
  const baseline = process.argv[2];
  if (!/^[0-9a-f]{40}$/.test(baseline ?? "") || process.platform !== "linux")
    throw Error("Linux and full baseline SHA required");
  const root = await mkdtemp(join(tmpdir(), "hc-lock-wait-")),
    children = new Set();
  const hz = execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim();
  const source = execFileSync(
    "git",
    ["show", `${baseline}:packages/runtime-herdr/src/call-queue.ts`],
    { encoding: "utf8" },
  );
  function participant(role, module, directory, slots, calls) {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "participant",
        role,
        module,
        directory,
        String(slots),
        String(calls),
        hz,
      ],
      {
        env: { PATH: process.env.PATH, NODE_DISABLE_COMPILE_CACHE: "1" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    children.add(child);
    const closed = new Promise((resolve) => child.once("close", resolve));
    let ready, result, failed;
    const failure = new Promise((_, reject) => {
      failed = reject;
    });
    // Both promises have rejection handlers before any participant starts.
    const prepared = Promise.race([
      new Promise((resolve) => {
        ready = resolve;
      }),
      failure,
    ]);
    const completed = Promise.race([
      new Promise((resolve) => {
        result = resolve;
      }),
      failure,
    ]);
    completed.catch(() => {});
    child.on("message", (m) => {
      if (m.type === "ready") ready();
      if (m.type === "result") result(m);
    });
    child.once("error", () => failed(Error("Fixture participant failed")));
    child.once("exit", (code) => {
      if (code !== 0) failed(Error("Fixture participant exited"));
    });
    return { child, prepared, completed, closed };
  }
  try {
    const { default: ts } = await import("typescript");
    const legacy = join(root, "legacy.mjs");
    await writeFile(
      legacy,
      ts.transpile(
        source.replace(
          '"./client.js"',
          JSON.stringify(new URL("../dist/client.js", import.meta.url).href),
        ),
        { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
      ),
    );
    for (const [slots, calls, waiters] of [
      [1, 1, 1],
      [4, 6, 3],
    ]) {
      for (const [mode, module] of [
        ["legacy-flock", pathToFileURL(legacy).href],
        [
          "native-backoff",
          new URL("../dist/call-queue.js", import.meta.url).href,
        ],
      ]) {
        const directory = join(root, `${mode}-${slots}`);
        await mkdir(directory, { mode: 0o700 });
        const holder = participant("holder", module, directory, slots, calls);
        await holder.prepared;
        const waiting = Array.from({ length: waiters }, () =>
          participant("waiter", module, directory, slots, calls),
        );
        await Promise.all(waiting.map((p) => p.prepared));
        holder.child.send("start");
        for (const p of waiting) p.child.send("start");
        const rows = await Promise.all(waiting.map((p) => p.completed));
        holder.child.send("stop");
        rows.push(await holder.completed);
        await Promise.all([holder, ...waiting].map((p) => p.closed));
        console.log(
          JSON.stringify({
            mode,
            baseline,
            concurrency: slots,
            calls_per_waiter: calls,
            waiting_processes: waiters,
            queue_wait_ms: 3000,
            child_cpu_resolution_ms: 1000 / Number(hz),
            processes: rows,
          }),
        );
      }
    }
  } finally {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}
