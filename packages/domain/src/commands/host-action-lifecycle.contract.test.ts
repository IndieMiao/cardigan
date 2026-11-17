import { expect, test } from "vitest";
import type { Actor, Assignment, HumanAction } from "../entities.js";
import {
  cancelHumanAction,
  completeHumanAction,
  listNeedsYou,
  notices,
  refreshCancelledHumanActions,
  requestHumanAction,
  standingTools,
  triageHumanAction,
  updateCard,
} from "../index.js";
import type { CommandState } from "./core.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture row");
  return value;
}
const owner = actor(4, "pm");
const target = id("human_action", 1);
function setup(): CommandState {
  const state = fixture();
  return {
    ...state,
    assignments: state.assignments.map(
      (a): Assignment =>
        a.scope === "standing" && a.id === id("assignment", 4)
          ? { ...a, scope: "standing", standing_mode: "office", external: true }
          : a,
    ),
    human_actions: [
      {
        id: target,
        key: target,
        card_id: id("card", 1),
        requested_by: "human",
        instructions: "Read host evidence",
        why_human: "Host access",
        expected_return: "Evidence",
        blocked_work_items: [],
        status: "open",
        triage: "host",
        host_operator: "external",
        host_assignment_id: id("assignment", 4),
      },
    ],
  };
}
const complete = (s: CommandState, a = owner, text = "Evidence recorded") =>
  completeHumanAction(s, a, { human_action_id: target, text }, ports());
const close = (s: CommandState, a = human, reason = "No longer needed") =>
  cancelHumanAction(s, a, { human_action_id: target, reason }, ports());
const handoff = {
  human_action_id: target,
  disposition: "host" as const,
  host_operator: "external" as const,
  host_assignment_id: id("assignment", 4),
  title: "Read evidence",
  summary: "Evidence",
  why_human: "Host access",
  instructions: "Read",
  expected_outcome: "Evidence recorded",
  expected_return: "Evidence",
  rationale: "Assign external owner",
};

test("exact external Office can complete, human remains allowed, and a notice preserves the result", () => {
  const state = setup();
  const effect = value(complete(state));
  expect(effect.data).toMatchObject({
    status: "done",
    result: { text: "Evidence recorded" },
  });
  expect(effect.events).toContainEqual(
    expect.objectContaining({
      type: "human_action_completed",
      actor: owner,
      payload: expect.objectContaining({
        completed_by_host_assignment_id: "A-4",
      }),
    }),
  );
  const next = apply(state, effect);
  expect(notices(next)).toContainEqual(
    expect.objectContaining({
      kind: "human_action",
      body: "Evidence recorded",
      read: false,
    }),
  );
  expect(complete(next).ok).toBe(false);
  expect(close(next).ok).toBe(false);
  expect(complete(state, human).ok).toBe(true);
  expect(complete(state, owner, "  ").ok).toBe(false);
});

test("owner, mode, current assignment, project and role/tool permissions are all required", () => {
  const state = setup();
  const { host_assignment_id: _legacyOwner, ...unowned } = required(
    state.human_actions[0],
  );
  expect(complete({ ...state, human_actions: [unowned] }).ok).toBe(false);
  expect(complete({ ...state, human_actions: [unowned] }, human).ok).toBe(true);
  const change = (patch: Partial<HumanAction>) => ({
    ...state,
    human_actions: state.human_actions.map((h) => ({ ...h, ...patch })),
  });
  for (const patch of [
    { host_assignment_id: id("assignment", 3) },
    { triage: "human" as const },
    { host_operator: "host_ops" as const },
  ])
    expect(complete(change(patch)).ok).toBe(false);
  for (const patch of [
    { status: "released" as const },
    { status: "suspended" as const },
    { external: false },
    { standing_mode: "ops" as const },
    { role_version: 2 },
  ])
    expect(
      complete({
        ...state,
        assignments: state.assignments.map((a) =>
          a.scope === "standing" && a.id === id("assignment", 4)
            ? { ...a, ...patch }
            : a,
        ),
      }).ok,
    ).toBe(false);
  for (const a of [
    actor(),
    actor(3, "pm"),
    { ...owner, project_id: "other" },
    { ...owner, allowed_tools: [] } as Actor,
  ])
    expect(complete(state, a).ok).toBe(false);
  expect(
    complete({
      ...state,
      roles: state.roles.map((r) => ({
        ...r,
        allowed_tools: r.allowed_tools.filter(
          (t) => t !== "complete_host_action",
        ),
      })),
    }).ok,
  ).toBe(false);
  expect(
    complete({
      ...state,
      roles: [
        ...state.roles,
        { ...required(state.roles[2]), role_version: 2, status: "inactive" },
      ],
    }).ok,
  ).toBe(false);
  expect(standingTools(["complete_host_action"], "ops")).toEqual([]);
});

test("external handoff requires an explicit valid identity, audits transfers and clears ownership for other triage", () => {
  const state = setup();
  const { host_assignment_id: _owner, ...legacy } = handoff;
  expect(triageHumanAction(state, human, legacy, ports()).ok).toBe(false);
  const originalOwner = state.assignments.find((a) => a.scope === "standing");
  if (!originalOwner || originalOwner.scope !== "standing")
    throw new Error("Missing owner");
  const other: Assignment = {
    ...originalOwner,
    id: id("assignment", 5),
    scope: "standing",
    standing_mode: "office",
    external: true,
  };
  const transferred = value(
    triageHumanAction(
      { ...state, assignments: [...state.assignments, other] },
      human,
      { ...handoff, host_assignment_id: other.id },
      ports(),
    ),
  );
  expect(transferred.events[0]?.payload).toMatchObject({
    previous_host_assignment_id: "A-4",
    host_assignment_id: "A-5",
  });
  const afterTransfer = apply(
    { ...state, assignments: [...state.assignments, other] },
    transferred,
  );
  expect(complete(afterTransfer).ok).toBe(false);
  expect(complete(afterTransfer, actor(5, "pm")).ok).toBe(true);
  expect(
    triageHumanAction(
      state,
      human,
      { ...handoff, host_assignment_id: id("assignment", 1) },
      ports(),
    ).ok,
  ).toBe(false);
  const { host_operator: _operator, ...humanParams } = legacy;
  const humanHandoff = value(
    triageHumanAction(
      state,
      human,
      { ...humanParams, disposition: "human" },
      ports(),
    ),
  );
  expect(humanHandoff.data.host_assignment_id).toBeUndefined();
});

test("human close is distinct, rejects agents and blank reasons, and preserves other blockers", () => {
  const state = setup();
  for (const a of [
    owner,
    actor(),
    { kind: "system", project_id: state.project_id } as Actor,
  ])
    expect(close(state, a).ok).toBe(false);
  expect(close(state, human, "  ").ok).toBe(false);
  const io = ports();
  let held = state;
  for (let i = 0; i < 2; i++) {
    const effect = value(
      requestHumanAction(
        held,
        human,
        {
          card_id: id("card", 1),
          instructions: "Configure account",
          why_human: "Account",
          expected_return: "Ready",
          blocked_work_items: [id("work_item", 1)],
          blocks_merge: true,
          prerequisite: "external_account",
        },
        io,
      ),
    );
    held = apply(held, effect);
  }
  const first = required(
    held.human_actions.find((h) => h.blocked_work_items.length),
  );
  const cancelled = value(
    cancelHumanAction(
      held,
      human,
      { human_action_id: first.id, reason: "Duplicate" },
      io,
    ),
  );
  expect(cancelled.data).toMatchObject({
    status: "cancelled",
    cancellation: { source: "human", reason: "Duplicate", by: "human" },
  });
  expect(cancelled.data.result).toBeUndefined();
  const next = apply(held, cancelled);
  expect(next.work_items.find((w) => w.id === id("work_item", 1))?.status).toBe(
    "blocked",
  );
  const remaining = required(
    next.human_actions.find(
      (h) => h.status === "open" && h.blocked_work_items.length,
    ),
  );
  const last = value(
    cancelHumanAction(
      next,
      human,
      { human_action_id: remaining.id, reason: "Not required" },
      io,
    ),
  );
  expect(
    apply(next, last).work_items.find((w) => w.id === id("work_item", 1))
      ?.status,
  ).toBe("in_progress");
  expect(complete(apply(state, value(close(state)))).ok).toBe(false);
});

test("card cancellation and compensation preserve history, do not resume work, and reject late completion", () => {
  const state = setup();
  const original = required(state.human_actions[0]);
  const done: HumanAction = {
    ...original,
    id: id("human_action", 2),
    key: id("human_action", 2),
    status: "done",
    result: { text: "Already done", attachments: [], at: now },
  };
  const other: HumanAction = {
    ...original,
    id: id("human_action", 3),
    key: id("human_action", 3),
    card_id: id("card", 2),
  };
  const all = { ...state, human_actions: [original, done, other] };
  const effect = value(
    updateCard(
      all,
      human,
      { card_id: id("card", 1), status: "cancelled" },
      ports(),
    ),
  );
  const next = apply(all, effect);
  expect(next.human_actions.find((h) => h.id === target)).toMatchObject({
    status: "cancelled",
    instructions: original.instructions,
    cancellation: { source: "card_cancelled" },
  });
  expect(next.human_actions.filter((h) => h.id !== target)).toEqual([
    done,
    other,
  ]);
  expect(
    effect.events.filter((e) => e.type === "human_action_cancelled"),
  ).toHaveLength(1);
  expect(complete(next, human).ok).toBe(false);
  expect(complete(next).ok).toBe(false);
  expect(triageHumanAction(next, human, handoff, ports()).ok).toBe(false);
  expect(
    value(listNeedsYou(next, human)).data.human_actions.map((h) => h.id),
  ).not.toContain(target);
  const system: Actor = { kind: "system", project_id: state.project_id };
  const legacy = { ...next, human_actions: all.human_actions };
  const repaired = value(refreshCancelledHumanActions(legacy, system, ports()));
  expect(
    repaired.events.filter((e) => e.type === "human_action_cancelled"),
  ).toHaveLength(1);
  expect(
    value(
      refreshCancelledHumanActions(apply(legacy, repaired), system, ports()),
    ).events,
  ).toEqual([]);
  expect(refreshCancelledHumanActions(legacy, owner, ports()).ok).toBe(false);
});
