import { expect, test } from "vitest";
import {
  autoConfirmMerge,
  autoMergeSchedule,
  type CommandState,
  type Decision,
  expireMergeSnoozes,
  mergePlan,
  projectPreferences,
  recordDecision,
  setCardSensitive,
  setProjectPreferences,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, id, now, value } from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
const later = (f: ReturnType<typeof mergeFixture>, minutes = 10) => ({
  ...f.io,
  clock: {
    now: () => new Date(Date.parse(now) + minutes * 60_000).toISOString(),
  },
});
async function setup() {
  const f = mergeFixture();
  await f.accept();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 10 },
      f.io,
    ),
  );
  const q = f.state.decisions[0] as Decision;
  return { f, q };
}

test("preferences default off; only this project's human can change them, with old/new audit", async () => {
  const f = mergeFixture();
  expect(projectPreferences(f.state).auto_merge_after_minutes).toBeNull();
  for (const actor of [
    system,
    f.actor(f.coder),
    { ...human, project_id: "other" },
  ])
    expect(
      setProjectPreferences(
        f.state,
        actor,
        { auto_merge_after_minutes: 10 },
        f.io,
      ).ok,
    ).toBe(false);
  for (const minutes of [0, -1, 1.5, 1441, NaN, Infinity])
    expect(
      setProjectPreferences(
        f.state,
        human,
        { auto_merge_after_minutes: minutes },
        f.io,
      ).ok,
    ).toBe(false);
  for (const minutes of [1, 1440, null]) {
    const old = projectPreferences(f.state).auto_merge_after_minutes;
    const effect = value(
      setProjectPreferences(
        f.state,
        human,
        { auto_merge_after_minutes: minutes },
        f.io,
      ),
    );
    expect(effect.events).toMatchObject([
      {
        type: "project_preferences_updated",
        actor: human,
        created_at: now,
        payload: { old_value: old, new_value: minutes },
      },
    ]);
    f.commit({ ok: true, value: effect });
  }
  expect(
    value(
      setProjectPreferences(
        f.state,
        human,
        { auto_merge_after_minutes: null },
        f.io,
      ),
    ).events,
  ).toEqual([]);
});

test("invariants 11, 13, 14: only an elapsed system confirmation is delegated, once, with authority", async () => {
  const { f, q } = await setup();
  const p = { decision_id: q.id };
  for (const actor of [
    human,
    f.actor(f.coder),
    { ...system, project_id: "other" },
  ])
    expect(autoConfirmMerge(f.state, actor, p, later(f)).ok).toBe(false);
  expect(autoConfirmMerge(f.state, system, p, later(f, 9.999)).ok).toBe(false);
  expect(
    autoConfirmMerge(f.state, system, p, {
      ...f.io,
      clock: { now: () => "invalid" },
    }).ok,
  ).toBe(false);
  const answer = f.commit(autoConfirmMerge(f.state, system, p, later(f)));
  expect(answer.resolution).toMatchObject({
    option: "merge",
    resolved_by: "system",
    via: "delegated",
    via_chain: ["system"],
    raw_quote: "超过 10 分钟无人处理，按偏好设置自动确认合并",
  });
  expect(JSON.parse(answer.resolution?.proxy_authority ?? "")).toEqual({
    source: "project_preferences.auto_merge_after_minutes",
    project_id: human.project_id,
    auto_merge_after_minutes: 10,
    waiting_since: now,
    due_at: "2026-01-01T00:10:00.000Z",
  });
  expect(f.state.timeline.at(-1)?.body).toContain("自动合并（代批）");
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  expect(autoConfirmMerge(f.state, system, p, later(f)).ok).toBe(false);
  expect(
    recordDecision(
      f.state,
      system,
      { ...p, option: "merge", rationale: "", raw_quote: "" },
      f.io,
    ).ok,
  ).toBe(false);
});

test("invariants 11, 13, 14: every failed precondition rejects without partial effects", async () => {
  const { f, q } = await setup();
  const work = f.state.work_items[0];
  if (!work) throw new Error("Missing work item");
  const changeDecision = (change: Partial<Decision>): CommandState => ({
    ...f.state,
    decisions: [{ ...q, ...change } as Decision],
  });
  const variants: CommandState[] = [
    { ...f.state, project_preferences: [] },
    {
      ...f.state,
      project_preferences: [
        { id: human.project_id, auto_merge_after_minutes: null },
      ],
    },
    {
      ...f.state,
      project_preferences: [
        { id: human.project_id, auto_merge_after_minutes: 0 },
      ],
    },
    {
      ...f.state,
      project_preferences: [{ id: "other", auto_merge_after_minutes: 1 }],
    },
    {
      ...f.state,
      cards: f.state.cards.map((c) => ({ ...c, status: "in_progress" })),
    },
    {
      ...f.state,
      cards: f.state.cards.map((c) => ({ ...c, merge_policy: "auto" })),
    },
    { ...f.state, deliveries: [] },
    { ...f.state, events: [] },
    ...(
      ["resolved", "provisional", "withdrawn", "revoked", "superseded"] as const
    ).map((status) => changeDecision({ status })),
    ...(["spending", "permission", "account", "data_deletion"] as const).map(
      (category) => changeDecision({ category }),
    ),
    changeDecision({ trigger: "completion_review" }),
    changeDecision({ decider: "role:pm" }),
    changeDecision({
      kind: "approve",
      target: { delivery_id: id("delivery", 999) },
    }),
    changeDecision({ options: [] }),
    { ...f.state, decisions: [q, { ...q, id: id("decision", 99) }] },
  ];
  for (const state of variants) {
    expect(
      autoConfirmMerge(state, system, { decision_id: q.id }, later(f)),
      JSON.stringify(state.decisions),
    ).toMatchObject({ ok: false });
    expect(autoMergeSchedule(state, q.id).ok).toBe(false);
  }
  for (const status of ["open", "provisional"] as const) {
    for (const relation of [
      { card_id: f.card.id },
      { affected_cards: [f.card.id] },
      { affected_work_items: [work.id] },
    ]) {
      const blocker: Decision = {
        ...q,
        card_id: id("card", 999),
        affected_cards: [],
        affected_work_items: [],
        id: id("decision", 100),
        trigger: "review_limit",
        status,
        ...relation,
      };
      expect(
        autoConfirmMerge(
          { ...f.state, decisions: [q, blocker] },
          system,
          { decision_id: q.id },
          later(f),
        ).ok,
      ).toBe(false);
    }
  }
  // C-112: only merge-blocking human actions stop automation.
  for (const relation of [
    { card_id: f.card.id, blocked_work_items: [], blocks_merge: true },
    { blocked_work_items: [work.id] },
  ]) {
    const action = {
      id: id("human_action", 1),
      key: id("human_action", 1),
      requested_by: "human" as const,
      instructions: "Wait",
      why_human: "Manual",
      expected_return: "Done",
      status: "open" as const,
      ...relation,
    };
    expect(
      autoConfirmMerge(
        { ...f.state, human_actions: [action] },
        system,
        { decision_id: q.id },
        later(f),
      ).ok,
    ).toBe(false);
    expect(
      autoConfirmMerge(
        { ...f.state, human_actions: [{ ...action, status: "done" }] },
        system,
        { decision_id: q.id },
        later(f),
      ).ok,
    ).toBe(true);
  }
});

test.each(["hold", "request_changes"])(
  "human %s stops automation until the confirmation is requested again",
  async (option) => {
    const { f, q } = await setup();
    f.commit(
      recordDecision(
        f.state,
        human,
        {
          decision_id: q.id,
          option,
          rationale: "Wait for changes",
          raw_quote: "Wait",
        },
        f.io,
      ),
    );
    expect(
      autoConfirmMerge(f.state, system, { decision_id: q.id }, later(f)).ok,
    ).toBe(false);
    // Even a corrupted reopened status cannot erase the human's answer history.
    expect(
      autoConfirmMerge(
        { ...f.state, decisions: [q] },
        system,
        { decision_id: q.id },
        later(f),
      ).ok,
    ).toBe(false);
    if (option === "request_changes") await f.accept();
    const next =
      option === "hold"
        ? (f.commit(
            expireMergeSnoozes(f.state, system, later(f, 240)),
          )[0] as Decision)
        : (f.state.decisions.at(-1) as Decision);
    expect(
      autoConfirmMerge(
        f.state,
        system,
        { decision_id: next.id },
        later(f, option === "hold" ? 250 : 20),
      ).ok,
    ).toBe(true);
  },
);

test("changing or disabling preferences re-evaluates existing confirmations", async () => {
  const { f, q } = await setup();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 20 },
      f.io,
    ),
  );
  expect(
    autoConfirmMerge(f.state, system, { decision_id: q.id }, later(f, 10)).ok,
  ).toBe(false);
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 1 },
      f.io,
    ),
  );
  expect(
    autoConfirmMerge(f.state, system, { decision_id: q.id }, later(f, 10)).ok,
  ).toBe(true);
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: null },
      f.io,
    ),
  );
  expect(
    autoConfirmMerge(f.state, system, { decision_id: q.id }, later(f, 100)).ok,
  ).toBe(false);
});

// C-69: unmarking a sensitive card restarts the timeout at the last unmark.
const at = (minutes: number) =>
  new Date(Date.parse(now) + minutes * 60_000).toISOString();
function flag(
  f: ReturnType<typeof mergeFixture>,
  sensitive: boolean,
  minutes: number,
) {
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive },
      later(f, minutes),
    ),
  );
}
const schedule = (state: CommandState, q: Decision) =>
  value(autoMergeSchedule(state, q.id));

test("C-69: after unmarking, the timeout counts from the unmark, so an overdue confirmation is not merged at once", async () => {
  const { f, q } = await setup();
  flag(f, true, 1);
  expect(f.state.decisions[0]).toMatchObject({ id: q.id, status: "open" });
  // Sensitive: never auto-merged, however long it waits.
  expect(autoMergeSchedule(f.state, q.id).ok).toBe(false);
  expect(
    autoConfirmMerge(f.state, system, { decision_id: q.id }, later(f, 60)).ok,
  ).toBe(false);
  // Unmarked at +30, long after the original +10 deadline.
  flag(f, false, 30);
  expect(schedule(f.state, q)).toMatchObject({
    minutes: 10,
    waiting_since: at(30),
    due_at: at(40),
  });
  for (const minutes of [30, 39.999])
    expect(
      autoConfirmMerge(
        f.state,
        system,
        { decision_id: q.id },
        later(f, minutes),
      ).ok,
    ).toBe(false);
  const answer = f.commit(
    autoConfirmMerge(f.state, system, { decision_id: q.id }, later(f, 40)),
  );
  expect(JSON.parse(answer.resolution?.proxy_authority ?? "")).toMatchObject({
    waiting_since: at(30),
    due_at: at(40),
  });
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("C-69: marking again and unmarking again counts from the last unmark", async () => {
  const { f, q } = await setup();
  flag(f, true, 1);
  flag(f, false, 5);
  expect(schedule(f.state, q).due_at).toBe(at(15));
  flag(f, true, 12);
  expect(autoMergeSchedule(f.state, q.id).ok).toBe(false);
  expect(
    autoConfirmMerge(f.state, system, { decision_id: q.id }, later(f, 15)).ok,
  ).toBe(false);
  flag(f, false, 20);
  expect(schedule(f.state, q)).toMatchObject({
    waiting_since: at(20),
    due_at: at(30),
  });
  expect(
    autoConfirmMerge(f.state, system, { decision_id: q.id }, later(f, 29)).ok,
  ).toBe(false);
  expect(
    autoConfirmMerge(f.state, system, { decision_id: q.id }, later(f, 30)).ok,
  ).toBe(true);
});

test("C-69: a confirmation opened while sensitive also counts from the unmark", async () => {
  const f = mergeFixture();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 10 },
      f.io,
    ),
  );
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  await f.accept();
  const q = f.state.decisions.find(
    (d) => d.trigger === "merge_confirmation",
  ) as Decision;
  expect(q).toMatchObject({ status: "open", decider: "human" });
  expect(autoMergeSchedule(f.state, q.id).ok).toBe(false);
  flag(f, false, 25);
  expect(schedule(f.state, q).due_at).toBe(at(35));
});

test("C-69: a card never marked, or unmarked before the confirmation opened, keeps the original start", async () => {
  const { f, q } = await setup();
  expect(schedule(f.state, q)).toMatchObject({
    waiting_since: now,
    due_at: at(10),
  });
  // Another card's unmark does not touch this confirmation.
  const other = {
    ...f.state,
    events: [
      ...f.state.events,
      {
        ...(f.state.events.at(-1) as (typeof f.state.events)[number]),
        id: "evt-other",
        seq: (f.state.events.at(-1)?.seq ?? 0) + 1,
        type: "card_sensitivity_changed",
        card_id: "C-999",
        payload: { card_id: "C-999", sensitive: false },
        created_at: at(5),
      },
    ],
  } as CommandState;
  expect(schedule(other, q).due_at).toBe(at(10));

  const g = mergeFixture();
  g.commit(
    setProjectPreferences(
      g.state,
      human,
      { auto_merge_after_minutes: 10 },
      g.io,
    ),
  );
  g.commit(
    setCardSensitive(
      g.state,
      human,
      { card_id: g.card.id, sensitive: true },
      g.io,
    ),
  );
  g.commit(
    setCardSensitive(
      g.state,
      human,
      { card_id: g.card.id, sensitive: false },
      g.io,
    ),
  );
  await g.accept();
  const opened = g.state.events.find((e) => e.type === "decision_requested");
  const r = g.state.decisions.find(
    (d) => d.trigger === "merge_confirmation",
  ) as Decision;
  expect(schedule(g.state, r).waiting_since).toBe(opened?.created_at);
});

test("C-69: the restarted start is derived from events, so a reloaded state agrees", async () => {
  const { f, q } = await setup();
  flag(f, true, 1);
  flag(f, false, 30);
  const reloaded = JSON.parse(JSON.stringify(f.state)) as CommandState;
  expect(schedule(reloaded, q)).toEqual(schedule(f.state, q));
  expect(schedule(reloaded, q).due_at).toBe(at(40));
  expect(
    autoConfirmMerge(reloaded, system, { decision_id: q.id }, later(f, 35)).ok,
  ).toBe(false);
});
