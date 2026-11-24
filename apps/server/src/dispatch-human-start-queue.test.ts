import type { Assignment, Runtime } from "@cardigan/domain";
import {
  dispatchRun,
  finishRun,
  issueInstruction,
  queueRun,
  stoppedByHuman,
  stopWorkItemAssignment,
  updateWorkItem,
} from "@cardigan/domain";
import { launchRun, RunCapacityDeferred, readRunQueue } from "@cardigan/host";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// C-624 regression (R-715/A-62 on mac-mini): the human stopped an Assignment,
// then started it while the emulator was busy. The start queued a Run, but the
// stop was only lifted by a dispatch, so nobody dispatched the Run and it held
// the head of the machine queue. Real SQLite, fake runtime, no CPU load.
let f: ReturnType<typeof dispatchFixture>,
  target: ReturnType<typeof f.create>,
  runtime: Runtime,
  options: DispatcherOptions;
beforeEach(() => {
  f = dispatchFixture();
  target = f.create();
  f.session(target.assignment);
  const cards = f.store.uow.read((tx) => [
    undefined,
    ...tx.cards.list(f.project).map((card) => card.id),
  ]);
  for (const card_id of cards)
    f.store.advanceRouterCursor(
      f.project,
      card_id ?? PROJECT_EVENT_STREAM,
      f.store.getUpdates({
        project_id: f.project,
        ...(card_id ? { card_id } : {}),
      }).latest_seq,
    );
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

const requireCapabilities = (
  item: typeof target.item,
  capabilities: string[],
) =>
  f.apply((s, a, p) =>
    updateWorkItem(
      s,
      a,
      { work_item_id: item.id, requirements: { capabilities } },
      p,
    ),
  );
const finish = (owner: Assignment) => {
  const run = f
    .state()
    .runs.find((r) => r.assignment_id === owner.id && r.status === "running");
  if (!run) throw new Error("Missing running Run");
  f.apply(
    (s, a, p) =>
      finishRun(
        s,
        a,
        { run_id: run.id, outcome: "completed", summary: "done" },
        p,
      ),
    f.actorFor(owner),
  );
};
// C-721: godot work is an instruction; a comment would claim no resources.
const instruct = (owner: ReturnType<typeof f.create>) =>
  f.apply((s, a, p) =>
    issueInstruction(
      s,
      a,
      { card_id: owner.card.id, work_item_id: owner.item.id, body: "Go" },
      p,
    ),
  );
const limits = {
  runLimit: () => 4,
  resourceLimits: () =>
    new Map([
      ["android.emulator", 1],
      ["godot", 3],
    ]),
};
const statusOf = (id: string) => f.state().runs.find((r) => r.id === id);

/** `cardigan assignment stop`: record the stop, then settle the released terminal. */
function humanStop(a: Assignment) {
  const ref = f.state().assignments.find((x) => x.id === a.id)?.runtime_ref;
  if (!ref) throw new Error("Missing terminal");
  for (const released of [undefined, ref])
    f.apply((s, actor, p) =>
      stopWorkItemAssignment(
        s,
        actor,
        {
          assignment_id: a.id,
          reason: "stopped by host",
          ...(released ? { released_runtime_ref: released } : {}),
        },
        p,
      ),
    );
  expect(stoppedByHuman(f.state().events, a.id)).toBe(true);
}

/** `cardigan assignment start` while the emulator is busy: the Run queues. */
async function humanStartQueued(a: Assignment) {
  const run = f.apply((s, actor, p) =>
    queueRun(
      s,
      actor,
      {
        assignment_id: a.id,
        reuse_queued: true,
        model: "m",
        agent_cli_version: "1",
      },
      p,
    ),
  );
  await expect(
    launchRun(
      {
        store: f.store,
        runtime,
        launch: { config: { gateways: {}, profiles: {} }, secrets: {} },
        mcpUrl: "http://127.0.0.1/mcp",
        dataDir: f.dataDir,
        ...limits,
      },
      {
        project: f.project,
        assignment_id: a.id,
        run,
        actor: { kind: "human", project_id: f.project },
        reuse_session: true,
      },
    ),
  ).rejects.toBeInstanceOf(RunCapacityDeferred);
  return run;
}

test("C-624 a start queued after a human stop dispatches once the emulator frees, and later godot work is not held", async () => {
  // R-726 holds the only emulator.
  const emulator = f.create();
  requireCapabilities(emulator.item, ["android.emulator"]);
  f.session(emulator.assignment, false);
  requireCapabilities(target.item, ["android.emulator", "godot"]);
  humanStop(target.assignment);
  const queued = await humanStartQueued(target.assignment);
  expect(statusOf(queued.id)).toMatchObject({
    status: "queued",
    queue_reason: "concurrency_limit",
  });
  // The queued start is the human's start: it is recorded and lifts the stop.
  const started = f
    .state()
    .events.filter((e) => e.type === "assignment_start_requested");
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({
    card_id: target.card.id,
    actor: { kind: "human" },
    payload: { assignment_id: target.assignment.id, run_id: queued.id },
  });
  expect(stoppedByHuman(f.state().events, target.assignment.id)).toBe(false);

  // Later godot-only work (R-781, R-784) is not held behind the emulator wait.
  const later = [f.create(), f.create()];
  for (const owner of later) {
    requireCapabilities(owner.item, ["godot"]);
    f.session(owner.assignment);
    instruct(owner);
  }
  const dispatcher = new Dispatcher({ ...options, ...limits });
  await dispatcher.tick();
  for (const owner of later)
    expect(
      f
        .state()
        .runs.some(
          (r) =>
            r.assignment_id === owner.assignment.id &&
            r.status === "dispatched",
        ),
    ).toBe(true);
  expect(statusOf(queued.id)?.status).toBe("queued");
  expect(readRunQueue(f.store).map((r) => r.run_id)).toEqual([queued.id]);

  // The emulator frees: the queued start dispatches without another human start.
  finish(emulator.assignment);
  await dispatcher.tick();
  expect(statusOf(queued.id)?.status).toBe("dispatched");
  expect(options.startRun).toHaveBeenCalledOnce();
  expect(readRunQueue(f.store)).toEqual([]);
});

test("C-624 a stopped owner's leftover queue never blocks others; a human start resumes it in place", async () => {
  requireCapabilities(target.item, ["android.emulator", "godot"]);
  humanStop(target.assignment);
  // A row left by the old behaviour: queued for capacity, still human-stopped.
  const leftover = f.apply(
    (s, actor, p) =>
      queueRun(
        s,
        actor,
        {
          assignment_id: target.assignment.id,
          model: "m",
          agent_cli_version: "1",
        },
        p,
      ),
    { kind: "system", project_id: f.project },
  );
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, { ...leftover, queue_reason: "concurrency_limit" }),
  );
  expect(stoppedByHuman(f.state().events, target.assignment.id)).toBe(true);
  expect(readRunQueue(f.store)).toEqual([]);

  // Emulator and godot are both free: the stopped head no longer holds R-781.
  const later = f.create();
  requireCapabilities(later.item, ["godot"]);
  f.session(later.assignment);
  instruct(later);
  const dispatcher = new Dispatcher({ ...options, ...limits });
  await dispatcher.tick();
  expect(
    f
      .state()
      .runs.some(
        (r) =>
          r.assignment_id === later.assignment.id && r.status === "dispatched",
      ),
  ).toBe(true);
  expect(statusOf(leftover.id)?.status).toBe("queued");
  expect(options.startRun).not.toHaveBeenCalled();

  // The human start reuses the same Run, records the start and dispatches it.
  const resumed = f.apply((s, actor, p) =>
    queueRun(
      s,
      actor,
      {
        assignment_id: target.assignment.id,
        reuse_queued: true,
        model: "m",
        agent_cli_version: "1",
      },
      p,
    ),
  );
  expect(resumed.id).toBe(leftover.id);
  expect(stoppedByHuman(f.state().events, target.assignment.id)).toBe(false);
  await dispatcher.tick();
  expect(statusOf(leftover.id)?.status).toBe("dispatched");
  expect(options.startRun).toHaveBeenCalledOnce();
});

test("C-624 a system queue does not lift a human stop", () => {
  humanStop(target.assignment);
  f.apply(
    (s, actor, p) =>
      queueRun(
        s,
        actor,
        {
          assignment_id: target.assignment.id,
          model: "m",
          agent_cli_version: "1",
        },
        p,
      ),
    { kind: "system", project_id: f.project },
  );
  expect(
    f.state().events.some((e) => e.type === "assignment_start_requested"),
  ).toBe(false);
  expect(stoppedByHuman(f.state().events, target.assignment.id)).toBe(true);
});
