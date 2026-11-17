import { expect, test } from "vitest";
import {
  cardCriticalPathLengths,
  cardDependencyComplete,
  unmetCardDependencies,
} from "../card-dependencies.js";
import type { Card, Event } from "../entities.js";
import { mergePlan, recordMergeResult } from "../index.js";
import { compareDispatchOrder } from "../run-capacity.js";
import { refreshCardDependencies } from "./card-dependencies.js";
import type { CommandState } from "./core.js";
import { prepareDelivery } from "./delivery.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { createCard, updateCard } from "./pm.js";
import { markCardDone } from "./templates.js";
import {
  actor,
  apply,
  card,
  fixture,
  human,
  id,
  now,
  ports,
  subject,
  value,
} from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
const c1 = id("card", 1),
  c2 = id("card", 2),
  c3 = id("card", 3);
function event(
  cardId = c2,
  type = "card_merged",
  caller: Event["actor"] = system,
): Event {
  return {
    id: ports().ids.nextEventId(),
    seq: 1,
    card_id: cardId,
    actor: caller,
    type,
    payload: {},
    created_at: now,
  };
}
function state(cards: readonly Card[] = [card(), card(2)]): CommandState {
  return { ...fixture(), cards };
}
const before = (): Card => ({ ...card(2), status: "done", resolution: "done" });

test("same-project graph rejects self, missing, foreign and cycles with the complete path; clear is explicit", () => {
  const io = ports();
  let s = state([
    card(),
    card(2),
    card(3),
    { ...card(4), project_id: "foreign" },
  ]);
  for (const dependency of [c1, id("card", 4), id("card", 999)])
    expect(
      updateCard(s, human, { card_id: c1, depends_on_cards: [dependency] }, io)
        .ok,
    ).toBe(false);
  s = apply(
    s,
    value(
      updateCard(s, human, { card_id: c1, depends_on_cards: [c2, c2] }, io),
    ),
  );
  s = apply(
    s,
    value(updateCard(s, human, { card_id: c2, depends_on_cards: [c3] }, io)),
  );
  expect(
    updateCard(s, human, { card_id: c3, depends_on_cards: [c1] }, io),
  ).toMatchObject({
    ok: false,
    error: { message: "依赖成环：C-3 → C-1 → C-2 → C-3" },
  });
  expect(s.cards.find((c) => c.id === c1)?.depends_on_cards).toEqual([c2]);
  expect(
    value(updateCard(s, human, { card_id: c1, depends_on_cards: [] }, io)).data
      .depends_on_cards,
  ).toEqual([]);
});

test("creation preserves legacy scheduling and dependency creation defaults to an unscheduled backlog", () => {
  const params = {
    title: "Dependent",
    goal: "Build",
    source: { kind: "quote" as const, text: "Build" },
    repo: "fixture",
    base_branch: "main",
    acceptance_criteria: ["passes"],
  };
  expect(value(createCard(state(), human, params, ports())).data.status).toBe(
    "todo",
  );
  const created = value(
    createCard(state(), human, { ...params, depends_on_cards: [c1] }, ports()),
  ).data;
  expect(created).toMatchObject({ status: "backlog", depends_on_cards: [c1] });
  expect(created.wait_for_dependencies).toBeUndefined();
  expect(created.early_start).toBeUndefined();
});

test("early-start authority keeps project scope, current identity, reason and hold fences", () => {
  const s = state([
    { ...card(), status: "backlog", depends_on_cards: [c2] },
    card(2),
  ]);
  const p = {
    card_id: c1,
    early_start: true,
    dependency_reason: "Parallel implementation",
    status: "todo" as const,
  };
  for (const caller of [actor(), actor(3, "pm"), system])
    expect(updateCard(s, caller, p, ports()).ok).toBe(false);
  for (const caller of [human, actor(4, "pm")]) {
    const effect = value(updateCard(s, caller, p, ports()));
    expect(effect.data.early_start).toMatchObject({
      reason: p.dependency_reason,
      set_at: now,
    });
    expect(effect.events[0]?.payload).toMatchObject({
      dependency_reason: p.dependency_reason,
    });
    expect(
      value(
        updateCard(
          apply(s, effect),
          caller,
          { card_id: c1, early_start: false, dependency_reason: "Wait again" },
          ports(),
        ),
      ).data.early_start,
    ).toBeUndefined();
  }
  expect(
    updateCard(s, human, { ...p, dependency_reason: " " }, ports()).ok,
  ).toBe(false);
  expect(
    updateCard(s, human, { card_id: c1, status: "todo" }, ports()).ok,
  ).toBe(false);
  for (const status of ["done", "cancelled"] as const)
    expect(
      updateCard(state([{ ...card(), status }]), human, p, ports()).ok,
    ).toBe(false);
  expect(
    updateCard(
      state([
        {
          ...card(),
          hold: {
            reason: "Wait",
            resume_condition: "Ready",
            set_by: "human",
            set_at: now,
          },
        },
      ]),
      human,
      p,
      ports(),
    ).ok,
  ).toBe(false);
  expect(
    updateCard(
      {
        ...s,
        assignments: s.assignments.map((a) => ({ ...a, status: "suspended" })),
      },
      actor(4, "pm"),
      p,
      ports(),
    ).ok,
  ).toBe(false);
});

test("normal completion needs fixed-template evidence and never accepts cancelled/replaced cards", () => {
  const s = { ...state([before()]), events: [event()] };
  expect(cardDependencyComplete(s, before())).toBe(true);
  expect(
    cardDependencyComplete(
      { ...s, events: [event(c2, "card_merged", human)] },
      before(),
    ),
  ).toBe(false);
  expect(cardDependencyComplete({ ...s, events: [] }, before())).toBe(false);
  expect(
    cardDependencyComplete(s, { ...before(), template_version: 999 }),
  ).toBe(false);
  for (const resolution of ["superseded", "duplicate", "wontdo"] as const)
    expect(cardDependencyComplete(s, { ...before(), resolution })).toBe(false);
  expect(cardDependencyComplete(s, { ...before(), status: "cancelled" })).toBe(
    false,
  );
  const manual = {
    ...before(),
    template: "general",
    merge_policy: "none" as const,
  };
  expect(
    cardDependencyComplete(
      { ...s, events: [event(c2, "card_marked_done", human)] },
      manual,
    ),
  ).toBe(true);
  expect(cardDependencyComplete(s, manual)).toBe(false);
});

test("release is atomic and replay-safe, respecting explicit wait, hold, manual schedule and priority", () => {
  const waiting: Card = {
    ...card(),
    status: "backlog",
    priority: 3,
    wait_for_dependencies: true,
    depends_on_cards: [c2],
  };
  let s: CommandState = { ...state([waiting, before()]), events: [event()] };
  const io = ports();
  const effect = value(refreshCardDependencies(s, system, io));
  expect(effect.changes).toHaveLength(1);
  expect(effect.events.map((e) => e.type)).toEqual([
    "card_dependencies_released",
  ]);
  expect(effect.timeline).toHaveLength(1);
  expect(apply(s, effect).cards.find((c) => c.id === c1)).toMatchObject({
    status: "todo",
    priority: 3,
    wait_for_dependencies: false,
  });
  expect(
    value(refreshCardDependencies(apply(s, effect), system, io)).events,
  ).toEqual([]);
  for (const patch of [
    { wait_for_dependencies: false },
    { status: "todo" as const },
    { status: "cancelled" as const },
    {
      hold: {
        reason: "Wait",
        resume_condition: "Manual",
        set_by: "human" as const,
        set_at: now,
      },
    },
  ])
    expect(
      value(
        refreshCardDependencies(
          { ...s, cards: [{ ...waiting, ...patch }, before()] },
          system,
          io,
        ),
      ).changes,
    ).toEqual([]);
  s = apply(
    s,
    value(updateCard(s, human, { card_id: c1, status: "backlog" }, io)),
  );
  expect(value(refreshCardDependencies(s, system, io)).changes).toEqual([]);
});

test("partial completion, cancellation and replacement keep edges and send a durable PM notice; early start gets one sync reminder", () => {
  const waiting: Card = {
    ...card(),
    status: "backlog",
    wait_for_dependencies: true,
    depends_on_cards: [c2, c3],
  };
  const s = {
    ...state([
      waiting,
      before(),
      {
        ...card(3),
        status: "cancelled",
        resolution: "superseded",
        superseded_by: c2,
      },
    ]),
    events: [event()],
  };
  const io = ports();
  expect(unmetCardDependencies(s, waiting)).toEqual([c3]);
  const effect = value(refreshCardDependencies(s, system, io));
  expect(effect.changes).toEqual([]);
  expect(effect.events.map((e) => e.type)).toEqual([
    "card_dependencies_attention",
  ]);
  expect(
    value(refreshCardDependencies(apply(s, effect), system, io)).events,
  ).toEqual([]);
  const early = {
    ...waiting,
    status: "in_progress" as const,
    depends_on_cards: [c2],
    early_start: { reason: "Parallel", set_by: "human" as const, set_at: now },
  };
  const ready = { ...s, cards: [early, before()] };
  const notice = value(refreshCardDependencies(ready, system, io));
  expect(notice.events.map((e) => e.type)).toEqual(["card_dependencies_ready"]);
  expect(notice.changes).toEqual([]);
  expect(
    value(refreshCardDependencies(apply(ready, notice), system, io)).events,
  ).toEqual([]);
});

test("author preparation and human completion reject unresolved prerequisites through real entry points", async () => {
  const s = state([
    {
      ...card(),
      depends_on_cards: [c2],
      early_start: { reason: "Parallel", set_by: "human", set_at: now },
    },
    card(2),
  ]);
  const result = await prepareDelivery(
    s,
    actor(),
    {
      work_item_id: id("work_item", 1),
      kind: "card_completion",
      summary: "Ready",
      subject,
      requested_verifiers: [id("work_item", 3)],
      plain_summary: { changed: "改动", impact: "生效", risk: "无" },
    },
    { verify: async () => ({ ok: true, value: [] }) },
  );
  expect(result).toMatchObject({
    ok: false,
    error: { message: "前置卡尚未正常完成：C-2" },
  });
  const manual = {
    ...s,
    cards: s.cards.map((c) =>
      c.id === c1
        ? { ...c, template: "general", merge_policy: "none" as const }
        : c,
    ),
    work_items: [],
  };
  expect(
    markCardDone(manual, human, { card_id: c1, result: "Done" }, ports()),
  ).toMatchObject({ ok: false, error: { message: "前置卡尚未正常完成：C-2" } });
});

test("an accepted old completion cannot publish after a new dependency is added", async () => {
  const f = mergeFixture("auto");
  const { completion } = await f.accept();
  const predecessor = f.commit(
    createCard(
      f.state,
      human,
      {
        title: "Before",
        goal: "Before",
        source: { kind: "quote", text: "Before" },
        template: "general",
      },
      f.io,
    ),
  );
  f.commit(
    updateCard(
      f.state,
      human,
      { card_id: f.card.id, depends_on_cards: [predecessor.id] },
      f.io,
    ),
  );
  expect(mergePlan(f.state, f.card.id)).toMatchObject({
    ok: false,
    error: { message: `前置卡尚未正常完成：${predecessor.id}` },
  });
  expect(
    recordMergeResult(
      f.state,
      system,
      {
        card_id: f.card.id,
        completion_id: completion.id,
        result: {
          kind: "merged",
          previous_sha: "a".repeat(40),
          merge_sha: "b".repeat(40),
        },
      },
      f.io,
    ).ok,
  ).toBe(false);
  f.commit(
    markCardDone(
      f.state,
      human,
      { card_id: predecessor.id, result: "Done" },
      f.io,
    ),
  );
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("longest unfinished successor path counts joins once per path and breaks only equal priority ties", () => {
  const s = state([
    card(),
    { ...card(2), depends_on_cards: [c1] },
    { ...card(3), depends_on_cards: [c1] },
    { ...card(4), depends_on_cards: [c2, c3] },
  ]);
  expect([...cardCriticalPathLengths(s).values()]).toEqual([3, 2, 2, 1]);
  const base = {
    project_id: "p",
    assignment_id: "A-1",
    created_at: now,
    trigger_event_id: "e",
    priority: 1,
  };
  expect(
    compareDispatchOrder(
      { ...base, critical_path_length: 3 },
      { ...base, critical_path_length: 2 },
    ),
  ).toBeLessThan(0);
  expect(
    compareDispatchOrder(
      { ...base, priority: 0, critical_path_length: 30 },
      { ...base, critical_path_length: 2 },
    ),
  ).toBeGreaterThan(0);
  expect(
    compareDispatchOrder(
      { ...base, critical_path_length: 2 },
      { ...base, critical_path_length: 2 },
    ),
  ).toBe(0);
});
