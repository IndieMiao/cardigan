import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import type { Store } from "@cardigan/store";
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
  "offline assembly uses %s slots and keeps the extra candidate queued",
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
    await vi.waitFor(() => expect(entered).toHaveLength(slots), {
      timeout: 10000,
    });
    expect(new Set(entered.map((i) => i.lockSlot)).size).toBe(slots);
    expect(runningMergeChecks(session.store).get("offline-probe")).toBe(slots);
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
    expect(runningMergeChecks(session.store).get("offline-probe")).toBe(slots);
    for (const exit of exits)
      exit.resolve({ ...passed, status: "interrupted" });
    await work;
    vi.useRealTimers();
    expect(entered).toHaveLength(slots);
    expect(runningMergeChecks(session.store).size).toBe(0);
    const report = await session.close();
    expect(report?.baseline_unchanged).toBe(true);
    expect(report?.checks.at(-1)?.status).toBe("queued");
    expect(session.messages).not.toContain("Measurement controller error");
    await expect(session.start()).rejects.toThrow("one-shot");
  },
);

test("real temporary probes transfer exact process identity and signal stop waits for cleanup", async () => {
  const session = await createOfflineMeasurement({ slots: 2, hold: true });
  roots.push(session.root);
  const signals = new EventEmitter();
  const detach = wireMeasurementSignals(() => session.stop(), signals as never);
  const work = session.start();
  await vi.waitFor(() => expect(session.owners).toHaveLength(2), {
    timeout: 10000,
  });
  for (const { owner } of session.owners)
    expect(executionOwner(owner.pid)).toEqual(owner);
  expect(runningMergeChecks(session.store).get("offline-probe")).toBe(2);
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
  ).toHaveLength(2);
  expect(report?.checks.at(-1)?.status).toBe("queued");
  detach();
  expect(signals.listenerCount("SIGTERM")).toBe(0);
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
