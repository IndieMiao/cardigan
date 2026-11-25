/**
 * C-732 contract: a human pause on an open, unheld card with waiting work
 * gets one resume question per pause. The `permission` delegation routes it to
 * PM Ops, otherwise to the human; answering `resume` ends the pause like a
 * human start, records who answered and leaves a pause without work alone.
 */
import { expect, test } from "vitest";
import type {
  Actor,
  Assignment,
  CommandEffect,
  CommandState,
  Decision,
  Event,
  Result,
} from "../index.js";
import {
  ASSIGNMENT_HOLD_RESUMED,
  HELD_RESUME_TRIGGER,
  heldPause,
  heldPauseHandler,
  pausedByHuman,
  recordDecision,
  requestHeldAssignmentResume,
  resolveDelegatedDecision,
  standingTools,
  stoppedByHuman,
  updateCard,
} from "../index.js";
import { mergeContentDecisions } from "./human-decided-merge.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const target = id("assignment", 1);
const card_id = id("card", 1);
const system: Actor = { kind: "system", project_id: human.project_id };
const later = "2026-01-01T01:00:00.000Z";

function stopEvent(n: number, hold: boolean, by: Actor = human): Event {
  return {
    id: `${"0".repeat(20)}${String(900 + n).padStart(6, "0")}` as Event["id"],
    card_id,
    seq: 900 + n,
    type: "assignment_stopped",
    actor: by,
    payload: { assignment_id: target, hold, reason: "人工暂停" },
    created_at: now,
  };
}

function setup(options: { ops?: boolean; delegated?: boolean } = {}) {
  const io = ports();
  const base = fixture();
  const { work_item_id: _w, ...pm } = assignment(4, "pm");
  const ops: Assignment = { ...pm, scope: "standing", standing_mode: "ops" };
  let state: CommandState = {
    ...base,
    assignments: [
      ...base.assignments.filter((a) => a.id !== ops.id),
      ...(options.ops === false ? [] : [ops]),
    ],
    ...(options.delegated === false
      ? {
          project_preferences: [
            {
              id: base.project_id,
              auto_merge_after_minutes: null,
              decision_delegation: { permission: false },
            },
          ],
        }
      : {}),
    events: [stopEvent(1, true)],
  };
  const pmActor: Actor = {
    kind: "assignment",
    project_id: human.project_id,
    assignment_id: ops.id,
    ...role("pm"),
    allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
  };
  function commit<T>(result: Result<CommandEffect<T>>) {
    const effect = value(result);
    state = apply(state, effect);
    return effect;
  }
  const ask = () =>
    commit(
      requestHeldAssignmentResume(
        state,
        system,
        {
          assignment_id: target,
          reason: "pending_work",
          pending_since: now,
          pending_count: 2,
        },
        io,
      ),
    ).data;
  return {
    io,
    pm: pmActor,
    commit,
    ask,
    get state() {
      return state;
    },
    set state(next) {
      state = next;
    },
  };
}

test("stop-state: a pause records who and when; the resume event ends it like a human start", () => {
  const f = setup();
  const pause = heldPause(f.state.events, target);
  expect(pause).toEqual({
    by: "human",
    at: now,
    event_id: f.state.events[0]?.id,
  });
  expect(stoppedByHuman(f.state.events, target)).toBe(true);
  const resumed: Event = {
    ...stopEvent(2, true),
    type: ASSIGNMENT_HOLD_RESUMED,
    actor: f.pm,
    payload: { assignment_id: target },
  };
  const events = [...f.state.events, resumed];
  expect(stoppedByHuman(events, target)).toBe(false);
  expect(pausedByHuman(events, target)).toBe(false);
  expect(heldPause(events, target)).toBeUndefined();
  // A managed stop is no pause, so it has no pause author.
  expect(heldPause([stopEvent(3, false)], target)).toBeUndefined();
  // A later pause is a new pause, bound to its own event.
  expect(heldPause([...events, stopEvent(4, true)], target)?.event_id).toBe(
    stopEvent(4, true).id,
  );
});

test("PM Ops gets the delegated resume question once per pause, with who and when", () => {
  const f = setup();
  expect(heldPauseHandler(f.state)).toBe("pm_ops");
  const q = f.ask() as Decision;
  expect(q).toMatchObject({
    trigger: HELD_RESUME_TRIGGER,
    assignment_id: target,
    card_id,
    category: "permission",
    decider: "role:pm",
    recommended: "resume",
    suggestion: { option: "resume" },
    held_pause: { by: "human", at: now },
    blocking: false,
  });
  expect(q.delegation_authority).toContain("permission");
  expect(q.context).toContain("人于");
  const requested = f.state.events.at(-1);
  expect(requested?.type).toBe("decision_requested");
  expect(requested?.payload).toMatchObject({
    decision_id: q.id,
    held_resume: { reason: "pending_work", paused_by: "human", paused_at: now },
  });
  // The same pause is never asked twice, answered or not.
  expect(f.ask()).toBeUndefined();
  // It is no merge-content decision of the card.
  expect(
    mergeContentDecisions(
      f.state.decisions,
      f.state.cards.find((c) => c.id === card_id) as never,
    ),
  ).toEqual([]);
});

test("without PM Ops or without the permission delegation the human gets it in Needs You", () => {
  for (const options of [{ ops: false }, { delegated: false }]) {
    const f = setup(options);
    expect(heldPauseHandler(f.state)).toBe("needs_you");
    expect(f.ask()).toMatchObject({ decider: "human" });
  }
});

test("no question without a pause, on a held or closed card, or while the terminal is still being released", () => {
  const variants: ((s: ReturnType<typeof setup>["state"]) => typeof s)[] = [
    (s) => ({ ...s, events: [] }),
    (s) => ({ ...s, events: [stopEvent(1, false)] }),
    (s) => ({
      ...s,
      cards: s.cards.map((c) =>
        c.id === card_id
          ? {
              ...c,
              hold: {
                reason: "等",
                resume_condition: "好了",
                set_by: "human" as const,
                set_at: now,
              },
            }
          : c,
      ),
    }),
    (s) => ({
      ...s,
      cards: s.cards.map((c) =>
        c.id === card_id ? { ...c, status: "done" as const } : c,
      ),
    }),
    (s) => ({
      ...s,
      assignments: s.assignments.map((a) =>
        a.id === target
          ? {
              ...a,
              runtime_ref: {
                machine_id: "local" as never,
                runtime_machine: "local",
                terminal_ref: "t1",
                agent_name: "a1",
              },
            }
          : a,
      ),
    }),
  ];
  for (const change of variants) {
    const f = setup();
    f.state = change(f.state);
    expect(f.ask()).toBeUndefined();
  }
  // Only the system raises it.
  const f = setup();
  expect(
    requestHeldAssignmentResume(
      f.state,
      f.pm,
      { assignment_id: target, reason: "pending_work" },
      f.io,
    ),
  ).toMatchObject({ ok: false });
});

test("PM Ops resumes in one call: the pause ends, the operator is recorded and the card timeline says so", () => {
  const f = setup();
  const q = f.ask() as Decision;
  const effect = f.commit(
    resolveDelegatedDecision(
      f.state,
      f.pm,
      { decision_id: q.id, option: "resume", rationale: "待办排队，恢复" },
      f.io,
    ),
  );
  const resumed = effect.events.find((e) => e.type === ASSIGNMENT_HOLD_RESUMED);
  expect(resumed).toMatchObject({
    card_id,
    actor: { kind: "assignment", assignment_id: id("assignment", 4) },
    payload: {
      assignment_id: target,
      decision_id: q.id,
      resumed_by: "assignment:A-4",
      paused_by: "human",
      paused_at: now,
    },
  });
  expect(stoppedByHuman(f.state.events, target)).toBe(false);
  expect(
    effect.timeline.find((t) => t.body.includes(`恢复了 ${target}`)),
  ).toBeDefined();
  expect(f.state.decisions.find((d) => d.id === q.id)?.status).toBe("resolved");
});

test("keep_paused keeps the pause and the question is not asked again for it", () => {
  const f = setup();
  const q = f.ask() as Decision;
  const effect = f.commit(
    resolveDelegatedDecision(
      f.state,
      f.pm,
      { decision_id: q.id, option: "keep_paused", rationale: "人要求暂停" },
      f.io,
    ),
  );
  expect(effect.events.some((e) => e.type === ASSIGNMENT_HOLD_RESUMED)).toBe(
    false,
  );
  expect(pausedByHuman(f.state.events, target)).toBe(true);
  expect(f.ask()).toBeUndefined();
  // A new pause is a new question.
  f.state = {
    ...f.state,
    events: [...f.state.events, { ...stopEvent(5, true), created_at: later }],
  };
  expect(f.ask()).toMatchObject({ held_pause: { at: later } });
});

test("the human answers in Needs You when the question is theirs", () => {
  const f = setup({ ops: false });
  const q = f.ask() as Decision;
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "resume",
        rationale: "恢复",
        raw_quote: "恢复",
        via_suggestion: true,
        suggestion_version: q.suggestion?.version ?? 0,
      },
      { ...f.io, human_confirmation: "workbench" },
    ),
  );
  expect(
    f.state.events.find((e) => e.type === ASSIGNMENT_HOLD_RESUMED)?.actor,
  ).toEqual(human);
  expect(stoppedByHuman(f.state.events, target)).toBe(false);
});

test("an answer for a pause that already ended or was replaced resumes nothing", () => {
  const f = setup();
  const q = f.ask() as Decision;
  // The human paused again (a new pause) before PM answered.
  f.state = {
    ...f.state,
    events: [...f.state.events, { ...stopEvent(6, true), created_at: later }],
  };
  const effect = f.commit(
    resolveDelegatedDecision(
      f.state,
      f.pm,
      { decision_id: q.id, option: "resume", rationale: "恢复" },
      f.io,
    ),
  );
  expect(effect.events.some((e) => e.type === ASSIGNMENT_HOLD_RESUMED)).toBe(
    false,
  );
  expect(pausedByHuman(f.state.events, target)).toBe(true);
});

test("the same pause is not resumed while its card is held", () => {
  const f = setup();
  const q = f.ask() as Decision;
  f.commit(
    updateCard(
      f.state,
      human,
      { card_id, hold: { reason: "等", resume_condition: "好了" } },
      f.io,
    ),
  );
  expect(
    resolveDelegatedDecision(
      f.state,
      f.pm,
      { decision_id: q.id, option: "resume", rationale: "恢复" },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
});

test("releasing a card hold names its paused Assignments and raises their resume question", () => {
  const f = setup();
  f.commit(
    updateCard(
      f.state,
      human,
      { card_id, hold: { reason: "等", resume_condition: "好了" } },
      f.io,
    ),
  );
  const effect = f.commit(
    updateCard(f.state, actor(4, "pm"), { card_id, hold: null }, f.io),
  );
  const released = effect.events.find((e) => e.type === "card_hold_released");
  const q = f.state.decisions.find((d) => d.trigger === HELD_RESUME_TRIGGER);
  expect(q).toBeDefined();
  expect(released?.payload).toMatchObject({
    paused_assignments: [
      {
        assignment_id: target,
        work_item_id: id("work_item", 1),
        paused_by: "human",
        paused_at: now,
        resume_decision_id: q?.id,
      },
    ],
  });
  expect(
    (released?.payload as { notice?: string } | undefined)?.notice,
  ).toContain(
    `${target}（${id("work_item", 1)}，人于 ${now} 暂停）：在 ${q?.id} 一键恢复`,
  );
  // Without a paused Assignment the release stays as before.
  const plain = setup();
  plain.state = { ...plain.state, events: [] };
  plain.commit(
    updateCard(
      plain.state,
      human,
      { card_id, hold: { reason: "等", resume_condition: "好了" } },
      plain.io,
    ),
  );
  const quiet = plain.commit(
    updateCard(plain.state, human, { card_id, hold: null }, plain.io),
  );
  expect(
    quiet.events.find((e) => e.type === "card_hold_released")?.payload,
  ).not.toHaveProperty("paused_assignments");
  expect(plain.state.decisions).toEqual([]);
});
