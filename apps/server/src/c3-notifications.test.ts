import {
  type Assignment,
  acknowledgeRun,
  type CardId,
  compareDispatchOrder,
  finishRun,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { listBellAttempts, recordNotification } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { standingResolver } from "./assembly.js";
import { CANDIDATE_FEED, CandidateIndex } from "./candidate-index.js";
import { Dispatcher } from "./dispatch.js";
import { orderPmCandidates } from "./pm-notification-order.js";

let f: ReturnType<typeof recoveryFixture>, pm: Assignment;
beforeEach(() => {
  f = recoveryFixture();
  const a = f.pm();
  pm = { ...a, standing_mode: "ops" };
  f.store.uow.run((tx) => tx.assignments.put(f.project, pm));
  f.session(pm);
  f.skipEvents();
});
afterEach(() => f.close());
function note(
  card_id?: CardId,
  kind = "comment",
  type = "comment_posted",
  payload = {},
) {
  f.advance(1);
  return f.store.uow.run((tx) => {
    const event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project, card_id),
      ...(card_id ? { card_id } : {}),
      type,
      payload,
      actor: { kind: "system" as const, project_id: f.project },
      created_at: f.clock.now(),
    };
    tx.events.append(f.project, event);
    return recordNotification(f.store.database, {
      project_id: f.project,
      event_id: event.id,
      seq: event.seq,
      ...(card_id ? { card_id } : {}),
      kind,
      recipient: { kind: "pm_ops" },
      at: f.clock.now(),
    }).notification;
  });
}
function card(version: number) {
  const target = f.create();
  f.store.uow.run((tx) =>
    tx.cards.put(f.project, { ...target.card, flow_version: version }),
  );
  return target;
}
const dispatcher = () =>
  new Dispatcher({ ...f.options, standing: standingResolver(f.store) });
const sent = () =>
  listBellAttempts(f.store.database, f.project)
    .filter((a) => a.assignment_id === pm.id)
    .at(-1)?.notification_ids;
function completePm() {
  const run = f
    .state()
    .runs.filter((r) => r.assignment_id === pm.id)
    .at(-1);
  if (!run) throw new Error("Missing PM run");
  const actor = f.actorFor(pm);
  f.apply((s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p), actor);
  f.apply(
    (s, a, p) =>
      finishRun(
        s,
        a,
        { run_id: run.id, outcome: "completed", summary: "fixture" },
        p,
      ),
    actor,
  );
}

test("actual PM dispatch keeps the old first slot, then groups both urgent card events", async () => {
  const a = card(5),
    b = card(6),
    c = card(6);
  const old = note(a.card.id),
    ordinary = note(b.card.id),
    project = note();
  const urgent = note(c.card.id, "run_attention", "run_preparation_stalled");
  const sameCard = note(c.card.id);
  f.skipEvents();
  const d = dispatcher();
  await d.tick();
  expect(sent()).toEqual([old.id]);
  completePm();
  await d.tick();
  expect(new Set(sent())).toEqual(new Set([urgent.id, sameCard.id]));
  expect(
    f.store
      .listNotifications({
        project_id: f.project,
        ids: [ordinary.id, project.id],
      })
      .every((n) => n.status === "pending"),
  ).toBe(true);
  expect(
    f.store.listNotifications({
      project_id: f.project,
      ids: [urgent.id, sameCard.id],
    }),
  ).toHaveLength(2);
});

test("resolved request is audited without ACK; a result notification remains deliverable", async () => {
  const target = card(6);
  f.store.uow.run((tx) =>
    tx.human_actions.put(f.project, {
      id: "H-900" as never,
      key: "H-900",
      requested_by: "system",
      status: "done",
      blocked_work_items: [],
      instructions: "fixture",
      why_human: "fixture",
      expected_return: "fixture",
      card_id: target.card.id,
    }),
  );
  const request = note(target.card.id, "decision", "human_action_requested", {
    human_action_id: "H-900",
  });
  const result = note(target.card.id, "comment", "human_action_completed", {
    human_action_id: "H-900",
  });
  f.skipEvents();
  await dispatcher().tick();
  expect(sent()).toEqual([result.id]);
  expect(
    f.store.listNotifications({ project_id: f.project, ids: [request.id] })[0]
      ?.status,
  ).toBe("resolved");
  expect(f.state().cursors).toHaveLength(0);
  expect(
    f
      .state()
      .events.some(
        (e) =>
          e.type === "notification_resolved" &&
          (e.payload as { notification_id?: string }).notification_id ===
            request.id,
      ),
  ).toBe(true);
});

test("fresh urgency matches a full recomputation even when candidate cache is reused", () => {
  const b = card(6),
    c = card(6);
  note(b.card.id);
  note(c.card.id, "decision", "human_action_requested", {
    human_action_id: "H-900",
  });
  f.skipEvents();
  const cached = new CandidateIndex(standingResolver(f.store));
  const read = (index: CandidateIndex) =>
    f.store.uow.read((tx) => {
      const state = loadCommandState(tx, f.project);
      const queue = index.candidates(f.project, {
        changes: (cursor) =>
          f.store.changesSince(f.project, CANDIDATE_FEED, cursor),
        state: () => state,
        notifications: () =>
          f.store.listNotifications({
            project_id: f.project,
            status: "pending",
          }),
        claimed: () => new Set(),
      });
      queue.sort((a, b) => compareDispatchOrder(a.order, b.order));
      return orderPmCandidates(queue, () => state)
        .filter((c) => c.assignment.id === pm.id)
        .map((c) => c.notes[0]?.card_id);
    });
  expect(read(cached)).toEqual([c.card.id, b.card.id]);
  f.store.uow.run((tx) =>
    tx.human_actions.put(f.project, {
      id: "H-900" as never,
      key: "H-900",
      requested_by: "system",
      status: "done",
      blocked_work_items: [],
      instructions: "fixture",
      why_human: "fixture",
      expected_return: "fixture",
    }),
  );
  expect(read(cached)).toEqual(
    read(new CandidateIndex(standingResolver(f.store))),
  );
  expect(read(cached)).toEqual([b.card.id, c.card.id]);
});

test("a new urgent group arriving during runtime IO is rechecked before claim", async () => {
  const ordinaryCard = card(6),
    urgentCard = card(6);
  const ordinary = note(ordinaryCard.card.id);
  f.skipEvents();
  let urgent: ReturnType<typeof note> | undefined;
  const status = f.runtime.status;
  f.runtime.status = async (ref) => {
    if (ref.terminal_ref === f.refFor(pm).terminal_ref && !urgent) {
      urgent = note(
        urgentCard.card.id,
        "run_attention",
        "run_preparation_stalled",
      );
      f.skipEvents();
    }
    return status(ref);
  };
  const d = dispatcher();
  await d.tick();
  expect(
    f.store.listNotifications({ project_id: f.project, ids: [ordinary.id] })[0]
      ?.status,
  ).toBe("pending");
  await d.tick();
  expect(sent()).toEqual([urgent?.id]);
});
