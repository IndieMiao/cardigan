import {
  type HumanAction,
  PRE_MERGE_CHECK_REMINDED,
  requestHumanAction,
  updateCard,
} from "@cardigan/domain";
import { afterEach, beforeEach, expect, test } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { needsYou } from "./web/read.js";

/**
 * C-179 (§7.4) with a real Store: the reminder a passed pre-merge check
 * writes is readable through get_updates, the card timeline and Needs You,
 * rings the triage owners once, and leaves the human actions open.
 */
let f: ReturnType<typeof m3Fixture>;
beforeEach(() => {
  f = m3Fixture();
});
afterEach(() => f.close());

const request = (instructions: string) =>
  f.apply(
    (s, a, p) =>
      requestHumanAction(
        s,
        a,
        {
          card_id: f.card.id,
          instructions,
          why_human: "需要人确认",
          expected_return: "结论",
          blocked_work_items: [],
          blocks_merge: true,
          prerequisite: "external_account" as const,
        },
        p,
      ),
    f.actor(f.coder),
  ).data;
const pass = (note?: string) =>
  f.apply((s, a, p) =>
    updateCard(
      s,
      a,
      {
        card_id: f.card.id,
        pre_merge_check: {
          label: "张良截图核对",
          status: "passed",
          ...(note ? { note } : {}),
        },
      },
      p,
    ),
  );

test("C-179: a passed check reminds both triage owners via get_updates, Needs You and one bell each", async () => {
  f.start(f.coder);
  await f.delivery();
  const forHuman = request("确认截图");
  const forOps = request("核对安全结论");
  // PM Ops took the second action into its triage queue.
  f.store.uow.run((tx) =>
    tx.human_actions.put(f.id, {
      ...(tx.human_actions.get(f.id, forOps.id) as HumanAction),
      triage: "pm_ops",
    }),
  );
  routeProjectEvents(f.store, f.id);
  const before = f.store.getUpdates({
    project_id: f.id,
    card_id: f.card.id,
  }).latest_seq;
  const notesBefore = f.store.listNotifications({ project_id: f.id }).length;

  pass();
  routeProjectEvents(f.store, f.id);

  const updates = f.store.getUpdates({
    project_id: f.id,
    card_id: f.card.id,
    since_seq: before,
  });
  const reminded = updates.events.filter(
    (e) => e.type === PRE_MERGE_CHECK_REMINDED,
  );
  expect(reminded).toHaveLength(1);
  const linkOf = (id: string) =>
    `#/p/${f.id}/cards/${f.card.id}?at=human-action-${id}`;
  const textOf = (id: string, title: string) =>
    `合并前核对项「张良截图核对」已通过，${id}「${title}」仍在挡合并，请确认是否可以完成`;
  const entry = updates.timeline.find((t) => t.event_seq === reminded[0]?.seq);
  expect(entry?.body.split("\n")).toEqual([
    `${textOf(forHuman.id, "确认截图")}：${linkOf(forHuman.id)}`,
    `${textOf(forOps.id, "核对安全结论")}：${linkOf(forOps.id)}`,
  ]);

  const notes = f.store
    .listNotifications({ project_id: f.id })
    .filter((n) => n.event_id === reminded[0]?.id);
  expect(notes.map((n) => n.recipient.kind).sort()).toEqual([
    "needs_you",
    "pm_ops",
  ]);

  const view = needsYou(f.state(), f.clock.now());
  const item = view.human_actions.find((h) => h.id === forHuman.id);
  expect(item?.pre_merge_check_reminder).toEqual({
    label: "张良截图核对",
    text: textOf(forHuman.id, "确认截图"),
    at: reminded[0]?.created_at,
  });

  // Routing again (e.g. after a restart) rings nobody twice; a note-only edit
  // on the same version is not a new pass.
  routeProjectEvents(f.store, f.id);
  pass("只补充备注");
  routeProjectEvents(f.store, f.id);
  expect(
    f.store
      .getUpdates({ project_id: f.id, card_id: f.card.id, since_seq: before })
      .events.filter((e) => e.type === PRE_MERGE_CHECK_REMINDED),
  ).toHaveLength(1);
  expect(f.store.listNotifications({ project_id: f.id }).length).toBe(
    notesBefore + notes.length,
  );
  // Only a reminder: both actions are still open and still hold the merge.
  expect(
    f.state().human_actions.map((h) => [h.id, h.status, h.blocks_merge]),
  ).toEqual([
    [forHuman.id, "open", true],
    [forOps.id, "open", true],
  ]);
});

test("C-179: without a merge-blocking action nothing is recorded or rung", async () => {
  f.start(f.coder);
  await f.delivery();
  routeProjectEvents(f.store, f.id);
  const before = f.store.getUpdates({
    project_id: f.id,
    card_id: f.card.id,
  }).latest_seq;
  const notesBefore = f.store.listNotifications({ project_id: f.id });
  pass();
  routeProjectEvents(f.store, f.id);
  expect(
    f.store
      .getUpdates({ project_id: f.id, card_id: f.card.id, since_seq: before })
      .events.map((e) => e.type),
  ).toEqual(["pre_merge_check_updated"]);
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .filter((n) => !notesBefore.some((b) => b.id === n.id))
      .filter((n) => n.kind === "human_action" || n.kind === "needs_you"),
  ).toEqual([]);
});
