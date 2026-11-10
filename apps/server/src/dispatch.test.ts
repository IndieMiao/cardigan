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
} from "@cardigan/domain";
import {
  launchRun,
  RunCapacityDeferred,
  readRunQueue,
  runCapacitySnapshot,
} from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  PROJECT_EVENT_STREAM,
  Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attentionCommand } from "../../cli/src/inbox.js";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";
import { readCardList } from "./web/card-state.js";
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
    release: async () => ({ ok: true, value: undefined }),
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
test("§3.3 wake failure preserves its Run, records failure once and never silently retries", async () => {
  comment();
  vi.mocked(runtime.wake).mockResolvedValue({
    ok: false,
    error: { code: "runtime_timeout", message: "unknown delivery" },
  });
  const dispatcher = new Dispatcher(options);
  await dispatcher.tick();
  f.advance(120000);
  await dispatcher.tick();
  expect(runtime.wake).toHaveBeenCalledOnce();
  expect(f.state().runs).toHaveLength(2);
  expect(ownNotes()[0]).toMatchObject({
    status: "delivery_failed",
    attempts: 1,
  });
  expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
  expect(
    f.store.listNotifications({
      project_id: f.project,
      recipient_kind: "pm_ops",
    }),
  ).toHaveLength(1);
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
  // IDs are project-scoped; event creation time is the only scheduling priority.
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
  const emit = (type: string) =>
    f.store.uow.run((tx) =>
      tx.events.append(other.project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(other.project, other.card.id),
        card_id: other.card.id,
        type,
        actor: { kind: "system", project_id: other.project },
        created_at: f.clock.now(),
        payload: {
          attempt_id: "merge-test",
          status: type === "merge_check_started" ? "running" : "passed",
        },
      }),
    );
  emit("merge_check_started");
  comment();
  const dispatcher = new Dispatcher({ ...options, runLimit: () => 2 });
  await dispatcher.tick();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(readRunQueue(f.store)[0]?.ahead).toBe(0);
  emit("merge_check_finished");
  await dispatcher.tick();
  expect(runtime.wake).toHaveBeenCalledOnce();
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

test("an explicit host launch defers without provisioning and the Dispatcher resumes it without a notification", async () => {
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
        actor: { kind: "human", project_id: f.project },
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
