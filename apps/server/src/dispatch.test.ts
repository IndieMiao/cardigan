import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Assignment,
  CommandEffect,
  CommandPorts,
  CommandState,
  ProjectId,
  Result,
  Runtime,
} from "@cardigan/domain";
import {
  acknowledgeRun,
  assign,
  createCard,
  dispatchRun,
  finishRun,
  postComment,
  queueRun,
  requestDecision,
  setRunLimit,
  stopWorkItemAssignment,
  updateCard,
} from "@cardigan/domain";
import {
  acquireMergeCheckCapacity,
  executionOwner,
  launchRun,
  mergeCheckCapacityAvailable,
  RunCapacityDeferred,
  readRunQueue,
  runCapacitySnapshot,
} from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
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
  expect(vi.mocked(runtime.wake).mock.calls[0]?.[2]).toBeUndefined(); // OSC working is not a business busy flag.
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
test("§3.1 an unfinished business Run holds notifications even if Runtime reports idle", async () => {
  f.session(target.assignment, false);
  comment();
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  });
  await new Dispatcher(options).tick();
  expect(runtime.status).not.toHaveBeenCalled();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(ownNotes()[0]?.status).toBe("pending");
  expect(f.state().runs).toHaveLength(2);
});
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

test("reopened store preserves an uncertain attempt and rejects a late successful result after recovery", async () => {
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
    await expect
      .poll(() => unfinishedBellAttempts(reopened.database, f.project).length)
      .toBe(1);
    const restarted = new Dispatcher({ ...options, store: reopened });
    await restarted.tick();
    expect(ownNotes()[0]?.status).toBe("pending");
    f.advance(1001);
    await restarted.tick();
    expect(ownNotes()[0]?.status).toBe("delivery_failed");
    expect(runtime.wake).toHaveBeenCalledOnce();
    expect(f.state().runs).toHaveLength(2);
    finish();
    await sending;
    expect(ownNotes()[0]?.status).toBe("delivery_failed");
    expect(unfinishedBellAttempts(reopened.database, f.project)).toEqual([]);
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
      limit: 1,
      queued: 2,
      merge_check_slots: 0,
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

test("standing PM dispatches beyond the cap and counts against subsequent ordinary Runs", async () => {
  const busy = f.create();
  f.session(busy.assignment, false);
  const extra = f.create();
  const { work_item_id: _workItem, ...base } = extra.assignment;
  const pm: Assignment = {
    ...base,
    scope: "standing",
    role_id: "pm",
    standing_mode: "ops",
  };
  f.store.uow.run((tx) => tx.assignments.put(f.project, pm));
  f.session(pm);
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
  f.advance(1000);
  comment();
  await new Dispatcher({ ...options, runLimit: () => 1 }).tick();
  expect(
    f
      .state()
      .runs.filter((r) => r.status === "dispatched")
      .map((r) => r.assignment_id),
  ).toEqual([pm.id]);
  expect(readRunQueue(f.store).map((r) => r.assignment_id)).toEqual([
    target.assignment.id,
  ]);
  // Even a fail-closed limit must not strand a PM Office/Ops Run.
  expect(
    f.store.uow.read((tx) =>
      runCapacitySnapshot(f.store, tx).occupied.get("local"),
    ),
  ).toBe(2);
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

test("startup reservations prevent concurrent dispatcher instances from claiming the same last slot", async () => {
  const extra = f.create();
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
  const settings = { ...options, startRun, runLimit: () => 1 };
  const first = new Dispatcher(settings).tick();
  try {
    await expect.poll(() => startRun.mock.calls.length).toBe(1);
    await new Dispatcher(settings).tick();
    expect(startRun).toHaveBeenCalledOnce();
    expect(readRunQueue(f.store)[0]?.assignment_id).toBe(extra.assignment.id);
  } finally {
    release();
    await first;
  }
  expect(startRun).toHaveBeenCalledOnce();
});

test("a system host launch stays capacity-limited and the Dispatcher resumes it without a notification", async () => {
  const busy = f.create();
  f.session(busy.assignment, false);
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
        runLimit: () => 1,
      },
      {
        project: f.project,
        assignment_id: target.assignment.id,
        run,
        actor: { kind: "system", project_id: f.project },
        reuse_session: true,
      },
    ),
  ).rejects.toBeInstanceOf(RunCapacityDeferred);
  expect(runtime.status).not.toHaveBeenCalled();
  expect(readRunQueue(f.store)[0]?.run_id).toBe(run.id);
  finish(busy.assignment);
  await new Dispatcher({ ...options, runLimit: () => 1 }).tick();
  expect(runtime.wake).toHaveBeenCalledOnce();
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
    "dispatched",
  );
});

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

test("reopened capacity view releases dead or reused process owners, while keeping a live check", () => {
  const owner = executionOwner(process.pid);
  if (!owner) throw new Error("Missing process identity");
  const release = acquireMergeCheckCapacity(f.store, f.project, "live", owner);
  const stale = acquireMergeCheckCapacity(f.store, f.project, "stale", {
    ...owner,
    start: `${owner.start}-previous`,
  });
  const dead = acquireMergeCheckCapacity(f.store, f.project, "dead", {
    pid: 2147483647,
    start: "gone",
  });
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    expect(
      reopened.uow.read((tx) =>
        runCapacitySnapshot(reopened, tx).occupied.get("local"),
      ),
    ).toBe(2);
    release();
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
