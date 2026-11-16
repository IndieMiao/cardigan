// Bounded synthetic status workload, never starts hc or reads host data.
// Usage after tsc -b: node .../call-profile.mjs <baseline-sha>
import childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { helperAccounting } from "./helper-cpu.mjs";

const helperCPU = helperAccounting();
const hz = Number(
  childProcess
    .execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" })
    .trim(),
);

const baseline = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(baseline ?? ""))
  throw Error("Full baseline SHA required");
const source = childProcess.execFileSync(
  "git",
  ["show", `${baseline}:packages/runtime-herdr/src/call-queue.ts`],
  { encoding: "utf8" },
);
const root = await mkdtemp(join(tmpdir(), "hc-call-profile-"));
const sockets = new Set();
const server = createServer((s) => {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
  s.on("error", () => {});
  let input = "";
  s.on("data", (chunk) => {
    input += chunk;
    for (;;) {
      const end = input.indexOf("\n");
      if (end < 0) break;
      const m = JSON.parse(input.slice(0, end));
      input = input.slice(end + 1);
      const result =
        m.method === "hello"
          ? {
              generation: 1,
              version: "0.1.18",
              framed: false,
              methods: ["terminal.get", "events.subscribe"],
            }
          : m.method === "terminal.get"
            ? terminals.find((t) => t.address === m.params.terminal)
            : { seq: ++seq, terminals };
      s.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n`);
    }
  });
});
let seq = 0,
  counts = {};
const terminals = Array.from({ length: 15 }, (_, i) => ({
  address: `t${i + 1}`,
  state: "live",
  status: { state: "idle" },
}));
const originalSpawn = childProcess.spawn,
  originalExecFile = childProcess.execFile;
const count = (binary) => {
  const key =
    binary === "flock" ? "flock" : binary === "python3" ? "lock_helper" : "hc";
  counts[key] = (counts[key] ?? 0) + 1;
};
childProcess.spawn = function (binary, ...args) {
  count(binary);
  const child = originalSpawn.call(this, binary, ...args);
  if (binary === "python3") helperCPU.track(child);
  return child;
};
childProcess.execFile = function (binary, ...args) {
  count(binary);
  return originalExecFile.call(this, binary, ...args);
};
syncBuiltinESMExports();
try {
  const clientURL = new URL("../dist/client.js", import.meta.url).href;
  const legacyPath = join(root, "legacy-queue.mjs");
  await writeFile(
    legacyPath,
    ts.transpile(source.replace('"./client.js"', JSON.stringify(clientURL)), {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.ESNext,
    }),
  );
  const legacy = await import(pathToFileURL(legacyPath).href);
  const modern = await import("../dist/call-queue.js");
  const { processClient } = await import(clientURL);
  const { HerdrRuntime } = await import("../dist/index.js");
  const binary = join(root, "fake-hc.cjs"),
    socket = join(root, "core.sock");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst ts=${JSON.stringify(terminals)};\nconst a=process.argv.slice(2);\nif(a[0]==='--version')console.log('hc 0.1.18');\nelse if(a[0]==='get')console.log(JSON.stringify(ts.find(t=>t.address===a[1])));\nelse if(a[0]==='events'){console.log(JSON.stringify({seq:1,type:'snapshot',terminals:ts}));setInterval(()=>{},15000);}\nelse process.exit(1);\n`,
    { mode: 0o700 },
  );
  await new Promise((resolve) => server.listen(socket, resolve));
  for (const [mode, module, direct] of [
    ["baseline", legacy, false],
    ["helper-socket", modern, true],
  ]) {
    const client = module.governHcClient(
      processClient(binary, { PATH: "/usr/bin:/bin" }, socket, 10000, direct),
      {
        socket,
        session: "synthetic",
        dataDir: join(root, mode),
        policy: { concurrency: 4, queueWaitMs: 30000 },
      },
    );
    counts = {};
    const created = await HerdrRuntime.create({
      client,
      session: "synthetic",
      execution: { mode: "local", dataDir: join(root, mode) },
    });
    if (!created.ok) throw Error("Synthetic adapter failed");
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    const cold_spawn = counts;
    counts = {};
    const helpersBefore = helperCPU.snapshot();
    const cpu = process.cpuUsage(),
      started = performance.now();
    for (let tick = 0; tick < 60; tick++) {
      // One status request per existing 1s dispatch interval, rotating 15 refs.
      const result = await created.value.status({
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: `t${(tick % 15) + 1}`,
        agent_name: "synthetic",
      });
      if (!result.ok)
        throw Error(`Synthetic status failed: ${result.error.code}`);
      await delay(Math.max(0, started + (tick + 1) * 1000 - performance.now()));
    }
    const elapsed = performance.now() - started,
      usage = process.cpuUsage(cpu);
    histogram.disable();
    console.log(
      JSON.stringify({
        mode,
        baseline,
        terminals: 15,
        status_requests: 60,
        elapsed_ms: elapsed,
        cold_spawn,
        spawn: counts,
        ...helperCPU.delta(helpersBefore, hz),
        spawn_per_minute:
          (Object.values(counts).reduce((a, b) => a + b, 0) * 60000) / elapsed,
        driver_cpu_ms: (usage.user + usage.system) / 1000,
        driver_cpu_percent: (usage.user + usage.system) / (elapsed * 10),
        event_loop_p99_ms: histogram.percentile(99) / 1e6,
      }),
    );
  }
} finally {
  childProcess.spawn = originalSpawn;
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  const { closeIdleHcLockHelpers } = await import(
    "../dist/call-lock-helper.js"
  );
  await closeIdleHcLockHelpers();
  await rm(root, { recursive: true, force: true });
}
