import type { Runtime } from "@cardigan/domain";
import { dispatchRun, postComment } from "@cardigan/domain";
import {
  PROJECT_EVENT_STREAM,
  Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

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

test("§6.4 a merge conflict queues a kind=fix Run for the producer", async () => {
  // Same event shape recordMergeResult emits; routing is what is under test.
  f.store.uow.run((tx) => {
    const seq = tx.ids.nextEventSequence(f.project, target.card.id);
    tx.events.append(f.project, {
      id: tx.ids.nextEventId(),
      card_id: target.card.id,
      seq,
      type: "merge_conflicted",
      actor: { kind: "system", project_id: f.project },
      payload: { work_item_id: target.item.id, run_kind: "fix" },
      created_at: f.clock.now(),
    });
  });
  await new Dispatcher(options).tick();
  expect(f.state().runs.at(-1)).toMatchObject({
    assignment_id: target.assignment.id,
    kind: "fix",
  });
});
