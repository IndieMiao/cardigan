import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckoutInput, CheckoutResult } from "@cardigan/host";
import {
  CHECKOUT_LIMITS,
  executionOwner,
  hostRepositoryLock,
  runCapacitySnapshot,
} from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  createOfflineMeasurement,
  refuseMeasurementPublication,
  validateMeasurementManifest,
  wireMeasurementSignals,
} from "./merge-measurement.js";

const roots: string[] = [];
const runningMergeChecks = (store: Store) =>
  store.uow.read((tx) => runCapacitySnapshot(store, tx).mergeChecks);
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const passed: CheckoutResult = {
  status: "passed",
  checks: [{ name: "probe", status: "passed", exit_code: 0 }],
  cleanup_errors: [],
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test.each([1, 2, 3] as const)(
  "offline SSH assembly with configured limit %s admits one and retains every queued candidate on stop",
  async (slots) => {
    const entered: CheckoutInput[] = [],
      exits: ReturnType<typeof deferred<CheckoutResult>>[] = [];
    const session = await createOfflineMeasurement({
      slots,
      run: async (input) => {
        entered.push(input);
        input.onReady?.(executionOwner(process.pid));
        const exit = deferred<CheckoutResult>();
        exits.push(exit);
        return exit.promise;
      },
    });
    roots.push(session.root);
    const work = session.start();
    await vi.waitFor(() => expect(entered).toHaveLength(1), {
      timeout: 10000,
    });
    expect(entered.map((i) => i.lockSlot)).toEqual([0]);
    expect(runningMergeChecks(session.store).get("offline-probe")).toBe(1);
    const state = session.store.uow.read((tx) =>
      loadCommandState(tx, session.project.project_id),
    );
    expect(state.decisions).toEqual([]);
    expect(
      state.cards.every((c) => c.merge_policy === "confirm" && c.sensitive),
    ).toBe(true);
    // No speculative early release while stop/exit evidence is unknown.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    session.stop();
    await vi.advanceTimersByTimeAsync(CHECKOUT_LIMITS.graceMs + 1);
    await expect(session.close()).rejects.toThrow("exit unknown");
    expect(entered.every((i) => i.signal?.aborted)).toBe(true);
    expect(runningMergeChecks(session.store).get("offline-probe")).toBe(1);
    for (const exit of exits)
      exit.resolve({ ...passed, status: "interrupted" });
    await work;
    vi.useRealTimers();
    expect(entered).toHaveLength(1);
    expect(runningMergeChecks(session.store).size).toBe(0);
    const report = await session.close();
    expect(report?.baseline_unchanged).toBe(true);
    expect(report).toMatchObject({
      executor_type: "ssh",
      configured_limit: slots,
      admission_limit: 1,
    });
    expect(report?.checks.map((check) => check?.status)).toEqual([
      "interrupted",
      ...Array(slots).fill("queued"),
    ]);
    expect(
      report?.checks.every(
        (check) => check?.base_sha === session.manifest.base,
      ),
    ).toBe(true);
    expect(session.messages).not.toContain("Measurement controller error");
    await expect(session.start()).rejects.toThrow("one-shot");
  },
);

test("real temporary probes record exact child identities and retain supervisor occupancy until cleanup", async () => {
  const session = await createOfflineMeasurement({ slots: 2, hold: true });
  roots.push(session.root);
  const signals = new EventEmitter();
  const detach = wireMeasurementSignals(() => session.stop(), signals as never);
  const work = session.start();
  await vi.waitFor(() => expect(session.owners).toHaveLength(1), {
    timeout: 10000,
  });
  for (const { owner } of session.owners)
    expect(executionOwner(owner.pid)).toEqual(owner);
  expect(
    session.store.database
      .prepare("SELECT DISTINCT owner_pid FROM merge_check_capacity")
      .all(),
  ).toEqual([{ owner_pid: process.pid }]);
  expect(runningMergeChecks(session.store).get("offline-probe")).toBe(1);
  signals.emit("SIGTERM");
  await work;
  expect(
    session.owners.every(
      (o) => o.exited && executionOwner(o.owner.pid)?.start !== o.owner.start,
    ),
  ).toBe(true);
  expect(runningMergeChecks(session.store).size).toBe(0);
  const report = await session.close();
  expect(
    report?.checks.filter((c) => c?.status === "interrupted"),
  ).toHaveLength(1);
  expect(report?.checks.at(-1)?.status).toBe("queued");
  detach();
  expect(signals.listenerCount("SIGTERM")).toBe(0);
});

test("stop during executor dispatch still polls for exact offline cleanup before releasing occupancy", async () => {
  const exit = deferred<CheckoutResult>();
  let calls = 0;
  const session = await createOfflineMeasurement({
    slots: 3,
    run: async (input) => {
      calls++;
      input.onReady?.(executionOwner(process.pid));
      // The provider has not returned its handle when shutdown arrives.
      session.stop();
      return exit.promise;
    },
  });
  roots.push(session.root);
  const work = session.start();
  try {
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 10000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await vi.advanceTimersByTimeAsync(CHECKOUT_LIMITS.graceMs + 1);
    await expect(session.close()).rejects.toThrow("exit unknown");
    expect(runningMergeChecks(session.store).get("offline-probe")).toBe(1);
  } finally {
    exit.resolve({ ...passed, status: "interrupted" });
    await work;
    vi.useRealTimers();
  }
  expect(calls).toBe(1);
  expect(runningMergeChecks(session.store).size).toBe(0);
  expect((await session.close())?.checks.map((check) => check?.status)).toEqual(
    ["interrupted", "queued", "queued", "queued"],
  );
});

test("fixed allowlist rejects project/target/commands, paths, abbreviated SHA/tree/base and new candidates", async () => {
  const session = await createOfflineMeasurement({ slots: 1 });
  roots.push(session.root);
  const approved = structuredClone(session.manifest);
  for (const changed of [
    { project: "other" },
    { target: "local" },
    { target: "production" },
    { command: "true" },
    { path: "/unapproved" },
    { base: "main" },
    { candidates: [{ ...approved.candidates[0], tree_sha: "a" }] },
    { candidates: [...approved.candidates, approved.candidates[0]] },
  ])
    expect(() =>
      validateMeasurementManifest(
        { ...approved, ...changed } as never,
        approved,
      ),
    ).toThrow("fixed approved");
  const original = session.manifest.candidates[0]?.tree_sha;
  (session.manifest.candidates[0] as { tree_sha: string }).tree_sha =
    "0".repeat(40);
  await expect(session.adapter.baseline(session.project)).rejects.toThrow(
    "fixed approved",
  );
  (session.manifest.candidates[0] as { tree_sha: string }).tree_sha = original;
  session.stop();
  await session.start();
  await session.close();
});

test("both publishing methods fail structurally and report attempts before touching Git", async () => {
  const session = await createOfflineMeasurement({ slots: 1 });
  roots.push(session.root);
  expect(() => refuseMeasurementPublication(() => {})).toThrow("disabled");
  await expect(
    session.adapter.merge(
      session.project,
      session.manifest.candidates[0]?.plan,
    ),
  ).rejects.toThrow("disabled");
  await expect(
    session.adapter.publish(session.project, "D-2" as never, {} as never),
  ).rejects.toThrow("disabled");
  expect(
    session.messages.filter((m) => m.includes("publication attempt refused")),
  ).toHaveLength(2);
  session.stop();
  await session.start();
  expect((await session.close())?.baseline_unchanged).toBe(true);
});

test("trusted lock injection contends with the original project lock in temporary paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "measurement-original-lock-"));
  roots.push(root);
  const original = hostRepositoryLock(root),
    injected = hostRepositoryLock(root);
  const session = await createOfflineMeasurement({
    slots: 1,
    repositoryLock: injected,
  });
  roots.push(session.root);
  const entered = deferred<void>(),
    release = deferred<void>();
  const holder = original(
    { project_id: session.project.project_id, repository: "original-center" },
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  await entered.promise;
  let completed = false;
  const waiting = session.adapter.baseline(session.project).then(() => {
    completed = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(completed).toBe(false);
  release.resolve();
  await holder;
  await waiting;
  expect(completed).toBe(true);
  session.stop();
  await session.start();
  await session.close();
});

test("built standalone executable rejects real/path/command inputs and supports SIGTERM", async () => {
  const launch = (args: string[]) => {
    const child = spawn(
      process.execPath,
      ["apps/server/dist/merge-measurement-main.js", ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS },
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b;
    });
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    const close = new Promise<number | null>((resolve) =>
      child.once("close", resolve),
    );
    return { child, close, stdout: () => stdout, stderr: () => stderr };
  };
  for (const args of [
    ["--real"],
    ["--offline-demo", "3", "--path=/unapproved"],
    ["--offline-demo", "--command=true"],
  ]) {
    const child = launch(args);
    expect(await child.close).toBe(2);
    expect(child.stdout()).toBe("");
    expect(child.stderr()).toContain("Real execution refused");
  }
  const child = launch(["--offline-demo", "1", "--hold"]);
  await vi.waitFor(
    () => expect(child.stderr()).toContain("Offline probe ready"),
    { timeout: 10000 },
  );
  const initial = JSON.parse(child.stdout().split("\n")[0] ?? "");
  roots.push(initial.evidence);
  expect(initial.owner).toEqual(executionOwner(child.child.pid ?? 0));
  expect(
    Object.values(initial.artifact_sha256).every((v) =>
      /^[a-f0-9]{64}$/u.test(v as string),
    ),
  ).toBe(true);
  child.child.kill("SIGTERM");
  expect(await child.close).toBe(0);
  const report = JSON.parse(
    await readFile(join(initial.evidence, "report.json"), "utf8"),
  );
  expect(report.owners).toHaveLength(1);
  expect(report.owners[0].exited).toBe(true);
  expect(report.baseline_unchanged).toBe(true);
});

/** Run the built entry with all harness pipes closed to the child: only its own
 * lifecycle handles may keep it alive. Faults are scoped to synthetic probes. */
function isolatedModule(code: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS },
  });
  let stdout = "",
    stderr = "";
  let ended = false;
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const close = new Promise<number | null>((resolve) =>
    child.once("close", (status) => {
      ended = true;
      resolve(status);
    }),
  );
  return {
    child,
    close,
    stdout: () => stdout,
    stderr: () => stderr,
    ended: () => ended,
  };
}
const cliImport = `
process.argv = ['node', 'apps/server/dist/merge-measurement-main.js', '--offline-demo', '1'];
await import('./apps/server/dist/merge-measurement-main.js');`;

function retainedCapacity(root: string) {
  const store = Store.open({ dataDir: join(root, "data") });
  try {
    return runningMergeChecks(store).get("offline-probe") ?? 0;
  } finally {
    store.close();
  }
}
async function lifecycle(root: string) {
  return JSON.parse(await readFile(join(root, "lifecycle.json"), "utf8"));
}
async function initialOutput(run: ReturnType<typeof isolatedModule>) {
  await vi.waitFor(() => expect(run.stdout()).toContain('"evidence":'), {
    timeout: 10000,
  });
  const initial = JSON.parse(run.stdout().split("\n")[0] ?? "");
  roots.push(initial.evidence);
  return initial;
}
async function verifyChildrenExited(root: string) {
  const state = await lifecycle(root);
  for (const entry of state.owners) {
    expect(executionOwner(entry.owner.pid)?.start).not.toBe(entry.owner.start);
  }
}

// Each parent removes only the fault marker to allow the original process to
// recheck its original identity/cleanup. It never edits lifecycle or capacity.
test.each(["cleanup", "identity"] as const)(
  "built CLI retains live occupancy after child close with %s failure, then reports failed recovery",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "measurement-fault-"));
    roots.push(root);
    const marker = join(root, "deny");
    await writeFile(marker, "synthetic failure");
    const injection =
      failure === "cleanup"
        ? `
import fs from 'node:fs/promises';
const rm = fs.rm;
fs.rm = async (path, options) => {
  if (sync.existsSync(${JSON.stringify(marker)}) && /\\/probe-[^/]+$/.test(String(path)))
    throw Object.assign(new Error('Synthetic cleanup denied'), {code:'EACCES'});
  return rm(path, options);
};`
        : `
const read = sync.readFileSync;
sync.readFileSync = function(path, ...args) {
  // Fail only after the captured child has gone, so no child IPC or process
  // can accidentally keep the supervisor alive during the assertion.
  if (sync.existsSync(${JSON.stringify(marker)}) && /^\\/proc\\/\\d+\\/stat$/.test(String(path)) &&
      path !== '/proc/' + process.pid + '/stat' && !sync.existsSync(path))
    throw Object.assign(new Error('Synthetic identity unknown'), {code:'EACCES'});
  return read.call(sync, path, ...args);
};`;
    const run = isolatedModule(`import sync from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
${injection}
syncBuiltinESMExports();
${cliImport}`);
    const initial = await initialOutput(run);
    try {
      const notice =
        failure === "cleanup"
          ? "Offline probe cleanup failed"
          : "Probe exit unknown";
      await vi.waitFor(() => expect(run.stderr()).toContain(notice), {
        timeout: 10000,
      });
      await verifyChildrenExited(initial.evidence);
      // Observe multiple actual monitor ticks after the last child/IPC closed.
      await new Promise((resolve) =>
        setTimeout(resolve, CHECKOUT_LIMITS.procReadMs * 2 + 50),
      );
      expect(run.ended()).toBe(false);
      expect(retainedCapacity(initial.evidence)).toBe(1);
      expect(run.stderr().split("Offline probe ready")).toHaveLength(2);
      expect(
        (await lifecycle(initial.evidence)).faults.some(
          (f: { resolved: boolean }) => !f.resolved,
        ),
      ).toBe(true);
      expect(await readdir(initial.evidence)).not.toContain("report.json");
      expect(
        (await readdir(initial.evidence)).filter((p) => p.startsWith("probe-")),
      ).toHaveLength(1);
      run.child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(run.ended()).toBe(false);
      expect(retainedCapacity(initial.evidence)).toBe(1);
      await rm(marker);
      await vi.waitFor(() => expect(run.ended()).toBe(true), {
        timeout: 10000,
      });
      expect(await run.close).toBe(1);
      const report = JSON.parse(
        await readFile(join(initial.evidence, "report.json"), "utf8"),
      );
      expect(report.exit_code).toBe(1);
      expect(report.faults).toEqual([
        expect.objectContaining({
          resolved: true,
          reason: expect.stringContaining(notice),
        }),
      ]);
      expect(report.checks.map((c: { status: string }) => c.status)).toEqual([
        "failed",
        "queued",
      ]);
      expect(report.owners).toHaveLength(1);
      expect(report.owners[0].exited).toBe(true);
      expect(retainedCapacity(initial.evidence)).toBe(0);
      expect(
        (await readdir(initial.evidence)).filter((p) => p.startsWith("probe-")),
      ).toEqual([]);
      expect(report.baseline_unchanged).toBe(true);
    } finally {
      // Only our exact ChildProcess is stopped, after confirming all probe
      // children already exited. No lock, foreign task or unknown child is removed.
      await verifyChildrenExited(initial.evidence);
      if (!run.ended()) run.child.kill("SIGKILL");
      await run.close;
    }
  },
  20000,
);

test.each(["manual_attention", "cleanup_errors", "exception"] as const)(
  "independent runner retains %s without any child handles",
  async (kind) => {
    const run = isolatedModule(`
import {createOfflineMeasurement, wireMeasurementSignals} from './apps/server/dist/merge-measurement.js';
const session = await createOfflineMeasurement({slots:1,
  onNotice: text => process.stderr.write(text + '\\n'),
  run: async input => {
    input.onReady();
    ${kind === "exception" ? "throw new Error('Synthetic execution failure');" : `return {status:'interrupted', checks:[], cleanup_errors:['unconfirmed cleanup'], manual_attention:${kind === "manual_attention"}};`}
  }});
wireMeasurementSignals(() => session.stop());
process.stdout.write(JSON.stringify({evidence:session.root, pid:process.pid}) + '\\n');
await session.start();
await session.close();`);
    const initial = await initialOutput(run);
    try {
      await vi.waitFor(() => expect(run.stderr()).toContain("retained"), {
        timeout: 10000,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, CHECKOUT_LIMITS.procReadMs * 2 + 50),
      );
      expect(run.ended()).toBe(false);
      expect(retainedCapacity(initial.evidence)).toBe(1);
      const state = await lifecycle(initial.evidence);
      expect(state.settled).toBe(false);
      expect(state.owners).toEqual([]); // No child handles ever existed in this seam.
      expect(state.faults).toHaveLength(1);
      expect(state.faults[0].resolved).toBe(false);
      run.child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(run.ended()).toBe(false);
      expect(retainedCapacity(initial.evidence)).toBe(1);
      expect(await readdir(initial.evidence)).not.toContain("report.json");
      expect(run.stdout().split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      // This trusted fake run created zero child processes/resources. Terminate
      // only its verified supervisor after preserving assertions/evidence.
      await verifyChildrenExited(initial.evidence);
      if (!run.ended()) run.child.kill("SIGKILL");
      await run.close;
    }
  },
  15000,
);

test("built CLI exits nonzero when all processes and cleanup finished but a check failed", async () => {
  const run = isolatedModule(`
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const spawn = cp.spawn;
cp.spawn = (file, args, options) => {
  if (file === process.execPath && args[0] === '-e' && args[1].includes("process.send('ready')"))
    args = ['-e', args[1].replace('process.exit(0)', 'process.exit(7)')];
  return spawn(file, args, options);
};
syncBuiltinESMExports();
${cliImport}`);
  const initial = await initialOutput(run);
  await vi.waitFor(() => expect(run.ended()).toBe(true), { timeout: 10000 });
  expect(await run.close).toBe(1);
  await verifyChildrenExited(initial.evidence);
  const report = JSON.parse(
    await readFile(join(initial.evidence, "report.json"), "utf8"),
  );
  expect(
    report.checks.every((c: { status: string }) => c.status === "failed"),
  ).toBe(true);
  expect(report.faults).toEqual([]);
  expect(report.exit_code).toBe(1);
  expect(retainedCapacity(initial.evidence)).toBe(0);
});
