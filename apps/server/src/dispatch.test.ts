import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Assignment,
  CommandEffect,
  CommandPorts,
  CommandState,
  ProjectId,
  Result,
  Run,
  Runtime,
} from "@cardigan/domain";
import {
  acknowledgeRun,
  assign,
  beginHostOpsAction,
  createCard,
  dispatchRun,
  finishRun,
  HOST_OPS_ROLE_TOOLS,
  postComment,
  queueRun,
  recordLaunchPublication,
  requestDecision,
  setRunLimit,
  stopWorkItemAssignment,
  updateCard,
  updateWorkItem,
} from "@cardigan/domain";
import {
  acquireMergeCheckCapacity,
  executionOwner,
  launchRun,
  mergeCheckCapacityAvailable,
  RunCapacityDeferred,
  RuntimeTargetError,
  readRunQueue,
  runCapacitySnapshot,
  tryHostOpsLock,
} from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  beginBellAttempt,
  beginLaunchAttempt,
  listBellAttempts,
  PROJECT_EVENT_STREAM,
  persistRunLimitEffect,
  Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startAssignmentCommand } from "../../cli/src/assignment.js";
import { attentionCommand } from "../../cli/src/inbox.js";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import {
  acceptThroughMergeGate,
  m4Fixture,
  m4Scenario,
  mergeConfirmation,
} from "./m4-fixtures.js";
import { MergeChecks } from "./merge-checks.js";
import { readCardList } from "./web/card-state.js";
import { executionCapacity } from "./web/execution-capacity.js";
import { executionView } from "./web/read.js";

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
      value: { process: "alive", agent: "working", observed_seq: 1 },
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
const comment = (body = "Read the card") =>
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: target.card.id, work_item_id: target.item.id, body },
      p,
    ),
  );
const ownNotes = () =>
  f.store.listNotifications({
    project_id: f.project,
    assignment_id: target.assignment.id,
  });

test.each(["recover", "exhaust", "permanent"])(
  "snapshot preflight: %s",
  async (outcome) => {
    target = f.create();
    comment();
    const snapshot = vi.fn(options.snapshot);
    snapshot.mockRejectedValueOnce(
      new RuntimeTargetError(
        outcome === "permanent" ? "remote_launch_disabled" : "mcp_timeout",
      ),
    );
    if (outcome === "exhaust")
      snapshot.mockRejectedValue(
        new RuntimeTargetError("machine_check_runtime_timeout"),
      );
    const opts = {
      ...options,
      snapshot,
      maxRetries: 2,
      deliveryRetryBaseMs: 100,
    };
    const alerts = () =>
      f.state().events.filter((e) => e.type === "bell_delivery_failed");
    let dispatcher = new Dispatcher(opts);
    await dispatcher.tick();
    if (outcome !== "permanent") {
      expect(alerts()).toHaveLength(0);
      expect(ownNotes().map((n) => n.status)).toContain("pending");
      expect(
        f.state().runs.filter((r) => r.assignment_id === target.assignment.id),
      ).toHaveLength(0);
      // A new dispatcher still respects the stored deadline.
      dispatcher = new Dispatcher(opts);
      f.advance(99);
      await dispatcher.tick();
      expect(snapshot).toHaveBeenCalledTimes(1);
      f.advance(1);
      await dispatcher.tick();
      if (outcome === "recover") {
        expect(alerts()).toHaveLength(0);
        expect(options.startRun).toHaveBeenCalledTimes(1);
        expect(ownNotes().map((n) => n.status)).toContain("belled");
        expect(
          f.state().assignments.find((a) => a.id === target.assignment.id)
            ?.snapshot_retry,
        ).toBeUndefined();
        return;
      }
      f.advance(199);
      await dispatcher.tick();
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(alerts()).toHaveLength(0);
      f.advance(1);
      await dispatcher.tick();
    }
    f.advance(500);
    await dispatcher.tick();
    expect(snapshot).toHaveBeenCalledTimes(outcome === "permanent" ? 1 : 3);
    expect(options.startRun).not.toHaveBeenCalled();
    expect(alerts()).toMatchObject([
      {
        payload: {
          assignment_id: target.assignment.id,
          reason: "snapshot_unavailable",
        },
      },
    ]);
    expect(ownNotes().map((n) => n.status)).toContain("delivery_failed");
  },
);

function saveLimit(limit: number) {
  f.store.uow.run((tx) => {
    const effect = unwrap(
      setRunLimit(
        { kind: "human" },
        { machine_id: "local", limit },
        {
          machines: [{ id: "local" }],
          previous: 4,
          member_id: "M-1",
          clock: f.clock,
          ids: tx.global_ids,
        },
      ),
    );
    persistRunLimitEffect(f.store.database, tx, effect);
  });
}

test("C-145 persisted limits affect the next tick without restart or cancelling running work", async () => {
  const busy = f.create();
  f.session(busy.assignment, false);
  const dispatcher = new Dispatcher({ ...options, runLimit: () => 4 });
  saveLimit(1);
  const before = f.state().runs.filter((run) => run.status === "running");
  comment();
  await dispatcher.tick();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(readRunQueue(f.store)).toHaveLength(1);
  const queued = readRunQueue(f.store)[0]?.run_id;
  saveLimit(2);
  await dispatcher.tick();
  expect(runtime.wake).toHaveBeenCalledOnce();
  expect(f.state().runs.find((run) => run.id === queued)?.status).toBe(
    "dispatched",
  );
  saveLimit(1);
  await dispatcher.tick();
  for (const run of before)
    expect(f.state().runs.find((entry) => entry.id === run.id)).toEqual(run);
  expect(f.state().runs.find((run) => run.id === queued)?.status).toBe(
    "dispatched",
  );
  expect(runtime.release).not.toHaveBeenCalled();
});

test("§3.1 live session: merges one Assignment's events, preserves its snapshot and never duplicates a Run", async () => {
  comment("one");
  comment("two");
  const dispatcher = new Dispatcher(options);
  await dispatcher.tick();
  await new Dispatcher(options).tick();
  expect(runtime.wake).toHaveBeenCalledOnce();
  expect(options.snapshot).not.toHaveBeenCalled();
  expect(vi.mocked(runtime.wake).mock.calls[0]?.[1]).toContain(
    'summary="2 comments"',
  );
  const wakeOptions = vi.mocked(runtime.wake).mock.calls[0]?.[2];
  expect(wakeOptions).toEqual({ before_send: expect.any(Function) });
  expect(wakeOptions?.if_idle).toBeUndefined(); // OSC working is not a business busy flag.
  expect(f.state().runs).toHaveLength(2);
  expect(f.state().runs.at(-1)).toMatchObject({
    status: "dispatched",
    kind: "followup",
    model: "session-model",
    agent_cli_version: "session-cli",
  });
  expect(
    ownNotes().every((n) => n.status === "belled" && n.attempts === 1),
  ).toBe(true);
});
test.each(["idle", "done", "working", "blocked", "unknown", "error"] as const)(
  "C-475: inbox delivery to a %s harness without finish_run",
  async (agent) => {
    const run = f.session(target.assignment, false);
    comment();
    vi.mocked(runtime.status).mockResolvedValue({
      ok: true,
      value: { process: "alive", agent, observed_seq: 1 },
    });
    const beforeWake = vi.fn(async () => undefined);
    for (let i = 0; i < 2; i++)
      await new Dispatcher({ ...options, beforeWake }).tick();
    if (["idle", "done"].includes(agent)) {
      expect(runtime.wake).toHaveBeenCalledOnce();
      expect(vi.mocked(runtime.wake).mock.calls[0]).toMatchObject([
        expect.anything(),
        expect.stringContaining(`run=${run.id}`),
        agent === "done"
          ? { observed_guard: { state: "done" } }
          : { if_idle: true },
      ]);
      expect(ownNotes()[0]).toMatchObject({
        status: "belled",
        run_id: run.id,
        attempts: 1,
      });
    } else {
      expect(runtime.wake).not.toHaveBeenCalled();
      expect(ownNotes()[0]?.status).toBe("pending");
    }
    expect(beforeWake).not.toHaveBeenCalled(); // Never sync a live worktree to deliver a notification.
    expect(options.startRun).not.toHaveBeenCalled();
    expect(f.state().runs).toHaveLength(2);
    expect(f.state().runs.at(-1)).toMatchObject({
      id: run.id,
      status: "running",
    });
  },
);

test.each(["codex", "claude-code"] as const)(
  "C-475: a no-OSC %s Run that never finishes hands its unread note to a followup only after confirmed exit",
  async (harness) => {
    const run = f.session(target.assignment, false);
    f.store.uow.run((tx) => {
      const current = tx.runs.get(f.project, run.id);
      if (!current) throw new Error("missing Run");
      tx.runs.put(f.project, { ...current, harness });
    });
    f.advance(1);
    const sample = {
      run_id: run.id,
      assignment_id: target.assignment.id,
      runtime_key: JSON.stringify(f.refFor(target.assignment)),
      session_id: "fixture-session",
      source: `${harness}:session_metadata`,
      updated_at: f.clock.now(),
      stale_after_ms: 60_000,
      turn_ended: true as const,
    };
    let exited = false;
    vi.mocked(runtime.status).mockImplementation(async () => ({
      ok: true,
      value: {
        process: exited ? "exited" : "alive",
        agent: "unknown",
        observed_seq: 1,
      },
    }));
    const settings = {
      ...options,
      harnessActivity: () => sample,
      inspectHarnessActivity: async () =>
        new Map([
          [
            target.assignment.id,
            { status: "stale" as const, activity: sample },
          ],
        ]),
      inactivityGraceMs: 50,
      inactiveCancelAfterMs: 100,
    };
    comment();
    const dispatcher = new Dispatcher(settings);
    await dispatcher.tick();
    const original = ownNotes().find((n) => n.kind === "comment");
    if (!original) throw new Error("Missing original comment");
    const row = () => ownNotes().find((n) => n.id === original.id);
    expect(row()).toMatchObject({ status: "pending", attempts: 0 });
    expect(listBellAttempts(f.store.database, f.project, run.id)).toEqual([]);
    expect(runtime.wake).not.toHaveBeenCalled();
    expect(runtime.release).not.toHaveBeenCalled();
    f.advance(101);
    const restarted = new Dispatcher(settings);
    await restarted.tick();
    await restarted.tick();
    // Even a successful release call is not proof that the old terminal exited.
    expect(runtime.release).toHaveBeenCalled();
    expect(options.startRun).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "pending", attempts: 0 });
    expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("running");
    exited = true;
    f.advance(120_000);
    await restarted.tick();
    await restarted.tick();
    expect(f.state().runs.find((r) => r.id === run.id)).toMatchObject({
      status: "cancelled",
      outcome: "failed",
    });
    expect(options.startRun).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({
      status: "belled",
      attempts: 1,
      run_id: vi.mocked(options.startRun).mock.calls[0]?.[0].run.id,
    });
    expect(row()?.run_id).not.toBe(run.id);
    expect(runtime.wake).not.toHaveBeenCalled();
  },
);

test.each(["runtime_queue_timeout", "runtime_timeout"] as const)(
  "C-475: %s retains unread work and distinguishes proven non-delivery",
  async (code) => {
    const run = f.session(target.assignment, false);
    comment();
    vi.mocked(runtime.status).mockResolvedValue({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    });
    vi.mocked(runtime.wake).mockResolvedValueOnce({
      ok: false,
      error: { code, message: "timed out" },
    });
    const dispatcher = new Dispatcher({ ...options, retryBaseMs: 100 });
    await dispatcher.tick();
    expect(ownNotes()[0]).toMatchObject({
      status: "delivery_failed",
      attempts: 1,
    });
    expect(
      listBellAttempts(f.store.database, f.project, run.id).map(
        (a) => a.outcome,
      ),
    ).toEqual(code === "runtime_queue_timeout" ? [] : ["failed"]);
    f.advance(101);
    await dispatcher.tick();
    expect(ownNotes()[0]).toMatchObject({
      status: "belled",
      attempts: 2,
      run_id: run.id,
    });
  },
);

test.each([false, true])(
  "C-475: retry unread notifications even if the original Run ends (finished=%s)",
  async (finished) => {
    const run = f.session(target.assignment, false);
    comment();
    vi.mocked(runtime.status).mockResolvedValue({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    });
    vi.mocked(runtime.wake).mockResolvedValueOnce({
      ok: false,
      error: { code: "runtime_conflict", message: "busy" },
    });
    const opts = { ...options, retryBaseMs: 100 };
    await new Dispatcher(opts).tick();
    const note = ownNotes()[0];
    expect(note).toMatchObject({ status: "delivery_failed", attempts: 1 });
    expect(note?.run_id).toBeUndefined();
    if (finished)
      f.apply(
        (s, a, p) =>
          finishRun(
            s,
            a,
            {
              run_id: run.id,
              outcome: "completed",
              summary: "previous turn finished",
            },
            p,
          ),
        f.actorFor(target.assignment),
      );
    await new Dispatcher(opts).tick();
    expect(runtime.wake).toHaveBeenCalledOnce();
    f.advance(101);
    await new Dispatcher(opts).tick();
    expect(ownNotes()[0]).toMatchObject({
      id: note?.id,
      status: "belled",
      attempts: 2,
    });
    const delivered = ownNotes()[0]?.run_id;
    expect(delivered).toBeDefined();
    if (finished) expect(delivered).not.toBe(run.id);
    else expect(delivered).toBe(run.id);
  },
);

test.each([false, true])(
  "C-475: lease recovery after the original Run finishes preserves unread work and honors ACK (acked=%s)",
  async (acked) => {
    const run = f.session(target.assignment, false);
    comment();
    routeProjectEvents(f.store, f.project, { clock: f.clock });
    const note = ownNotes().find((n) => n.kind === "comment");
    if (!note?.card_id) throw new Error("Missing comment");
    // Crash boundary: the intent committed, but its wake and settlement did not.
    f.store.uow.run(() =>
      beginBellAttempt(f.store.database, {
        project_id: f.project,
        id: "interrupted",
        assignment_id: target.assignment.id,
        run_id: run.id,
        notification_ids: [note.id],
        started_at: f.clock.now(),
        lease_until: new Date(Date.parse(f.clock.now()) + 1000).toISOString(),
      }),
    );
    if (acked)
      f.store.ackEvents({
        project_id: f.project,
        assignment_id: target.assignment.id,
        card_id: note.card_id,
        up_to_seq: note.seq,
      });
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          {
            run_id: run.id,
            outcome: "completed",
            summary: "Original turn finished",
          },
          p,
        ),
      f.actorFor(target.assignment),
    );
    const reopened = Store.open({ dataDir: f.dataDir, clock: f.clock });
    try {
      const restarted = new Dispatcher({
        ...options,
        store: reopened,
        retryBaseMs: 100,
      });
      const row = () =>
        reopened.listNotifications({
          project_id: f.project,
          ids: [note.id],
        })[0];
      f.advance(1001);
      await restarted.tick();
      if (acked) expect(row()?.status).toBe("acked");
      else {
        expect(row()).toMatchObject({ status: "delivery_failed", attempts: 1 });
        expect(row()?.run_id).toBeUndefined();
      }
      f.advance(101);
      await restarted.tick();
      if (acked) expect(row()?.status).toBe("acked");
      else {
        expect(row()).toMatchObject({ status: "belled", attempts: 2 });
        expect(row()?.run_id).toBeDefined();
        expect(row()?.run_id).not.toBe(run.id);
      }
    } finally {
      reopened.close();
    }
  },
);

test("C-475: a failed project-stream bell on a running standing session retries after backoff", async () => {
  const owner = standingSession("host_ops");
  const run = f.session(owner, false);
  const event = f.state().events.findLast((e) => !e.card_id);
  if (!event) throw new Error("missing project event");
  const { notification } = f.store.recordNotification({
    project_id: f.project,
    event_id: event.id,
    seq: event.seq,
    recipient: { kind: "assignment", assignment_id: owner.id },
    kind: "human_action",
  });
  const row = () =>
    f.store.listNotifications({
      project_id: f.project,
      ids: [notification.id],
    })[0];
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  });
  vi.mocked(runtime.wake).mockImplementation(async (ref) => {
    if (
      ref.terminal_ref === f.refFor(owner).terminal_ref &&
      row()?.attempts === 0
    )
      return {
        ok: false,
        error: { code: "runtime_conflict", message: "temporarily busy" },
      };
    return { ok: true, value: { sent: true } };
  });
  const opts = { ...options, retryBaseMs: 100 };
  await new Dispatcher(opts).tick();
  expect(row()).toMatchObject({ status: "delivery_failed", attempts: 1 });
  f.advance(101);
  await new Dispatcher(opts).tick();
  expect(row()).toMatchObject({
    status: "belled",
    attempts: 2,
    run_id: run.id,
  });
});

test("C-475: withdraw if the running turn finishes while the wake is queued", async () => {
  const run = f.session(target.assignment, false);
  comment();
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  });
  vi.mocked(runtime.wake).mockImplementation(async (_ref, _bell, guard) => {
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: run.id, outcome: "completed", summary: "done" },
          p,
        ),
      f.actorFor(target.assignment),
    );
    expect(guard?.before_send?.()).toBe(false);
    return { ok: true, value: { sent: false, withdrawn: true } };
  });
  await new Dispatcher(options).tick();
  expect(ownNotes()[0]).toMatchObject({ status: "pending", attempts: 0 });
  expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
});

test.each([false, true])(
  "C-475: a persistently unknown inbox with recovery disabled alerts Ops at the deadline (end record=%s)",
  async (ended) => {
    const run = f.session(target.assignment, false);
    const sample = {
      run_id: run.id,
      assignment_id: target.assignment.id,
      runtime_key: JSON.stringify(f.refFor(target.assignment)),
      session_id: "fixture-session",
      updated_at: f.clock.now(),
      stale_after_ms: 60_000,
      source: "codex:session_metadata",
      turn_ended: true as const,
    };
    vi.mocked(runtime.status).mockResolvedValue({
      ok: true,
      value: { process: "alive", agent: "unknown", observed_seq: 1 },
    });
    const opts = {
      ...options,
      inactiveCancelAfterMs: null,
      harnessActivity: () => (ended ? sample : undefined),
    };
    const alerts = () =>
      f.state().events.filter((e) => e.type === "run_inbox_stalled");
    f.advance(2 * 60 * 60_000 - 1);
    await new Dispatcher(opts).tick();
    expect(alerts()).toEqual([]);
    comment();
    await new Dispatcher(opts).tick();
    expect(alerts()).toEqual([]);
    f.advance(1);
    await new Dispatcher(opts).tick();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({
      card_id: target.card.id,
      payload: {
        assignment_id: target.assignment.id,
        run_id: run.id,
        notification_ids: [ownNotes().find((n) => n.status === "pending")?.id],
      },
    });
    expect(
      f.store
        .listNotifications({ project_id: f.project })
        .filter((n) => n.event_id === alerts()[0]?.id),
    ).toMatchObject([{ recipient: { kind: "pm_ops" } }]);
    await new Dispatcher(opts).tick();
    expect(alerts()).toHaveLength(1);
    expect(
      (alerts()[0]?.payload as { reason: string } | undefined)?.reason.includes(
        "会话记录",
      ),
    ).toBe(ended);
    const note = ownNotes().find((n) => n.kind === "comment");
    expect(note).toMatchObject({ status: "pending", attempts: 0 });
    expect(runtime.wake).not.toHaveBeenCalled();
    expect(runtime.release).not.toHaveBeenCalled();
    // A later positively guarded wake on the original Run can claim the same row.
    vi.mocked(runtime.status).mockResolvedValue({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 2 },
    });
    await new Dispatcher(opts).tick();
    expect(ownNotes().find((n) => n.id === note?.id)).toMatchObject({
      status: "belled",
      attempts: 1,
      run_id: run.id,
    });
    expect(vi.mocked(runtime.wake).mock.calls[0]?.[2]).toMatchObject({
      if_idle: true,
    });
  },
);
test.each(
  (["decision_resumed", "rework", "fix"] as const).flatMap((kind) =>
    [true, false].map((live) => ({ kind, live })),
  ),
)(
  "prequeued $kind starts (live=$live) even when its cause is not in the inbox",
  async ({ kind, live }) => {
    const run = f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: target.assignment.id,
          kind,
          model: "session-model",
          agent_cli_version: "session-cli",
        },
        p,
      ),
    );
    comment("Continue the already queued work");
    // The queue event is not a routed bell. Test both existing-session and
    // host-start paths without allowing either path to manufacture a new Run.
    vi.mocked(runtime.status).mockResolvedValue({
      ok: true,
      value: {
        process: live ? "alive" : "exited",
        agent: "idle",
        observed_seq: 2,
      },
    });
    await new Dispatcher(options).tick();
    expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
      "dispatched",
    );
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
      f.actorFor(target.assignment),
    );
    await new Dispatcher(options).tick();
    expect(f.state().runs).toHaveLength(2);
    expect(f.state().runs.at(-1)).toMatchObject({ ...run, status: "running" });
    expect(ownNotes()[0]).toMatchObject({
      run_id: run.id,
      status: "belled",
      attempts: 1,
    });
    expect(ownNotes()[0]?.event_id).not.toBe(run.trigger_event_id);
    expect(live ? runtime.wake : options.startRun).toHaveBeenCalledOnce();
  },
);
test("§3.1 exited terminal starts exactly the queued Run with the merged bell as its first prompt", async () => {
  comment();
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "exited", agent: "unknown", observed_seq: 2 },
  });
  await new Dispatcher(options).tick();
  expect(options.startRun).toHaveBeenCalledOnce();
  expect(runtime.wake).not.toHaveBeenCalled();
  const input = vi.mocked(options.startRun).mock.calls[0]?.[0];
  expect(input?.run).toMatchObject({
    status: "queued",
    model: "new-model",
    agent_cli_version: "new-cli",
  });
  expect(input?.bell).toContain("[bell]");
  expect(f.state().runs.at(-1)?.id).toBe(input?.run.id);
  expect(f.state().runs).toHaveLength(2);
  expect(ownNotes()[0]?.status).toBe("belled");
});
test("§3.1 released Assignment is not started or woken and the failure reaches Ops", async () => {
  comment();
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...target.assignment, status: "released" }),
  );
  // Persisted inbox rows may outlive their receiver.
  const event = f
    .state()
    .events.filter((e) => e.type === "comment_posted")
    .at(-1);
  if (!event) throw new Error("No source event");
  f.store.recordNotification({
    project_id: f.project,
    event_id: event.id,
    card_id: event.card_id,
    seq: event.seq,
    kind: "comment",
    recipient: { kind: "assignment", assignment_id: target.assignment.id },
  });
  await new Dispatcher(options).tick();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(options.startRun).not.toHaveBeenCalled();
  expect(ownNotes()[0]?.status).toBe("delivery_failed");
  expect(
    f.store.listNotifications({
      project_id: f.project,
      recipient_kind: "pm_ops",
    }).length,
  ).toBeGreaterThan(0);
});
test("C-211 a stopped Assignment gets no new session from queued Runs or later bells until the human starts it", async () => {
  // A follow-up Run was already queued when the human stopped the Assignment.
  const trigger = f.state().events.at(-1)?.id;
  const queued = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: target.assignment.id,
        model: "m",
        agent_cli_version: "c",
        kind: "followup",
        trigger_event_id: trigger as never,
      },
      p,
    ),
  );
  const stopped = f.apply((s, a, p) =>
    stopWorkItemAssignment(
      s,
      a,
      { assignment_id: target.assignment.id, reason: "stopped by host" },
      p,
    ),
  );
  expect(stopped.cancelled).toBe(1);
  expect(f.state().runs.find((r) => r.id === queued.id)?.status).toBe(
    "cancelled",
  );
  comment();
  for (const process of ["alive", "exited"] as const) {
    vi.mocked(runtime.status).mockResolvedValue({
      ok: true,
      value: { process, agent: "unknown", observed_seq: 2 },
    });
    await new Dispatcher(options).tick();
  }
  expect(options.startRun).not.toHaveBeenCalled();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(
    f
      .state()
      .runs.filter(
        (r) =>
          r.assignment_id === target.assignment.id &&
          !["completed", "failed", "cancelled"].includes(r.status),
      ),
  ).toEqual([]);
  // The bell is kept for the session the human starts later.
  expect(ownNotes().map((n) => n.status)).toEqual(["pending"]);

  // `cardigan assignment start` dispatches a Run; the stop no longer holds.
  f.session(
    f
      .state()
      .assignments.find((a) => a.id === target.assignment.id) as Assignment,
  );
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 3 },
  });
  await new Dispatcher(options).tick();
  expect(runtime.wake).toHaveBeenCalled();
});
test("C-56 wake failure retries the same Run after backoff without immediate escalation", async () => {
  comment();
  vi.mocked(runtime.wake).mockResolvedValue({
    ok: false,
    error: { code: "runtime_timeout", message: "unknown delivery" },
  });
  const dispatcher = new Dispatcher(options);
  await dispatcher.tick();
  f.advance(120000);
  await dispatcher.tick();
  expect(runtime.wake).toHaveBeenCalledTimes(2);
  expect(f.state().runs).toHaveLength(2);
  expect(ownNotes()[0]).toMatchObject({
    status: "delivery_failed",
    attempts: 2,
  });
  expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
  expect(
    f.store.listNotifications({
      project_id: f.project,
      recipient_kind: "pm_ops",
    }),
  ).toHaveLength(0);
});
test("an ACK during wake wins over its late failure response", async () => {
  comment();
  vi.mocked(runtime.wake).mockImplementation(async () => {
    const note = ownNotes()[0];
    if (!note?.card_id) throw new Error("Missing notice");
    f.store.ackEvents({
      project_id: f.project,
      assignment_id: target.assignment.id,
      card_id: note.card_id,
      up_to_seq: note.seq,
    });
    return { ok: false, error: { code: "runtime_timeout", message: "late" } };
  });
  await new Dispatcher(options).tick();
  expect(ownNotes()[0]?.status).toBe("acked");
  expect(
    f.store.listNotifications({
      project_id: f.project,
      recipient_kind: "pm_ops",
    }),
  ).toEqual([]);
});

test("reopened store cannot take over an expired attempt while its wake still holds the launch lock", async () => {
  comment();
  let finish = () => {};
  const response = new Promise<Awaited<ReturnType<Runtime["wake"]>>>(
    (resolve) => {
      finish = () => resolve({ ok: true, value: { sent: true } });
    },
  );
  vi.mocked(runtime.wake).mockImplementationOnce(() => response);
  const sending = new Dispatcher(options).tick();
  void sending.catch(() => {});
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    // A second Store is a competing connection, not the death of the original
    // executor. Wait for wake itself so the execution mutex is already held.
    await expect.poll(() => vi.mocked(runtime.wake).mock.calls.length).toBe(1);
    await expect
      .poll(() => unfinishedBellAttempts(reopened.database, f.project).length)
      .toBe(1);
    const intended = unfinishedBellAttempts(reopened.database, f.project)[0];
    if (!intended) throw new Error("Missing in-flight attempt");
    const runs = f.state().runs;
    expect(runs).toHaveLength(2);
    expect(
      await tryHostOpsLock(reopened, f.project, target.assignment.id, "launch"),
    ).toBeUndefined();
    const restarted = new Dispatcher({ ...options, store: reopened });
    await restarted.tick();
    expect(ownNotes()[0]?.status).toBe("pending");
    f.advance(1001);
    await restarted.tick();
    expect(ownNotes()[0]?.status).toBe("pending");
    expect(unfinishedBellAttempts(reopened.database, f.project)).toEqual([
      intended,
    ]);
    expect(runtime.wake).toHaveBeenCalledOnce();
    expect(options.startRun).not.toHaveBeenCalled();
    expect(runtime.release).not.toHaveBeenCalled();
    expect(f.state().runs).toEqual(runs);
    finish();
    await sending;
    // The owner still existed: its successful result settles this same intent.
    expect(ownNotes()[0]?.status).toBe("belled");
    expect(listBellAttempts(reopened.database, f.project)).toContainEqual({
      ...intended,
      outcome: "sent",
      finished_at: f.clock.now(),
    });
    expect(unfinishedBellAttempts(reopened.database, f.project)).toEqual([]);
    const unlock = await tryHostOpsLock(
      reopened,
      f.project,
      target.assignment.id,
      "launch",
    );
    expect(unlock).toBeDefined();
    await unlock?.();
    await restarted.tick();
    expect(runtime.wake).toHaveBeenCalledOnce();
    expect(f.state().runs).toEqual(runs);
  } finally {
    finish();
    try {
      await sending;
    } finally {
      reopened.close();
    }
  }
});

test.each(["merge_conflicted", "merge_changes_requested"])(
  "§6.4 %s queues a kind=fix Run with its context for the producer",
  async (type) => {
    // Same event shape recordMergeResult emits; routing is what is under test.
    f.store.uow.run((tx) => {
      const seq = tx.ids.nextEventSequence(f.project, target.card.id);
      tx.events.append(f.project, {
        id: tx.ids.nextEventId(),
        card_id: target.card.id,
        seq,
        type,
        actor: { kind: "system", project_id: f.project },
        payload: {
          work_item_id: target.item.id,
          run_kind: "fix",
          reason: "Add missing validation",
        },
        created_at: f.clock.now(),
      });
    });
    await new Dispatcher(options).tick();
    expect(f.state().runs.at(-1)).toMatchObject({
      assignment_id: target.assignment.id,
      kind: "fix",
    });
    expect(
      f
        .state()
        .events.find((e) => e.id === f.state().runs.at(-1)?.trigger_event_id),
    ).toMatchObject({
      type,
      payload: { reason: "Add missing validation" },
    });
  },
);

// P2a-9: real SQLite + fake runtime; never create CPU load for scheduling tests.
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

function secondProject() {
  const project = "second-project" as ProjectId;
  f.store.createProject({ id: project, name: "Second" });
  f.store.uow.run((tx) => {
    for (const role of tx.roles.list(f.project)) tx.roles.put(project, role);
  });
  const apply = <T>(
    command: (s: CommandState, p: CommandPorts) => Result<CommandEffect<T>>,
  ) =>
    f.store.uow.run((tx) => {
      const effect = unwrap(
        command(loadCommandState(tx, project), { ids: tx.ids, clock: f.clock }),
      );
      persistEffect(tx, project, effect);
      return effect.data;
    });
  const actor = { kind: "human" as const, project_id: project };
  const card = apply((s, p) =>
    createCard(
      s,
      actor,
      {
        title: "Other project",
        goal: "Global FIFO",
        acceptance_criteria: ["ordered"],
        source: { kind: "quote", text: "fixture" },
        repo: "fixture/repo",
        base_branch: "main",
      },
      p,
    ),
  );
  const item = f.store.uow.read((tx) =>
    tx.work_items
      .list(project)
      .find((w) => w.card_id === card.id && w.kind === "produce"),
  );
  if (!item) throw new Error("Missing item");
  const owner = apply((s, p) =>
    assign(s, actor, { work_item_id: item.id, role_id: "coder" }, p),
  );
  const comment = () =>
    apply((s, p) =>
      postComment(
        s,
        actor,
        { card_id: card.id, work_item_id: item.id, body: "earlier" },
        p,
      ),
    );
  return { project, card, item, owner, apply, comment };
}

/** Legacy queueResumedRun persisted only the business trigger, not an event naming the Run. */
function legacyQueued() {
  const trigger = f
    .state()
    .events.find(
      (e) => e.card_id === target.card.id && e.type === "work_item_assigned",
    );
  if (!trigger) throw new Error("Missing fixture trigger");
  return f.store.uow.run((tx) => {
    const run: Run = {
      id: tx.ids.next(f.project, "run"),
      assignment_id: target.assignment.id,
      trigger_event_id: trigger.id,
      status: "queued",
      kind: "followup",
      role_version: target.assignment.role_version,
      model: "session-model",
      agent_cli_version: "session-cli",
      outcome: null,
      summary: "",
    };
    tx.runs.put(f.project, run);
    return run;
  });
}
const pmQueueNotices = (run: Run) => {
  const events = new Set(
    f
      .state()
      .events.filter(
        (e) =>
          ["queued_run_rechecked", "queued_run_spare_capacity"].includes(
            e.type,
          ) && (e.payload as { run_id?: unknown }).run_id === run.id,
      )
      .map((e) => e.id),
  );
  return f.store
    .listNotifications({ project_id: f.project })
    .filter((n) => n.recipient.kind === "pm_ops" && events.has(n.event_id));
};

test("C-527: a warm idle dispatcher recovers the same unmarked Run at five minutes without a new bell", async () => {
  const run = legacyQueued();
  const dispatcher = new Dispatcher(options);
  await dispatcher.tick();
  f.advance(300_000 - 1);
  await dispatcher.tick();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(pmQueueNotices(run)).toHaveLength(0);
  f.advance(1);
  await dispatcher.tick();
  expect(ownNotes()).toEqual([]);
  expect(f.state().runs.find((r) => r.id === run.id)).toMatchObject({
    status: "dispatched",
    trigger_event_id: run.trigger_event_id,
  });
  const event = f.state().events.find((e) => e.type === "queued_run_rechecked");
  expect(event?.payload).toMatchObject({
    run_id: run.id,
    queue_reason: null,
    notified_pm_ops: true,
  });
  expect(pmQueueNotices(run).map((n) => n.event_id)).toEqual([event?.id]);
  expect(runtime.wake).toHaveBeenCalledOnce();
});

test("C-527: full capacity defers the orphan; spare capacity alerts once even across restart and further runtime waits", async () => {
  const busy = f.create();
  f.session(busy.assignment, false);
  const run = legacyQueued();
  const opts = { ...options, queuedRecheckAfterMs: 60_000, runLimit: () => 1 };
  let dispatcher = new Dispatcher(opts);
  f.advance(60_000);
  await dispatcher.tick();
  const current = () => f.state().runs.find((r) => r.id === run.id);
  expect(current()?.queue_reason).toBe("concurrency_limit");
  expect(pmQueueNotices(run)).toHaveLength(0);
  finish(busy.assignment);
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "unknown", agent: "idle", observed_seq: 1 },
  });
  await dispatcher.tick();
  expect(current()?.queue_reason).toBe("runtime_unavailable");
  expect(pmQueueNotices(run)).toHaveLength(1);
  f.advance(60_000);
  dispatcher = new Dispatcher(opts);
  await dispatcher.tick();
  expect(pmQueueNotices(run)).toHaveLength(1);
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 2 },
  });
  await dispatcher.tick();
  expect(current()?.status).toBe("dispatched");
  expect(runtime.wake).toHaveBeenCalledOnce();
});

test("C-527: the patrol does not compete with a reserved startup", async () => {
  const run = legacyQueued();
  f.store.uow.run(() =>
    beginLaunchAttempt(f.store.database, {
      id: "reservation",
      project_id: f.project,
      run_id: run.id,
      assignment_id: run.assignment_id,
      started_at: f.clock.now(),
      lease_until: new Date(Date.parse(f.clock.now()) + 3600_000).toISOString(),
    }),
  );
  f.advance(300_000);
  await new Dispatcher(options).tick();
  expect(f.state().runs.find((r) => r.id === run.id)).toEqual(run);
  expect(pmQueueNotices(run)).toHaveLength(0);
  expect(runtime.wake).not.toHaveBeenCalled();
});

test("capacity preserves queued Run identity and notifications, then dispatches after a slot frees", async () => {
  const busy = f.create();
  f.session(busy.assignment, false);
  comment();
  const dispatcher = new Dispatcher({ ...options, runLimit: () => 1 });
  await dispatcher.tick();
  const queued = f.state().runs.find((r) => r.status === "queued");
  expect(queued).toMatchObject({
    assignment_id: target.assignment.id,
    queue_reason: "concurrency_limit",
  });
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(options.startRun).not.toHaveBeenCalled();
  expect(ownNotes()[0]).toMatchObject({ status: "pending", attempts: 0 });
  expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
  await dispatcher.tick();
  expect(f.state().runs.filter((r) => r.status === "queued")).toEqual([queued]);
  finish(busy.assignment);
  await dispatcher.tick();
  expect(f.state().runs.find((r) => r.id === queued?.id)).toMatchObject({
    status: "dispatched",
  });
  expect(readRunQueue(f.store)).toEqual([]);
  expect(runtime.wake).toHaveBeenCalledOnce();
});

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

test("MC-4 a missing slot holds the entire Run without reserving an unrelated free resource", async () => {
  const busy = f.create();
  requireCapabilities(busy.item, ["godot=4"]);
  const legacy = f.session(busy.assignment, false);
  expect(legacy.resource_keys).toBeUndefined();
  const independent = f.create();
  f.session(independent.assignment);
  requireCapabilities(target.item, ["godot>=4", "blender"]);
  requireCapabilities(independent.item, ["blender"]);
  const settings = {
    ...options,
    runLimit: () => 3,
    resourceLimits: () =>
      new Map([
        ["godot", 1],
        ["blender", 1],
      ]),
  };
  comment();
  await new Dispatcher(settings).tick();
  const [waiting] = readRunQueue(f.store);
  expect(waiting).toMatchObject({
    assignment_id: target.assignment.id,
    machine_id: "local",
  });
  // MC-4 upgrade: neither clearing the old item's requirements nor replacing
  // them grants a second godot slot or charges blender to the still-running Run.
  requireCapabilities(busy.item, []);
  requireCapabilities(busy.item, ["blender"]);
  await new Dispatcher(settings).tick();
  expect(f.state().runs.find((r) => r.id === legacy.id)?.status).toBe(
    "running",
  );
  expect(readRunQueue(f.store)).toEqual([waiting]);
  f.advance(100);
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      {
        card_id: independent.card.id,
        work_item_id: independent.item.id,
        body: "independent",
      },
      p,
    ),
  );
  await new Dispatcher(settings).tick();
  expect(readRunQueue(f.store)).toEqual([waiting]);
  expect(runtime.wake).toHaveBeenCalledOnce();
  const admitted = f
    .state()
    .runs.find(
      (r) =>
        r.status === "dispatched" &&
        r.assignment_id === independent.assignment.id,
    );
  expect(admitted?.resource_keys).toEqual(["blender"]);
  finish(busy.assignment);
  await new Dispatcher(settings).tick();
  expect(readRunQueue(f.store)).toEqual([waiting]); // still needs blender too
  if (!admitted) throw new Error("Missing admission");
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: admitted.id }, p),
    f.actorFor(independent.assignment),
  );
  finish(independent.assignment);
  await new Dispatcher(settings).tick();
  expect(f.state().runs.find((r) => r.id === waiting?.run_id)).toMatchObject({
    status: "dispatched",
    resource_keys: ["godot", "blender"],
    assignment_id: target.assignment.id,
  });
});

test("MC-4 a withdrawn legacy Run holds its retry's resources before and after redispatch", async () => {
  const owner = f.create();
  requireCapabilities(owner.item, ["godot"]);
  requireCapabilities(target.item, ["blender"]);
  const resourceLimits = () =>
    new Map([
      ["godot", 1],
      ["blender", 1],
      ["ios.simulator", 1],
    ]);
  const occupied = (key: string) =>
    f.store.uow.read(
      (tx) =>
        runCapacitySnapshot(f.store, tx, resourceLimits)
          .resourcesForMachine("local")
          .get(key)?.occupied,
    );
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: owner.assignment.id,
        model: "fixture",
        agent_cli_version: "1",
      },
      p,
    ),
  );
  const system = { kind: "system", project_id: f.project } as const;
  const binding = {
    project_id: f.project,
    machine_id: "local",
    session: "fixture",
    generation: "one",
    fingerprint: "c".repeat(64),
  };
  let expected: string | undefined;
  function attempt(generation: string) {
    const ref = {
      ...f.refFor(owner.assignment),
      target: binding,
      launch_generation: { run_id: run.id, generation },
    };
    const record = (phase: NonNullable<Run["launch_publication"]>["phase"]) => {
      f.apply(
        (s, a, p) =>
          recordLaunchPublication(
            s,
            a,
            {
              run_id: run.id,
              ...(expected ? { expected_generation: expected } : {}),
              publication: {
                phase,
                generation,
                target: binding,
                lease_until: "2030-01-01T00:00:00Z",
                agent_name: "fixture",
                work_dir: "fixture",
                sha: null,
                token_id: null,
                runtime_ref: [
                  "preparing",
                  "published",
                  "provisioning",
                ].includes(phase)
                  ? null
                  : ref,
                process: null,
                log_offset: 0,
                artifacts: [],
                wait: phase === "stopping" || phase === "exited",
                provision_attempted:
                  phase !== "preparing" && phase !== "published",
              },
            },
            p,
          ),
        system,
      );
      expected = generation;
    };
    record("preparing");
    return {
      record,
      dispatch() {
        for (const phase of [
          "published",
          "provisioning",
          "provisioned",
        ] as const)
          record(phase);
        f.apply(
          (s, a, p) =>
            dispatchRun(s, a, { run_id: run.id, runtime_ref: ref }, p),
          system,
        );
        record("dispatched");
      },
    };
  }
  const first = attempt("a".repeat(32));
  first.dispatch();
  first.record("stopping");
  first.record("exited");
  expect(occupied("godot")).toBe(0);

  requireCapabilities(owner.item, ["blender"]);
  const retry = attempt("b".repeat(32));
  expect(occupied("blender")).toBe(1); // no second dispatch event yet
  requireCapabilities(owner.item, []); // the claim must survive another edit
  retry.dispatch();
  retry.record("started");
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
    f.actorFor(owner.assignment),
  );
  requireCapabilities(owner.item, ["ios.simulator"]);
  expect(occupied("ios.simulator")).toBe(0); // added only after this dispatch
  expect(occupied("blender")).toBe(1);
  comment();
  const dispatcher = new Dispatcher({
    ...options,
    runLimit: () => 3,
    resourceLimits,
  });
  await dispatcher.tick();
  const [waiting] = readRunQueue(f.store);
  expect(waiting?.assignment_id).toBe(target.assignment.id);
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("running");
  finish(owner.assignment);
  expect(occupied("blender")).toBe(0);
  await dispatcher.tick();
  expect(f.state().runs.find((r) => r.id === waiting?.run_id)).toMatchObject({
    status: "dispatched",
    resource_keys: ["blender"],
  });
});

test("MC-4 stopping a queued follow-up reserves the terminal but not its unclaimed resources", async () => {
  const busy = f.create();
  requireCapabilities(busy.item, ["godot"]);
  f.session(busy.assignment, false);
  requireCapabilities(target.item, ["godot", "blender"]);
  const other = f.create();
  requireCapabilities(other.item, ["blender"]);
  f.session(other.assignment);
  const ops = standingSession("host_ops");
  f.store.uow.run((tx) => {
    const role = tx.roles.get(f.project, ops);
    if (!role) throw new Error("Missing operator role");
    tx.roles.put(f.project, { ...role, allowed_tools: HOST_OPS_ROLE_TOOLS });
  });
  const resourceLimits = () =>
    new Map([
      ["godot", 1],
      ["blender", 1],
    ]);
  const dispatcher = new Dispatcher({
    ...options,
    runLimit: () => 4,
    resourceLimits,
  });
  comment();
  await dispatcher.tick();
  const wait = f
    .state()
    .runs.find(
      (r) => r.status === "queued" && r.assignment_id === target.assignment.id,
    );
  if (!wait) throw new Error("Missing queued Run");
  f.apply(
    (s, a, p) =>
      beginHostOpsAction(
        s,
        a,
        {
          tool: "host_ops_cancel_run",
          target_id: wait.id,
          reason: "Cancel the unstarted follow-up",
        },
        p,
      ),
    f.actorFor(ops),
  );
  const capacity = f.store.uow.read((tx) =>
    runCapacitySnapshot(f.store, tx, resourceLimits),
  );
  expect(capacity.occupied.get("local")).toBe(2); // busy Run + terminal stop reservation
  expect(capacity.resourcesForMachine("local").get("blender")?.occupied).toBe(
    0,
  );
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      {
        card_id: other.card.id,
        work_item_id: other.item.id,
        body: "Blender task",
      },
      p,
    ),
  );
  await dispatcher.tick();
  expect(
    f
      .state()
      .runs.find(
        (r) =>
          r.status === "dispatched" && r.assignment_id === other.assignment.id,
      )?.resource_keys,
  ).toEqual(["blender"]);
});

test("cross-project event FIFO survives full ticks, changed limits, restart, and projects with identical IDs", async () => {
  const other = secondProject();
  // IDs are project-scoped; equal card tiers keep event creation order.
  expect(other.owner.id).toBe(target.assignment.id);
  other.comment();
  f.advance(1000);
  comment();
  const busy = f.create();
  f.session(busy.assignment, false);
  let limit = 1;
  const startRun = vi.fn(
    async ({
      project,
      run,
      assignment,
    }: Parameters<DispatcherOptions["startRun"]>[0]) => {
      f.store.uow.run((tx) =>
        persistEffect(
          tx,
          project,
          unwrap(
            dispatchRun(
              loadCommandState(tx, project),
              { kind: "system", project_id: project },
              { run_id: run.id, runtime_ref: f.refFor(assignment) },
              { ids: tx.ids, clock: f.clock },
            ),
          ),
        ),
      );
    },
  );
  const settings = { ...options, startRun, runLimit: () => limit };
  await new Dispatcher(settings).tick();
  const before = readRunQueue(f.store);
  expect(before.map((r) => [r.project_id, r.ahead])).toEqual([
    [other.project, 0],
    [f.project, 1],
  ]);
  expect(executionCapacity(f.store, () => limit).agents).toEqual([
    {
      machine_id: "local",
      label: "local",
      max_limit: 16,
      running: 1,
      total_running: 1,
      limit: 1,
      queued: 2,
      merge_check_slots: 0,
      resources: [],
    },
  ]);
  const rows = readCardList(f.store, f.project);
  expect(
    rows.find((c) => c.id === target.card.id)?.queued_runs?.[0]?.ahead,
  ).toBe(1);
  const output: string[] = [];
  expect(
    attentionCommand(["--project", f.project], {
      env: { CARDIGAN_DATA_DIR: f.dataDir },
      cwd: f.dataDir,
      platform: "linux",
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      signals: { on() {}, off() {} },
      spawnInherit: () => {
        throw new Error("read-only command");
      },
      captureCommand: async () => {
        throw new Error("read-only command");
      },
    }),
  ).toBe(0);
  expect(output.join("\n")).toContain("排队中（前面还有 1 个）");
  expect(
    executionView(f.state(), f.clock.now(), [], before).runs.find(
      (r) => r.status === "queued",
    )?.queue_ahead,
  ).toBe(1);
  await new Dispatcher(settings).tick();
  expect(readRunQueue(f.store)).toEqual(before);
  limit = 2;
  await new Dispatcher(settings).tick(f.project);
  expect(startRun).toHaveBeenCalledOnce();
  expect(startRun.mock.calls[0]?.[0].project).toBe(other.project);
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(readRunQueue(f.store).map((r) => [r.project_id, r.ahead])).toEqual([
    [f.project, 0],
  ]);
  limit = 3;
  await new Dispatcher(settings).tick();
  expect(runtime.wake).toHaveBeenCalledOnce();
  expect(readRunQueue(f.store)).toEqual([]);
});

test("a prequeued Run sorts by its original trigger, not by the later notification", async () => {
  const queued = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: target.assignment.id,
        kind: "fix",
        model: "m",
        agent_cli_version: "1",
      },
      p,
    ),
  );
  f.advance(1000);
  const other = secondProject();
  other.comment();
  f.advance(1000);
  comment();
  await new Dispatcher({ ...options, runLimit: () => 1 }).tick();
  expect(f.state().runs.find((r) => r.id === queued.id)?.status).toBe(
    "dispatched",
  );
  expect(options.startRun).not.toHaveBeenCalled();
  expect(readRunQueue(f.store)[0]?.project_id).toBe(other.project);
});

test("C-255: a standing decision records the old Run ending before the next dispatch without an extra bell", async () => {
  const extra = f.create();
  const { work_item_id: _workItem, ...base } = extra.assignment;
  const pm: Assignment = {
    ...base,
    scope: "standing",
    role_id: "pm",
    standing_mode: "ops",
  };
  f.store.uow.run((tx) => {
    tx.assignments.put(f.project, pm);
    const role = tx.roles.get(f.project, { role_id: "pm", role_version: 1 });
    if (!role) throw new Error("Missing PM role");
    tx.roles.put(f.project, {
      ...role,
      allowed_tools: [...role.allowed_tools, "request_decision"],
    });
  });
  const previous = f.session(pm, false);
  const event = f.apply((s, a, p) =>
    postComment(s, a, { card_id: extra.card.id, body: "PM message" }, p),
  );
  const cause =
    f.state().events.find((e) => e.id === event.id) ?? f.state().events.at(-1);
  if (!cause) throw new Error("Missing cause");
  f.store.recordNotification({
    project_id: f.project,
    event_id: cause.id,
    card_id: cause.card_id,
    seq: cause.seq,
    kind: "comment",
    recipient: { kind: "assignment", assignment_id: pm.id },
  });
  const dispatcher = new Dispatcher(options);
  await dispatcher.tick();
  expect(f.state().runs.filter((r) => r.assignment_id === pm.id)).toHaveLength(
    1,
  );
  expect(runtime.wake).not.toHaveBeenCalled();

  const decision = f.apply(
    (s, a, p) =>
      requestDecision(
        s,
        a,
        {
          category: "general",
          kind: "choose",
          question: "Choose the next step",
          context: "Needs a decision",
          options: [
            { key: "go", description: "Continue", impact: "Resume work" },
          ],
          recommended: "go",
          affected_cards: [],
          affected_work_items: [],
          blocking: true,
          decider: "human",
          plain_summary: {
            changed: "等待确认后续安排",
            impact: "暂停本次工作",
            risk: "无",
          },
        },
        p,
      ),
    f.actorFor(pm),
  );
  const endings = () =>
    f
      .state()
      .events.filter(
        (e) =>
          e.type === "run_finished" &&
          (e.payload as { run_id?: string }).run_id === previous.id,
      );
  expect(endings()).toHaveLength(1);
  expect(endings()[0]).toMatchObject({
    payload: {
      run_id: previous.id,
      outcome: "blocked",
      finished_by: "system",
      reason: "blocking_decision",
      decision_id: decision.id,
    },
  });
  const original = f.state().runs.find((r) => r.id === previous.id);
  await dispatcher.tick();
  const next = f
    .state()
    .runs.find((r) => r.assignment_id === pm.id && r.id !== previous.id);
  expect(next?.status).toBe("dispatched");
  expect(runtime.wake).toHaveBeenCalledTimes(1);
  expect(endings()).toHaveLength(1);
  expect(f.state().runs.find((r) => r.id === previous.id)).toEqual(original);
  expect(() =>
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          {
            run_id: previous.id,
            outcome: "completed",
            summary: "Late conclusion",
          },
          p,
        ),
      f.actorFor(pm),
    ),
  ).toThrow("结果和摘要未保存");
  await dispatcher.tick();
  expect(runtime.wake).toHaveBeenCalledTimes(1);
  expect(f.state().runs.find((r) => r.id === next?.id)).toEqual(next);
});

function standingSession(role_id: string, standing_mode?: "office" | "ops") {
  const extra = f.create();
  const { work_item_id: _workItem, ...base } = extra.assignment;
  const owner: Assignment = {
    ...base,
    scope: "standing",
    role_id,
    ...(standing_mode ? { standing_mode } : {}),
  };
  f.store.uow.run((tx) => {
    const pm = tx.roles.get(f.project, { role_id: "pm", role_version: 1 });
    if (!pm) throw new Error("Missing fixture role");
    tx.roles.put(f.project, { ...pm, role_id });
    tx.assignments.put(f.project, owner);
  });
  f.session(owner);
  return owner;
}

test.each([
  ["pm", "office", 0],
  ["pm", "ops", 0],
  ["host_ops", undefined, 0],
  ["pm", "office", 1],
  ["pm", "ops", 1],
  ["host_ops", undefined, 1],
] as const)(
  "C-296 standing %s/%s dispatches at limit %s without occupying capacity or queue positions",
  async (role_id, standing_mode, limit) => {
    const busy = f.create();
    f.session(busy.assignment, false);
    const owner = standingSession(role_id, standing_mode);
    comment(); // Ordinary work is first in FIFO, yet cannot hold up standing work.
    const dispatcher = new Dispatcher({ ...options, runLimit: () => limit });
    await dispatcher.tick();
    const waiting = readRunQueue(f.store);
    const run = f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: owner.id,
          model: "m",
          agent_cli_version: "1",
        },
        p,
      ),
    );
    f.store.uow.run((tx) =>
      tx.runs.put(f.project, { ...run, queue_reason: "concurrency_limit" }),
    );
    await dispatcher.tick();
    expect(f.state().runs.find((r) => r.id === run.id)).toMatchObject({
      status: "dispatched",
    });
    expect(readRunQueue(f.store)).toEqual(waiting);
    expect(executionCapacity(f.store).agents).toMatchObject([
      { running: 1, total_running: 2, queued: 1 },
    ]);
    finish(busy.assignment);
    await dispatcher.tick();
    // The standing Run cannot take the last slot from ordinary work.
    expect(
      f
        .state()
        .runs.find(
          (r) =>
            r.assignment_id === target.assignment.id &&
            r.status !== "completed",
        )?.status,
    ).toBe(limit === 0 ? "queued" : "dispatched");
    expect(
      f
        .state()
        .runs.filter(
          (r) => r.assignment_id === owner.id && r.status === "dispatched",
        ),
    ).toHaveLength(1);
  },
);

test.each(["pm", "host_ops"])(
  "C-296 shared system launch admits standing %s at zero capacity",
  async (role_id) => {
    const owner = standingSession(role_id);
    f.store.issueToken({
      project_id: f.project,
      assignment_id: owner.id,
      role: { role_version: 1, allowed_tools: ["whoami"] },
    });
    const run = f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        { assignment_id: owner.id, model: "m", agent_cli_version: "1" },
        p,
      ),
    );
    const launched = await launchRun(
      {
        store: f.store,
        runtime,
        launch: { config: { gateways: {}, profiles: {} }, secrets: {} },
        mcpUrl: "http://127.0.0.1/mcp",
        dataDir: f.dataDir,
        runLimit: () => 0,
      },
      {
        project: f.project,
        assignment_id: owner.id,
        run,
        actor: { kind: "system", project_id: f.project },
        reuse_session: true,
      },
    );
    expect(launched.run.status).toBe("dispatched");
    expect(launched.capacity_notice).toBeUndefined();
    expect(runtime.wake).toHaveBeenCalledOnce();
    expect(readRunQueue(f.store)).toEqual([]);
  },
);

test("C-296 an exempt startup reservation permits ordinary work but still excludes a second launch of its owner", async () => {
  const owner = standingSession("host_ops");
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      { assignment_id: owner.id, model: "m", agent_cli_version: "1" },
      p,
    ),
  );
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, { ...run, queue_reason: "concurrency_limit" }),
  );
  const started = new Set<string>();
  vi.mocked(runtime.status).mockImplementation(async (ref) => ({
    ok: true,
    value: {
      process: started.has(ref.terminal_ref) ? "alive" : "exited",
      agent: "idle",
      observed_seq: 1,
    },
  }));
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startRun = vi.fn(
    async (input: Parameters<DispatcherOptions["startRun"]>[0]) => {
      if (input.assignment.id === owner.id) await hold;
      await options.startRun(input);
      started.add(f.refFor(input.assignment).terminal_ref);
    },
  );
  const settings = { ...options, startRun, runLimit: () => 1 };
  const first = new Dispatcher(settings).tick();
  try {
    await expect.poll(() => startRun.mock.calls.length).toBe(1);
    comment();
    await new Dispatcher(settings).tick();
    await new Dispatcher(settings).tick();
    expect(startRun.mock.calls.map(([input]) => input.assignment.id)).toEqual([
      owner.id,
      target.assignment.id,
    ]);
    expect(executionCapacity(f.store).agents).toMatchObject([
      { running: 1, total_running: 2, queued: 0 },
    ]);
  } finally {
    release();
    await first;
  }
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
    "dispatched",
  );
});

test("running merge checks occupy two slots across projects until their attempt finishes", async () => {
  const other = secondProject();
  const release = acquireMergeCheckCapacity(
    f.store,
    other.project,
    "merge-test",
  );
  comment();
  const dispatcher = new Dispatcher({ ...options, runLimit: () => 2 });
  await dispatcher.tick();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(readRunQueue(f.store)[0]?.ahead).toBe(0);
  release();
  await dispatcher.tick();
  expect(runtime.wake).toHaveBeenCalledOnce();
});

test("P2a-12 D: remote executor checks do not consume the host's Run slots, even with a same-named agent machine", async () => {
  const other = secondProject();
  const owner = executionOwner(process.pid);
  if (!owner) throw new Error("Missing process identity");
  const releases = [
    acquireMergeCheckCapacity(f.store, f.project, "ci-a", owner, "cardigan-ci"),
    acquireMergeCheckCapacity(
      f.store,
      other.project,
      "ci-b",
      owner,
      "cardigan-ci",
    ),
  ];
  try {
    comment();
    // A machines quota of 1 still admits the Run: no check runs locally.
    await new Dispatcher({ ...options, runLimit: () => 1 }).tick();
    expect(runtime.wake).toHaveBeenCalledOnce();
    const snapshot = f.store.uow.read((tx) => runCapacitySnapshot(f.store, tx));
    expect(snapshot.occupied.get("cardigan-ci")).toBeUndefined();
    expect(snapshot.occupied.get("local")).toBe(1);
    expect(snapshot.mergeChecks.get("cardigan-ci")).toBe(2);
    expect(snapshot.mergeChecks.get("local")).toBeUndefined();
  } finally {
    for (const release of releases) release();
  }
});

test("P2a-12 D: merge checks are counted per execution target across projects and release independently", () => {
  const other = secondProject();
  const owner = executionOwner(process.pid);
  if (!owner) throw new Error("Missing process identity");
  const local = acquireMergeCheckCapacity(f.store, f.project, "l", owner);
  const ciA = acquireMergeCheckCapacity(
    f.store,
    f.project,
    "a",
    owner,
    "cardigan-ci",
  );
  const ciB = acquireMergeCheckCapacity(
    f.store,
    other.project,
    "b",
    owner,
    "cardigan-ci",
  );
  const gpu = acquireMergeCheckCapacity(
    f.store,
    other.project,
    "g",
    owner,
    "build-2",
  );
  const view = () =>
    f.store.uow.read((tx) => {
      const s = runCapacitySnapshot(f.store, tx);
      return {
        local: s.occupied.get("local"),
        checks: Object.fromEntries(s.mergeChecks),
      };
    });
  try {
    expect(view()).toEqual({
      local: 2,
      checks: { local: 1, "cardigan-ci": 2, "build-2": 1 },
    });
    expect(mergeCheckCapacityAvailable(f.store, "cardigan-ci", 2)).toBe(false);
    expect(mergeCheckCapacityAvailable(f.store, "build-2", 2)).toBe(true);
    ciA();
    expect(view()).toEqual({
      local: 2,
      checks: { local: 1, "cardigan-ci": 1, "build-2": 1 },
    });
    expect(mergeCheckCapacityAvailable(f.store, "cardigan-ci", 1)).toBe(false);
    expect(mergeCheckCapacityAvailable(f.store, "cardigan-ci", 2)).toBe(true);
    local();
    expect(view()).toEqual({
      local: 0,
      checks: { "cardigan-ci": 1, "build-2": 1 },
    });
  } finally {
    local();
    ciA();
    ciB();
    gpu();
  }
});

test.each(["machine", "resource"])(
  "startup reservations prevent concurrent dispatchers from claiming the last %s slot",
  async (kind) => {
    const extra = f.create();
    if (kind === "resource")
      for (const item of [target.item, extra.item])
        requireCapabilities(item, ["godot", "godot>=4"]);
    comment();
    f.advance(1);
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        { card_id: extra.card.id, work_item_id: extra.item.id, body: "second" },
        p,
      ),
    );
    vi.mocked(runtime.status).mockResolvedValue({
      ok: true,
      value: { process: "exited", agent: "unknown", observed_seq: 1 },
    });
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = options.startRun;
    const startRun = vi.fn(
      async (input: Parameters<DispatcherOptions["startRun"]>[0]) => {
        await hold;
        await original(input);
      },
    );
    const settings = {
      ...options,
      startRun,
      runLimit: () => (kind === "machine" ? 1 : 4),
      resourceLimits: () => new Map([["godot", 1]]),
    };
    const first = new Dispatcher(settings).tick();
    try {
      await expect.poll(() => startRun.mock.calls.length).toBe(1);
      if (kind === "resource") {
        expect(startRun.mock.calls[0]?.[0].run.resource_keys).toEqual([
          "godot",
        ]);
        // A PM edit during startup must not release the already reserved slot.
        requireCapabilities(target.item, []);
      }
      await new Dispatcher(settings).tick();
      expect(startRun).toHaveBeenCalledOnce();
      expect(readRunQueue(f.store)[0]?.assignment_id).toBe(extra.assignment.id);
    } finally {
      release();
      await first;
    }
    expect(startRun).toHaveBeenCalledOnce();
  },
);

test.each(["system", "human"] as const)(
  "%s host launches respect capacity and the Dispatcher resumes the same queued Run",
  async (kind) => {
    const busy = f.create();
    if (kind === "human")
      for (const item of [busy.item, target.item])
        requireCapabilities(item, ["ios.simulator"]);
    f.session(busy.assignment, false);
    const limits = {
      runLimit: () => (kind === "system" ? 1 : 4),
      resourceLimits: () => new Map([["ios.simulator", 1]]),
    };
    const run = f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: target.assignment.id,
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
          assignment_id: target.assignment.id,
          run,
          actor: { kind, project_id: f.project },
          reuse_session: true,
        },
      ),
    ).rejects.toBeInstanceOf(RunCapacityDeferred);
    expect(runtime.status).not.toHaveBeenCalled();
    expect(readRunQueue(f.store)[0]?.run_id).toBe(run.id);
    finish(busy.assignment);
    await new Dispatcher({ ...options, ...limits }).tick();
    expect(runtime.wake).toHaveBeenCalledOnce();
    expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
      "dispatched",
    );
  },
);

test("ACK while waiting neither loses nor recreates the queued Run", async () => {
  const busy = f.create();
  f.session(busy.assignment, false);
  comment();
  const dispatcher = new Dispatcher({ ...options, runLimit: () => 1 });
  await dispatcher.tick();
  const run = readRunQueue(f.store)[0];
  const note = ownNotes()[0];
  if (!note?.card_id || !run) throw new Error("Missing waiting work");
  f.store.ackEvents({
    project_id: f.project,
    assignment_id: target.assignment.id,
    card_id: note.card_id,
    up_to_seq: note.seq,
  });
  finish(busy.assignment);
  await dispatcher.tick();
  expect(f.state().runs.find((r) => r.id === run.run_id)?.status).toBe(
    "dispatched",
  );
  expect(runtime.wake).toHaveBeenCalledOnce();
  expect(ownNotes()[0]?.status).toBe("acked");
});

test("expired queued startup is cancelled before capacity is reused; late dispatch cannot cross the fence", async () => {
  const extra = f.create();
  comment();
  f.advance(1);
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: extra.card.id, work_item_id: extra.item.id, body: "next" },
      p,
    ),
  );
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "exited", agent: "unknown", observed_seq: 1 },
  });
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = options.startRun;
  const startRun = vi.fn(
    async (input: Parameters<DispatcherOptions["startRun"]>[0]) => {
      if (input.assignment.id === target.assignment.id) await hold;
      await original(input);
    },
  );
  const settings = { ...options, startRun, runLimit: () => 1 };
  const first = new Dispatcher(settings).tick();
  try {
    await expect.poll(() => startRun.mock.calls.length).toBe(1);
    f.advance(1001);
    await new Dispatcher(settings).tick();
    expect(
      f.state().runs.find((r) => r.id === startRun.mock.calls[0]?.[0].run.id)
        ?.status,
    ).toBe("cancelled");
    release();
    await first;
    expect(
      f.store.uow.read((tx) =>
        runCapacitySnapshot(f.store, tx).occupied.get("local"),
      ),
    ).toBe(1);
    expect(
      f
        .state()
        .runs.filter((r) => r.status === "dispatched")
        .map((r) => r.assignment_id),
    ).toEqual([extra.assignment.id]);
  } finally {
    release();
    await first;
  }
});

test("an unavailable queue head yields to healthy work, stays visible, and resumes with its original Run", async () => {
  const busy = f.create();
  f.session(busy.assignment, false);
  comment();
  f.advance(1);
  const extra = f.create();
  f.session(extra.assignment);
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: extra.card.id, work_item_id: extra.item.id, body: "next" },
      p,
    ),
  );
  const dispatcher = new Dispatcher({ ...options, runLimit: () => 1 });
  await dispatcher.tick();
  const before = readRunQueue(f.store);
  expect(before.map((r) => r.assignment_id)).toEqual([
    target.assignment.id,
    extra.assignment.id,
  ]);
  finish(busy.assignment);
  vi.mocked(runtime.status).mockImplementation(async (ref) => ({
    ok: true,
    value: {
      process:
        ref.terminal_ref === f.refFor(target.assignment).terminal_ref
          ? "unknown"
          : "alive",
      agent: "idle",
      observed_seq: 1,
    },
  }));
  await dispatcher.tick();
  const deferred = f.state().runs.find((r) => r.id === before[0]?.run_id);
  expect(deferred).toMatchObject({
    status: "queued",
    queue_reason: "runtime_unavailable",
  });
  expect(readRunQueue(f.store)).toEqual([]);
  expect(f.state().runs.find((r) => r.id === before[1]?.run_id)?.status).toBe(
    "dispatched",
  );
  await dispatcher.tick();
  expect(
    f.state().events.filter((e) => e.type === "queued_runtime_unavailable"),
  ).toHaveLength(1);
  expect(runtime.wake).toHaveBeenCalledOnce();
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 2 },
  });
  await new Dispatcher({ ...options, runLimit: () => 2 }).tick();
  expect(f.state().runs.find((r) => r.id === deferred?.id)).toMatchObject({
    status: "dispatched",
  });
  expect(runtime.wake).toHaveBeenCalledTimes(2);
});

test.each(["request_changes", "cancelled"] as const)(
  "merge execution releases its slots even when %s invalidates its business result",
  async (action) => {
    const m = m4Fixture();
    try {
      const scenario = m4Scenario(m, "confirm");
      await acceptThroughMergeGate(m, scenario, "a".repeat(40));
      const occupied = () =>
        m.store.uow.read((tx) =>
          runCapacitySnapshot(m.store, tx).occupied.get("local"),
        );
      const errors = vi.fn();
      const gate = new MergeChecks({
        store: m.store,
        clock: m.clock,
        onError: errors,
        execution: { mode: "local", dataDir: m.dataDir },
        configuration: {
          errors: [],
          forProject: () => ({
            status: "enabled",
            checks: [{ name: "fixture", run: "true" }],
            env: {},
            totalTimeoutMs: 1000,
          }),
        },
        git: {
          projectOf: (project_id) => ({
            project_id,
            source_repo: "fixture",
            base_branch: "main",
          }),
          sync: async () => "up_to_date",
          merge: async () => {
            throw new Error("not used");
          },
          baseline: async () => "a".repeat(40),
          prepare: async () => ({
            status: "candidate",
            candidate_sha: "b".repeat(40),
            tree_sha: "c".repeat(40),
            previous_sha: "a".repeat(40),
          }),
          distribute: async () => {},
          publish: async () => {
            throw new Error("must not publish");
          },
        },
        run: async (input) => {
          expect(occupied()).toBe(2); // Admission reserves before the ready handshake (C-201).
          input.onReady?.();
          expect(occupied()).toBe(2);
          if (action === "cancelled")
            m.apply((s, a, p) =>
              updateCard(
                s,
                a,
                { card_id: scenario.card.id, status: "cancelled" },
                p,
              ),
            );
          else {
            const decision = mergeConfirmation(m, scenario.card.id);
            if (!decision) throw new Error("Missing confirmation");
            m.decide(decision, "request_changes");
          }
          expect(occupied()).toBe(2); // Target invalidation must not release a still-running executor.
          return { status: "failed", checks: [], cleanup_errors: [] };
        },
      });
      await gate.tick([m.project_id]);
      expect(errors).toHaveBeenCalled(); // The existing merge state machine still rejects its stale result.
      expect(occupied()).toBe(0);
      expect(
        m.state().events.filter((e) => e.type === "merge_check_started"),
      ).toHaveLength(1);
      expect(
        m.state().events.filter((e) => e.type === "merge_check_finished"),
      ).toHaveLength(0);
    } finally {
      m.close();
    }
  },
);

test("reopened capacity view releases proven dead owners while preserving live and unknown checks", () => {
  const owner = executionOwner(process.pid);
  if (!owner) throw new Error("Missing process identity");
  const release = acquireMergeCheckCapacity(f.store, f.project, "live", owner);
  const stale = acquireMergeCheckCapacity(f.store, f.project, "stale", {
    ...owner,
    start: `${owner.start.split(":")[0]}:0`,
  });
  const dead = acquireMergeCheckCapacity(f.store, f.project, "dead", {
    pid: 2147483647,
    start: owner.start,
  });
  const unknown = acquireMergeCheckCapacity(f.store, f.project, "unknown", {
    ...owner,
    start: "unrecognized",
  });
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    expect(
      reopened.uow.read((tx) =>
        runCapacitySnapshot(reopened, tx).occupied.get("local"),
      ),
    ).toBe(4);
    release();
    expect(
      reopened.uow.read((tx) =>
        runCapacitySnapshot(reopened, tx).occupied.get("local"),
      ),
    ).toBe(2);
    unknown();
    expect(
      reopened.uow.read((tx) =>
        runCapacitySnapshot(reopened, tx).occupied.get("local"),
      ),
    ).toBe(0);
  } finally {
    reopened.close();
    release();
    stale();
    dead();
    unknown();
  }
});

function inactiveTarget() {
  const busy = f.create();
  const run = f.session(busy.assignment, false);
  const token = f.store.issueToken({
    project_id: f.project,
    assignment_id: busy.assignment.id,
    role: {
      role_version: busy.assignment.role_version,
      allowed_tools: ["whoami"],
    },
  });
  f.store.uow.run((tx) => {
    const owner = tx.assignments.get(f.project, busy.assignment.id);
    if (!owner) throw new Error("Missing owner");
    tx.assignments.put(f.project, {
      ...owner,
      worktree_path: "/fixture/retained",
      branch: "agent/retained",
      base_sha: "a".repeat(40),
    });
  });
  comment();
  f.advance(101);
  return {
    busy,
    run,
    token,
    settings: {
      ...options,
      runLimit: () => 1,
      inactivityGraceMs: 50,
      inactiveCancelAfterMs: 100,
    },
  };
}
const slots = () =>
  f.store.uow.read((tx) =>
    runCapacitySnapshot(f.store, tx).occupied.get("local"),
  );

test("Q-86 stops and confirms exit before cancelling/revoking, then automatically dispatches the next Run", async () => {
  const t = inactiveTarget();
  let stopped = false;
  const order: string[] = [];
  vi.mocked(runtime.status).mockImplementation(async (ref) => {
    const current =
      ref.terminal_ref === f.refFor(t.busy.assignment).terminal_ref;
    if (current) {
      order.push(stopped ? "confirm" : "observe");
      expect(f.store.verifyToken(t.token.token)).toBeDefined();
      expect(f.state().runs.find((r) => r.id === t.run.id)?.status).toBe(
        "running",
      );
      expect(slots()).toBe(1);
    }
    return {
      ok: true,
      value: {
        process: current && stopped ? "exited" : "alive",
        agent: "idle",
        observed_seq: 1,
      },
    };
  });
  runtime.release = vi.fn(async () => {
    order.push("release");
    stopped = true;
    return { ok: true, value: undefined };
  });
  await new Dispatcher(t.settings).tick();
  expect(order).toEqual(["observe", "release", "confirm"]);
  expect(f.state().runs.find((r) => r.id === t.run.id)).toMatchObject({
    status: "cancelled",
    outcome: "failed",
  });
  expect(f.store.verifyToken(t.token.token)).toBeUndefined();
  expect(
    f.state().assignments.find((a) => a.id === t.busy.assignment.id),
  ).toMatchObject({
    worktree_path: "/fixture/retained",
    branch: "agent/retained",
    base_sha: "a".repeat(40),
  });
  expect(
    f.state().events.filter((e) => e.type === "run_inactivity_stop_finished"),
  ).toHaveLength(1);
  expect(
    f
      .state()
      .timeline.some(
        (entry) => entry.run_id === t.run.id && entry.body.includes("自动取消"),
      ),
  ).toBe(true);
  expect(runtime.wake).toHaveBeenCalledOnce();
  expect(slots()).toBe(1); // Only the newly dispatched work occupies the slot.
});

test("Q-86 MCP activity arriving during the preflight read withdraws cancellation", async () => {
  const t = inactiveTarget();
  vi.mocked(runtime.status).mockImplementation(async (ref) => {
    if (ref.terminal_ref === f.refFor(t.busy.assignment).terminal_ref) {
      f.advance(1);
      f.store.touchAssignmentActivity(
        f.project,
        t.busy.assignment.id,
        f.clock.now(),
      );
    }
    return {
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    };
  });
  runtime.release = vi.fn(async () => ({ ok: true, value: undefined }));
  await new Dispatcher(t.settings).tick();
  expect(runtime.release).not.toHaveBeenCalled();
  expect(f.state().runs.find((r) => r.id === t.run.id)).toMatchObject({
    status: "running",
  });
  expect(
    f.state().runs.find((r) => r.id === t.run.id)?.inactivity_stop,
  ).toBeUndefined();
  expect(f.store.verifyToken(t.token.token)).toBeDefined();
  expect(runtime.wake).not.toHaveBeenCalled();
});

test("inactivity settlement rolls back cancellation and slot release when shared token revocation fails", async () => {
  const t = inactiveTarget();
  let stopped = false;
  vi.mocked(runtime.status).mockImplementation(async (ref) => ({
    ok: true,
    value: {
      process:
        stopped && ref.terminal_ref === f.refFor(t.busy.assignment).terminal_ref
          ? "exited"
          : "alive",
      agent: "idle",
      observed_seq: 1,
    },
  }));
  runtime.release = vi.fn(async () => {
    stopped = true;
    return { ok: true, value: undefined };
  });
  f.store.database.exec(
    "CREATE TRIGGER fail_revoke BEFORE UPDATE OF revoked_at ON tokens BEGIN SELECT RAISE(ABORT, 'test revoke failure'); END",
  );
  try {
    await expect(new Dispatcher(t.settings).tick()).rejects.toThrow(
      "test revoke failure",
    );
  } finally {
    f.store.database.exec("DROP TRIGGER fail_revoke");
  }
  expect(f.state().runs.find((r) => r.id === t.run.id)).toMatchObject({
    status: "running",
    inactivity_stop: { stopping: true },
  });
  expect(f.store.verifyToken(t.token.token)).toBeDefined();
  expect(slots()).toBe(1);
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(
    f
      .state()
      .events.filter(
        (e) =>
          e.type === "run_dispatch_aborted" ||
          e.type === "run_inactivity_stop_finished",
      ),
  ).toHaveLength(0);
  f.advance(60001);
  await new Dispatcher(t.settings).tick();
  expect(f.state().runs.find((r) => r.id === t.run.id)).toMatchObject({
    status: "cancelled",
  });
  expect(f.store.verifyToken(t.token.token)).toBeUndefined();
  expect(runtime.release).toHaveBeenCalledOnce();
  expect(runtime.wake).toHaveBeenCalledOnce();
  expect(slots()).toBe(1);
});

test.each(["alive", "unknown", "unavailable"] as const)(
  "Q-86 unconfirmed %s exit retains the slot and token until a later confirmed retry",
  async (observed) => {
    const t = inactiveTarget();
    let confirmed = false;
    vi.mocked(runtime.status).mockImplementation(async (ref) => {
      if (ref.terminal_ref !== f.refFor(t.busy.assignment).terminal_ref)
        return {
          ok: true,
          value: { process: "alive", agent: "idle", observed_seq: 1 },
        };
      if (confirmed)
        return {
          ok: false,
          error: { code: "runtime_not_found", message: "gone" },
        };
      if (observed === "unavailable")
        return {
          ok: false,
          error: { code: "runtime_unavailable", message: "unknown" },
        };
      return {
        ok: true,
        value: { process: observed, agent: "idle", observed_seq: 1 },
      };
    });
    runtime.release = vi.fn(async () => {
      // RuntimeMonitor may change the status during the external call; the stop
      // intent must still hold capacity until exit proof arrives.
      f.store.uow.run((tx) => {
        const run = tx.runs.get(f.project, t.run.id);
        if (run) tx.runs.put(f.project, { ...run, status: "unknown" });
      });
      return {
        ok: false,
        error: { code: "runtime_timeout", message: "unconfirmed" },
      };
    });
    const dispatcher = new Dispatcher(t.settings);
    await dispatcher.tick();
    await new Dispatcher(t.settings).tick();
    expect(runtime.release).toHaveBeenCalledOnce();
    expect(slots()).toBe(1);
    expect(f.store.verifyToken(t.token.token)).toBeDefined();
    expect(runtime.wake).not.toHaveBeenCalled();
    expect(
      f.state().events.filter((e) => e.type === "inactive_stop_unconfirmed"),
    ).toHaveLength(1);
    confirmed = true;
    f.advance(60_001);
    const reopened = Store.open({ dataDir: f.dataDir });
    try {
      await new Dispatcher({ ...t.settings, store: reopened }).tick();
    } finally {
      reopened.close();
    }
    expect(f.state().runs.find((r) => r.id === t.run.id)).toMatchObject({
      status: "cancelled",
      outcome: "failed",
    });
    expect(f.store.verifyToken(t.token.token)).toBeUndefined();
    expect(runtime.release).toHaveBeenCalledOnce(); // Exit is already proven on recovery.
    expect(runtime.wake).toHaveBeenCalledOnce();
  },
);

test("Q-86 an in-flight stop fences concurrent dispatchers and preserves a Run that finishes meanwhile", async () => {
  const t = inactiveTarget();
  let release = () => {},
    stopped = false;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(runtime.status).mockImplementation(async (ref) => ({
    ok: true,
    value: {
      process:
        stopped && ref.terminal_ref === f.refFor(t.busy.assignment).terminal_ref
          ? "exited"
          : "alive",
      agent: "idle",
      observed_seq: 1,
    },
  }));
  runtime.release = vi.fn(async () => {
    await hold;
    stopped = true;
    return { ok: true, value: undefined };
  });
  const first = new Dispatcher(t.settings).tick();
  try {
    await expect
      .poll(() => vi.mocked(runtime.release).mock.calls.length)
      .toBe(1);
    finish(t.busy.assignment);
    await new Dispatcher(t.settings).tick();
    expect(runtime.release).toHaveBeenCalledOnce();
    expect(slots()).toBe(1);
    expect(runtime.wake).not.toHaveBeenCalled();
    release();
    await first;
    expect(f.state().runs.find((r) => r.id === t.run.id)).toMatchObject({
      status: "completed",
      outcome: "completed",
    });
    expect(f.store.verifyToken(t.token.token)).toBeUndefined();
    expect(runtime.wake).toHaveBeenCalledOnce();
  } finally {
    release();
    await first;
  }
});

test("Q-88 the 60-minute default tolerates 48-minute silence and restarts on fresh MCP activity", async () => {
  const t = inactiveTarget();
  runtime.release = vi.fn(async () => ({ ok: true, value: undefined }));
  f.advance(48 * 60_000);
  const dispatcher = new Dispatcher({ ...options, runLimit: () => 1 });
  await dispatcher.tick();
  expect(f.state().events.some((e) => e.type === "run_inactive")).toBe(true);
  expect(runtime.release).not.toHaveBeenCalled();
  expect(
    f.state().runs.find((r) => r.id === t.run.id)?.inactivity_stop,
  ).toBeUndefined();
  f.store.touchAssignmentActivity(
    f.project,
    t.busy.assignment.id,
    f.clock.now(),
  );
  f.advance(59 * 60_000);
  await dispatcher.tick();
  expect(runtime.release).not.toHaveBeenCalled();
  expect(f.store.verifyToken(t.token.token)).toBeDefined();
  expect(slots()).toBe(1);
});

test("a lowered host ceiling constrains an existing database override on dispatch", async () => {
  const busy = f.create();
  f.session(busy.assignment, false);
  saveLimit(16);
  comment();
  await new Dispatcher({
    ...options,
    runLimit: () => 1,
    runLimitMaximum: () => 1,
  }).tick();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(readRunQueue(f.store).map((r) => r.assignment_id)).toContain(
    target.assignment.id,
  );
  expect(
    executionCapacity(
      f.store,
      () => 1,
      undefined,
      () => 1,
    ).agents[0],
  ).toMatchObject({ limit: 1, max_limit: 1 });
});

test.each(["yaml", "override", "ceiling"])(
  "Q-88/C-158 human CLI start shares the effective cap (%s)",
  async (mode) => {
    const busy = f.create();
    f.session(busy.assignment, false);
    const automatic = f.create();
    f.session(automatic.assignment);
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        {
          card_id: automatic.card.id,
          work_item_id: automatic.item.id,
          body: "automatic work",
        },
        p,
      ),
    );
    f.store.issueToken({
      project_id: f.project,
      assignment_id: target.assignment.id,
      role: {
        role_version: target.assignment.role_version,
        allowed_tools: ["whoami"],
      },
    });
    const configDir = join(f.dataDir, "config");
    await mkdir(configDir, { mode: 0o700 });
    await writeFile(
      join(configDir, "run-capacity.yaml"),
      mode === "ceiling"
        ? "machines: { local: { limit: 1, max_limit: 1 } }\n"
        : `machines: { local: ${mode === "override" ? 4 : 1} }\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(configDir, "launch.yaml"),
      "profiles:\n  fixture:\n    harness: pi\n    model: fixture-model\n",
      { mode: 0o600 },
    );
    if (mode !== "yaml") saveLimit(mode === "ceiling" ? 4 : 1);
    const output: string[] = [];
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(runtime.wake).mockImplementationOnce(async () => {
      await hold;
      return { ok: true, value: { sent: true } };
    });
    const manual = startAssignmentCommand({
      store: f.store,
      project_id: f.project,
      assignment_id: target.assignment.id,
      runtime,
      dataDir: f.dataDir,
      io: {
        cwd: f.dataDir,
        platform: "linux",
        signals: { on() {}, off() {} },
        env: {
          CARDIGAN_CONFIG_DIR: configDir,
          CARDIGAN_DATA_DIR: f.dataDir,
          CARDIGAN_RUNTIME_MODE: "local",
        },
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        captureCommand: async () => ({
          code: 0,
          stdout: "fixture-cli 1.0\n",
          stderr: "",
        }),
        spawnInherit: () => {
          throw new Error("No real process in this test");
        },
      },
    });
    void manual.catch(() => {});
    try {
      await expect
        .poll(() => vi.mocked(runtime.wake).mock.calls.length)
        .toBe(1);
      expect(
        f
          .state()
          .runs.some(
            (r) =>
              r.assignment_id === target.assignment.id &&
              r.status === "dispatched",
          ),
      ).toBe(true);
      expect(slots()).toBe(2);
      // The CLI uses the wall clock. Keep recovery leases on that same clock;
      // fixture Run timestamps are later and cannot accidentally become inactive.
      await new Dispatcher({
        ...options,
        clock: { now: () => new Date().toISOString() },
        runLimit: () => 1,
        ...(mode === "ceiling" ? { runLimitMaximum: () => 1 } : {}),
      }).tick();
      expect(readRunQueue(f.store).map((r) => r.assignment_id)).toEqual([
        automatic.assignment.id,
      ]);
      expect(runtime.wake).toHaveBeenCalledOnce();
      release();
      expect(await manual).toBe(0);
      expect(output.join("\n")).toContain("已超过全机上限（当前 2/上限 1）");
      expect(output.join("\n")).toContain(`已启动 ${target.assignment.id}`);
      expect(output.join("\n")).not.toContain("排队中");
      expect(slots()).toBe(2);
    } finally {
      release();
      await manual;
    }
  },
);

test("live card priority reorders the saturated cross-project queue without replacing Runs", async () => {
  const other = secondProject();
  other.comment();
  f.advance(1000);
  comment();
  const busy = f.create();
  f.session(busy.assignment, false);
  const dispatcher = new Dispatcher({ ...options, runLimit: () => 1 });
  await dispatcher.tick();
  const before = readRunQueue(f.store);
  expect(before.map((r) => r.project_id)).toEqual([other.project, f.project]);
  f.apply((s, a, p) =>
    updateCard(s, a, { card_id: target.card.id, priority: "urgent" }, p),
  );
  expect(readRunQueue(f.store).map((r) => r.project_id)).toEqual([
    f.project,
    other.project,
  ]);
  finish(busy.assignment);
  await dispatcher.tick();
  expect(runtime.wake).toHaveBeenCalledOnce();
  expect(options.startRun).not.toHaveBeenCalled();
  const queued = before.find((r) => r.project_id === f.project);
  expect(f.state().runs.find((r) => r.id === queued?.run_id)?.status).toBe(
    "dispatched",
  );
  expect(readRunQueue(f.store).map((r) => [r.project_id, r.ahead])).toEqual([
    [other.project, 0],
  ]);
});

test("execution warns only for old low-priority capacity waits, using the configured threshold", async () => {
  const busy = f.create();
  f.session(busy.assignment, false);
  comment();
  await new Dispatcher({ ...options, runLimit: () => 1 }).tick();
  const queue = readRunQueue(f.store);
  f.advance(10 * 60_000);
  const view = (minutes: number) =>
    executionView(f.state(), f.clock.now(), [], readRunQueue(f.store), minutes);
  expect(view(9).runs.find((r) => r.id === queue[0]?.run_id)).toMatchObject({
    queue_warning: { after_minutes: 9 },
  });
  expect(view(11).runs.find((r) => r.id === queue[0]?.run_id)).toMatchObject({
    queue_warning: { after_minutes: 11, waited_ms: 600000 },
  });
  f.apply((s, a, p) =>
    updateCard(s, a, { card_id: target.card.id, priority: "urgent" }, p),
  );
  expect(
    view(9).runs.find((r) => r.id === queue[0]?.run_id),
  ).not.toHaveProperty("queue_warning");
});

test("C-297: current harness activity prevents both inactivity alerts and automatic cancellation", async () => {
  const t = inactiveTarget();
  f.advance(61 * 60_000);
  const assignment = f
    .state()
    .assignments.find((a) => a.id === t.busy.assignment.id);
  if (!assignment) throw new Error("Missing assignment");
  const sample = {
    assignment_id: assignment.id,
    run_id: t.run.id,
    runtime_key: JSON.stringify(assignment.runtime_ref),
    session_id:
      assignment.runtime_ref?.agent_session_id ??
      assignment.session_ref ??
      "fixture-session",
    updated_at: f.clock.now(),
    source: "codex:session_metadata",
    stale_after_ms: 600_000,
  };
  const dispatcher = new Dispatcher({
    ...options,
    inactiveCancelAfterMs: 60 * 60_000,
    harnessActivity: () => sample,
  });
  await dispatcher.tick();
  expect(f.state().events.filter((e) => e.type === "run_inactive")).toEqual([]);
  expect(runtime.release).not.toHaveBeenCalled();
  f.advance(600_001);
  // The same cached sample must expire even if the reader has stopped.
  await dispatcher.tick();
  expect(f.state().events).toContainEqual(
    expect.objectContaining({
      type: "run_inactive",
      payload: expect.objectContaining({ activity_source: "活动来源缺失" }),
    }),
  );
});

test.each(["total", "resource"])(
  "C-497 project %s ceilings constrain automatic and explicit starts without charging other projects",
  async (kind) => {
    const busy = f.create();
    for (const item of [busy.item, target.item])
      requireCapabilities(item, ["godot"]);
    f.session(busy.assignment, false);
    const limits = {
      runLimit: () => 4,
      resourceLimits: () => new Map([["godot", 3]]),
      projectQuota: () =>
        kind === "total"
          ? { limit: 1, resources: new Map<string, number>() }
          : { resources: new Map([["godot", 1]]) },
    };
    const other = "other-project";
    f.store.createProject({ id: other });
    f.store.uow.read((tx) => {
      const capacity = runCapacitySnapshot(
        f.store,
        tx,
        limits.resourceLimits,
        limits.projectQuota,
      );
      expect(
        capacity.withinProjectQuota(f.project, target.assignment, ["godot"]),
      ).toBe(false);
      expect(
        capacity.withinProjectQuota(other, target.assignment, ["godot"]),
      ).toBe(true);
      expect(
        capacity.withinProjectQuota(
          f.project,
          { ...target.assignment, machine_id: "other-worker" },
          ["godot"],
        ),
      ).toBe(true);
    });
    comment();
    const dispatcher = new Dispatcher({ ...options, ...limits });
    await dispatcher.tick();
    const run = f
      .state()
      .runs.find(
        (r) =>
          r.assignment_id === target.assignment.id && r.status === "queued",
      );
    if (!run) throw new Error("Expected quota wait");
    expect(runtime.wake).not.toHaveBeenCalled();
    await expect(
      launchRun(
        {
          store: f.store,
          runtime,
          launch: { config: { gateways: {}, profiles: {} }, secrets: {} },
          mcpUrl: "http://localhost/mcp",
          dataDir: f.dataDir,
          ...limits,
        },
        {
          project: f.project,
          assignment_id: target.assignment.id,
          run,
          actor: { kind: "human", project_id: f.project },
          reuse_session: true,
        },
      ),
    ).rejects.toBeInstanceOf(RunCapacityDeferred);
    finish(busy.assignment);
    await dispatcher.tick();
    expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
      "dispatched",
    );
  },
);

test.each(["mount", "memory"])(
  "C-497 failed %s preflight never publishes a wake and the same run proceeds after recovery",
  async (name) => {
    requireCapabilities(target.item, ["godot"]);
    await writeFile(
      join(f.dataDir, "run-capacity.yaml"),
      JSON.stringify({
        machines: {
          local: {
            resources: { godot: 1 },
            resource_policies: {
              godot: { checks: { [name]: ["/test/check"] } },
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const { loadRunCapacityConfig, MachineLeases } = await import(
      "@cardigan/host"
    );
    const cfg = await loadRunCapacityConfig({ configDir: f.dataDir });
    let pass = false;
    const leases = new MachineLeases(f.store, cfg, async () =>
      pass ? "local" : undefined,
    );
    const dispatcher = new Dispatcher({
      ...options,
      leases,
      resourceLimits: cfg.resourcesForMachine,
    });
    comment();
    await dispatcher.tick();
    const [wait] = readRunQueue(f.store);
    expect(wait?.assignment_id).toBe(target.assignment.id);
    expect(runtime.wake).not.toHaveBeenCalled();
    const view = executionCapacity(
      f.store,
      undefined,
      undefined,
      undefined,
      undefined,
      cfg.resourcesForMachine,
      f.project,
      f.clock.now(),
    );
    expect(view.agents[0]?.lease_details?.join()).toContain(name);
    pass = true;
    await dispatcher.tick();
    expect(f.state().runs.find((r) => r.id === wait?.run_id)?.status).toBe(
      "dispatched",
    );
  },
);

test("C-497 another project reservation blocks a live wake, hard deadline unblocks the same queued Run", async () => {
  requireCapabilities(target.item, ["godot"]);
  f.store.createProject({ id: "priority" });
  await writeFile(
    join(f.dataDir, "run-capacity.yaml"),
    JSON.stringify({ machines: { local: { resources: { godot: 1 } } } }),
    { mode: 0o600 },
  );
  const { loadRunCapacityConfig, MachineLeases } = await import(
    "@cardigan/host"
  );
  const cfg = await loadRunCapacityConfig({ configDir: f.dataDir });
  const leases = new MachineLeases(f.store, cfg, vi.fn());
  const at = f.clock.now(),
    end = new Date(Date.parse(at) + 60_000).toISOString();
  await leases.reserve(
    { kind: "human", project_id: "priority" },
    "local",
    "godot",
    at,
    end,
    () => at,
  );
  const d = new Dispatcher({
    ...options,
    leases,
    resourceLimits: cfg.resourcesForMachine,
  });
  comment();
  await d.tick();
  const [wait] = readRunQueue(f.store);
  expect(wait?.assignment_id).toBe(target.assignment.id);
  expect(runtime.wake).not.toHaveBeenCalled();
  f.advance(60_000);
  await d.tick();
  expect(f.state().runs.find((r) => r.id === wait?.run_id)?.status).toBe(
    "dispatched",
  );
});

test("C-497 a bound admission replaces a legacy live session and passes only that owner generation to start", async () => {
  requireCapabilities(target.item, ["fixture"]);
  await writeFile(
    join(f.dataDir, "run-capacity.yaml"),
    JSON.stringify({
      machines: {
        local: {
          resources: { fixture: 1 },
          resource_policies: {
            fixture: {
              bindings: {
                [f.project]: {
                  adb_port: 17234,
                  device: "synthetic",
                  release: ["/test/inspect"],
                },
                other: { adb_port: 17345, release: ["/test/inspect"] },
              },
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  const { loadRunCapacityConfig, MachineLeases } = await import(
    "@cardigan/host"
  );
  const cfg = await loadRunCapacityConfig({ configDir: f.dataDir });
  const leases = new MachineLeases(f.store, cfg, async () => "local");
  comment();
  await new Dispatcher({
    ...options,
    leases,
    resourceLimits: cfg.resourcesForMachine,
  }).tick();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(options.startRun).toHaveBeenCalledWith(
    expect.objectContaining({
      replacement: expect.objectContaining({
        previous: target.assignment.runtime_ref ?? expect.anything(),
      }),
      resourceAccess: {
        target: "local",
        bindings: [
          {
            generation: expect.any(String),
            key: "fixture",
            device: "synthetic",
            port: 17234,
          },
        ],
      },
    }),
  );
});

test("C-497 priority project takes the next free slot ahead of an earlier borrower, without preempting it", async () => {
  const other = secondProject();
  other.comment();
  f.advance(1000);
  comment();
  const busy = f.create();
  f.session(busy.assignment, false);
  await writeFile(
    join(f.dataDir, "run-capacity.yaml"),
    JSON.stringify({
      machines: { local: { limit: 1, preferred_project: f.project } },
    }),
    { mode: 0o600 },
  );
  const { loadRunCapacityConfig, MachineLeases } = await import(
    "@cardigan/host"
  );
  const cfg = await loadRunCapacityConfig({ configDir: f.dataDir });
  const d = new Dispatcher({
    ...options,
    leases: new MachineLeases(f.store, cfg, vi.fn()),
    runLimit: cfg.forMachine,
  });
  await d.tick();
  expect(readRunQueue(f.store)).toHaveLength(2);
  expect(runtime.wake).not.toHaveBeenCalled();
  finish(busy.assignment);
  await d.tick();
  expect(readRunQueue(f.store).map((r) => r.project_id)).toEqual([
    other.project,
  ]);
  expect(runtime.wake).toHaveBeenCalledOnce();
});

test.each(["preparation", "backoff", "send slot"])(
  "C-497 a lost mount during %s does not publish or consume retries while waiting",
  async (stage) => {
    requireCapabilities(target.item, ["godot"]);
    await writeFile(
      join(f.dataDir, "run-capacity.yaml"),
      JSON.stringify({
        machines: {
          local: {
            resources: { godot: 1 },
            resource_policies: {
              godot: { checks: { mount: ["/test/check"] } },
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const { loadRunCapacityConfig, MachineLeases } = await import(
      "@cardigan/host"
    );
    const cfg = await loadRunCapacityConfig({ configDir: f.dataDir });
    let mounted = true,
      breakAtBoundary = true,
      sends = 0;
    const leases = new MachineLeases(f.store, cfg, async () =>
      mounted ? "local" : undefined,
    );
    vi.mocked(runtime.wake).mockImplementation(async (_ref, _msg, opts) => {
      if (stage === "send slot" && breakAtBoundary) mounted = false;
      if (opts?.resource_preflight && !(await opts.resource_preflight()))
        return { ok: true, value: { sent: false, withdrawn: true } };
      if (opts?.before_send && !opts.before_send())
        return { ok: true, value: { sent: false, withdrawn: true } };
      if (stage === "backoff" && breakAtBoundary)
        return {
          ok: false,
          error: { code: "runtime_timeout", message: "synthetic" },
        };
      sends++;
      return { ok: true, value: { sent: true } };
    });
    const d = new Dispatcher({
      ...options,
      leases,
      resourceLimits: cfg.resourcesForMachine,
      deliveryRetryBaseMs: 100,
      beforeWake: async () => {
        if (stage === "preparation" && breakAtBoundary) mounted = false;
        return undefined;
      },
    });
    comment();
    await d.tick();
    if (stage === "backoff") {
      mounted = false;
      f.advance(100);
      await d.tick();
    }
    expect(sends).toBe(0);
    const waits = () =>
      f.store.database
        .prepare(
          "SELECT run_id,reason FROM machine_resource_waits WHERE project=?",
        )
        .all(f.project);
    expect(waits()).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("mount") }),
    ]);
    const id = waits()[0]?.run_id;
    // Do not time out an explicitly withheld send during a long outage.
    f.advance(600_000);
    await d.tick();
    expect(sends).toBe(0);
    breakAtBoundary = false;
    mounted = true;
    await d.tick();
    expect(sends).toBe(1);
    expect(f.state().runs.find((r) => r.id === id)?.status).toBe("dispatched");
  },
);
