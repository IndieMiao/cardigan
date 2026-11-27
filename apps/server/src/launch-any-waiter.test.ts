import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "@cardigan/domain";
import { dispatchRun, queueRun, updateWorkItem } from "@cardigan/domain";
import {
  launchRun,
  loadRunCapacityConfig,
  MachineLeases,
  RunCapacityDeferred,
  readRunQueue,
} from "@cardigan/host";
import {
  beginMachineObservation,
  completeMachineObservation,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// C-825: an earlier `android.any` waiter both of whose options are held waits
// elsewhere. The host launch path judged it by its unresolved keys and so held
// a later startable Run back until a device freed up, while the dispatcher let
// that Run go. Real SQLite, fake runtime, no CPU load.
let f: ReturnType<typeof dispatchFixture>,
  runtime: Runtime,
  options: DispatcherOptions;
beforeEach(() => {
  f = dispatchFixture();
  runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    provision: async () => {
      throw new Error("use host callback");
    },
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    interrupt: async () => ({ ok: true, value: undefined }),
    resume_or_replace: async () => {
      throw new Error("unused");
    },
    human_entry: async () => ({ ok: true, value: "fixture" }),
  };
  options = {
    store: f.store,
    runtime,
    clock: f.clock,
    deliveryLeaseMs: 1000,
    snapshot: vi.fn(async () => ({
      model: "new-model",
      agent_cli_version: "new-cli",
    })),
    startRun: vi.fn(async ({ run, assignment }) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          { run_id: run.id, runtime_ref: f.refFor(assignment) },
          p,
        ),
      );
    }),
  };
});
afterEach(() => f.close());

type Owner = ReturnType<typeof f.create>;
const requireCapabilities = (owner: Owner, capabilities: string[]) =>
  f.apply((s, a, p) =>
    updateWorkItem(
      s,
      a,
      { work_item_id: owner.item.id, requirements: { capabilities } },
      p,
    ),
  );
async function capacity(resources: Record<string, number>) {
  await writeFile(
    join(f.dataDir, "run-capacity.yaml"),
    JSON.stringify({ machines: { local: { limit: 6, resources } } }),
    { mode: 0o600 },
  );
  const loaded = await loadRunCapacityConfig({ configDir: f.dataDir });
  expect(loaded.errors).toEqual([]);
  return loaded;
}
function observe(keys: readonly string[]) {
  const actor = { kind: "system" as const, project_id: f.project };
  const at = f.clock.now();
  beginMachineObservation(f.store, actor, f.project, "local", "obs-1", at);
  completeMachineObservation(
    f.store,
    actor,
    f.project,
    "local",
    "obs-1",
    { status: "passed", checked_at: at, blockers: [], launch_enabled: true },
    keys.map((key) => ({
      key,
      version: null,
      verified_at: at,
      evidence_ref: `machine-observation:obs-1#${key}`,
    })),
  );
}

/**
 * The emulator is reserved by another project (made while it still had a
 * limit; run-capacity.yaml now has none for it) and the only device slot is
 * held. Returns the leases and limits the dispatcher and host launch share.
 */
async function bothHeld() {
  const at = f.clock.now();
  f.store.createProject({ id: "priority" });
  await new MachineLeases(
    f.store,
    await capacity({ "android.emulator": 1, "android.device": 1 }),
    vi.fn(),
  ).reserve(
    { kind: "human", project_id: "priority" },
    "local",
    "android.emulator",
    at,
    new Date(Date.parse(at) + 3_600_000).toISOString(),
    () => at,
  );
  const cfg = await capacity({ "android.device": 1 });
  observe(["android.emulator", "android.device", "android.any"]);
  const holder = f.create();
  requireCapabilities(holder, ["android.device"]);
  f.session(holder.assignment, false);
  return {
    leases: new MachineLeases(f.store, cfg, vi.fn()),
    resourceLimits: cfg.resourcesForMachine,
    runLimit: () => 6,
  };
}

/** A Run queued for a free slot, before any lease check recorded a wait. */
function queued(owner: Owner) {
  f.session(owner.assignment);
  f.advance(100);
  const run = f.apply(
    (s, actor, p) =>
      queueRun(
        s,
        actor,
        {
          assignment_id: owner.assignment.id,
          model: "m",
          agent_cli_version: "1",
        },
        p,
      ),
    { kind: "system", project_id: f.project },
  );
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, { ...run, queue_reason: "concurrency_limit" }),
  );
  return run;
}

test("C-825 the host launch does not hold a startable Run behind an android.any waiter held on both options", async () => {
  const shared = await bothHeld();
  // Queued while the machine was full, before the reservation was in force.
  const earlier = f.create();
  requireCapabilities(earlier, ["android.any"]);
  queued(earlier);
  const later = f.create();
  const run = queued(later);
  expect(readRunQueue(f.store).map((r) => r.assignment_id)).toEqual([
    earlier.assignment.id,
    later.assignment.id,
  ]);
  const outcome = await launchRun(
    {
      store: f.store,
      runtime,
      launch: { config: { gateways: {}, profiles: {} }, secrets: {} },
      mcpUrl: "http://127.0.0.1/mcp",
      dataDir: f.dataDir,
      clock: f.clock,
      ...shared,
    },
    {
      project: f.project,
      assignment_id: later.assignment.id,
      run,
      actor: { kind: "system", project_id: f.project },
      reuse_session: true,
    },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  // Admitted: the fixture session then fails to start, never a capacity wait.
  expect(outcome).not.toBeInstanceOf(RunCapacityDeferred);
  expect(String(outcome)).toContain("Live session has no active token");
  // The dispatcher leaves the waiter queued on the emulator reservation.
  await new Dispatcher({ ...options, ...shared }).tick();
  expect(readRunQueue(f.store).map((r) => r.assignment_id)).toEqual([
    earlier.assignment.id,
  ]);
  expect(options.startRun).not.toHaveBeenCalled();
});
