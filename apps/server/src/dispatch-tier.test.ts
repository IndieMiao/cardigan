import type { Assignment, Delivery, Run, Runtime } from "@cardigan/domain";
import { acknowledgeRun, assign, finishRun, queueRun } from "@cardigan/domain";
import { readAttention, readRunQueue } from "@cardigan/host";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";
import { readWorkbenchQueue } from "./web/queue-state.js";
import { executionView } from "./web/read.js";

let f: ReturnType<typeof dispatchFixture>;
beforeEach(() => {
  f = dispatchFixture();
});
afterEach(() => f.close());

function product(
  created: ReturnType<typeof f.create>,
  source: Run,
  completion = false,
): Delivery {
  return f.store.uow.run((tx) => {
    const d: Delivery = {
      id: tx.ids.next(f.project, "delivery"),
      work_item_id: created.item.id,
      run_id: source.id,
      kind: completion ? "card_completion" : "code",
      summary: "Synthetic formal history",
      subject: { kind: "git_head", value: "a".repeat(40) },
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
      status: "submitted",
    };
    tx.deliveries.put(f.project, d);
    return d;
  });
}
function waiting(a: Assignment, kind: Run["kind"], completion?: Delivery) {
  const trigger = f.store.uow.run((tx) => {
    const w = tx.work_items
      .list(f.project)
      .find((w) => w.id === a.work_item_id);
    const e = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project, w?.card_id),
      ...(w ? { card_id: w.card_id } : {}),
      type: completion ? "merge_conflicted" : "comment_posted",
      actor: { kind: "system" as const, project_id: f.project },
      created_at: f.clock.now(),
      payload: completion
        ? { work_item_id: a.work_item_id, completion_id: completion.id }
        : {},
    };
    tx.events.append(f.project, e);
    return e;
  });
  const r = f.apply((s, actor, p) =>
    queueRun(
      s,
      actor,
      {
        assignment_id: a.id,
        kind,
        trigger_event_id: trigger.id,
        model: "test",
        agent_cli_version: "1",
      },
      p,
    ),
  );
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, { ...r, queue_reason: "concurrency_limit" }),
  );
  f.advance(1000);
  return r;
}

/** Synthetic records only; no host processes, production DB or background loop. */
test("C-315 all four tiers agree across admission, restart, execution and attention; one slot never preempts", async () => {
  const fresh = f.create();
  f.session(fresh.assignment);
  const followup = f.create();
  const previous = f.session(followup.assignment);
  product(followup, previous);
  const repair = f.create();
  const source = f.session(repair.assignment);
  product(repair, source);
  const completion = product(repair, source, true);
  const verify = f
    .state()
    .work_items.find(
      (w) =>
        w.card_id === followup.card.id &&
        w.target_work_item_id === followup.item.id,
    );
  if (!verify) throw new Error("Missing verification fixture");
  const reviewer = f.apply((s, a, p) =>
    assign(s, a, { work_item_id: verify.id, role_id: "reviewer" }, p),
  );
  f.session(reviewer);
  f.store.uow.run((tx) => {
    tx.cards.put(f.project, { ...fresh.card, priority: 3 });
    tx.cards.put(f.project, { ...repair.card, priority: -1 });
  });
  const runs = [
    waiting(fresh.assignment, "initial"),
    waiting(followup.assignment, "followup"),
    waiting(reviewer, "initial"),
    waiting(repair.assignment, "fix", completion),
  ];
  for (const card_id of [undefined, ...f.state().cards.map((c) => c.id)])
    f.store.advanceRouterCursor(
      f.project,
      card_id ?? PROJECT_EVENT_STREAM,
      f.store.getUpdates({
        project_id: f.project,
        ...(card_id ? { card_id } : {}),
      }).latest_seq,
    );
  const expected = [...runs].reverse().map((r) => r.id);
  const queue = readRunQueue(f.store);
  expect(queue.map((r) => r.run_id)).toEqual(expected);
  expect(queue.map((r) => r.dispatch_tier)).toEqual([1, 2, 3, 4]);
  expect(f.store.uow.read((tx) => readWorkbenchQueue(f.store, tx))).toEqual(
    queue,
  );
  expect(readAttention(f.store, f.project, f.clock.now()).queued).toEqual(
    queue,
  );
  const view = executionView(f.state(), f.clock.now(), [], queue);
  for (const r of view.runs) {
    const q = queue.find((q) => q.run_id === r.id);
    if (q)
      expect(r).toMatchObject({
        queue_ahead: q.ahead,
        dispatch_tier: q.dispatch_tier,
        dispatch_reason: q.dispatch_reason,
        queue_order: q,
      });
  }
  const runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
  } as unknown as Runtime;
  const options = {
    store: f.store,
    runtime,
    clock: f.clock,
    runLimit: () => 1,
    snapshot: async () => ({ model: "test", agent_cli_version: "1" }),
  };
  const dispatcher = new Dispatcher(options);
  await dispatcher.tick();
  expect(f.state().runs.find((r) => r.id === expected[0])?.status).toBe(
    "dispatched",
  );
  await new Dispatcher(options).tick();
  expect(runtime.wake).toHaveBeenCalledTimes(1);
  expect(readRunQueue(f.store).map((r) => r.run_id)).toEqual(expected.slice(1));
  const repairRun = runs[3];
  if (!repairRun) throw new Error("Missing repair Run");
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: repairRun.id }, p),
    f.actorFor(repair.assignment),
  );
  f.apply(
    (s, a, p) =>
      finishRun(
        s,
        a,
        { run_id: repairRun.id, outcome: "completed", summary: "done" },
        p,
      ),
    f.actorFor(repair.assignment),
  );
  await new Dispatcher(options).tick();
  expect(f.state().runs.find((r) => r.id === expected[1])?.status).toBe(
    "dispatched",
  );
  expect(runtime.wake).toHaveBeenCalledTimes(2);
});
