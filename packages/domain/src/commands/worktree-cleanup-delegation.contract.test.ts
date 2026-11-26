// C-747: a worktree cleanup question (keep or back up and remove a released
// worktree) follows the project's data_deletion delegation like any other
// data_deletion question: delegated to PM Ops when authorized, otherwise the
// owner's. Open owner-held ones move once delegation applies.
import { expect, test } from "vitest";
import type { Actor, Assignment, Decision } from "../entities.js";
import {
  listNeedsYou,
  notices,
  releaseAssignment,
  requestDecision,
  requestWorktreeCleanup,
  resolveDelegatedDecision,
  routeWorktreeCleanupDecisions,
  setCardSensitive,
  setProjectPreferences,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { actor, human, id, now, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const opsActor = actor(900, "pm");
const clock = { now: () => "2026-01-02T00:00:00.000Z" };
type F = ReturnType<typeof mergeFixture>;

/** A released coder worktree with local edits; optional PM Ops and delegation. */
function setup(p: { ops?: boolean; delegated?: boolean } = {}) {
  const f = mergeFixture();
  if (p.delegated)
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { decision_delegation: { data_deletion: true } },
        f.io,
      ),
    );
  const ops: Assignment = {
    id: id("assignment", 900),
    scope: "standing",
    standing_mode: "ops",
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "idle",
    machine_id: "local",
    runtime_ref: null,
    session_ref: "ops-session",
    mcp_token_id: "token-reference-ops",
    created_at: now,
  };
  if (p.ops)
    f.commit({
      ok: true,
      value: {
        data: null,
        changes: [{ collection: "assignments", entity: ops }],
        events: [],
        timeline: [],
        token_requests: [],
      },
    });
  const state = {
    ...f.state,
    assignments: [
      ...f.state.assignments.map((a) =>
        a.id === f.coder.id
          ? {
              ...a,
              machine_id: "mac-mini",
              worktree_path: `/agent/worktrees/${human.project_id}/${f.coder.id}`,
              branch: "agent/fixture",
            }
          : a,
      ),
    ],
  };
  const released = { assignment_id: f.coder.id, reason: "提交已备份" };
  f.commit(releaseAssignment(state, human, released, f.io));
  return { f, released };
}
function ask(
  f: F,
  released: { assignment_id: Assignment["id"]; reason: string },
) {
  const result = requestWorktreeCleanup(f.state, system, released, f.io);
  const effect = value(result);
  return { q: f.commit(result), effect };
}
const humanDecisions = (f: F) =>
  value(listNeedsYou(f.state, human, clock)).data.decisions.map((q) => q.id);
const pmQueue = (f: F) =>
  (
    value(listNeedsYou(f.state, opsActor, clock)).data.pm_queue?.decisions ?? []
  ).map((q) => q.id);
const current = (f: F, q: Decision) =>
  f.state.decisions.find((x) => x.id === q.id);

test("authorized: a new worktree cleanup question goes to PM, not the owner's decisions", () => {
  const { f, released } = setup({ ops: true, delegated: true });
  const { q, effect } = ask(f, released);
  expect(q).toMatchObject({
    trigger: "worktree_cleanup",
    category: "data_deletion",
    decider: "role:pm",
  });
  expect(q.delegation_authority).toContain("decision_delegation/data_deletion");
  expect(
    effect.events.find((e) => e.type === "decision_requested")?.payload,
  ).toMatchObject({ decision_id: q.id, routed_to: "role:pm" });
  expect(effect.timeline[0]?.body).toContain("已按常驻授权转给 PM");
  expect(humanDecisions(f)).not.toContain(q.id);
  expect(pmQueue(f)).toContain(q.id);
});

test.each([
  ["not authorized", { ops: true, delegated: false }],
  ["no PM Ops on duty", { ops: false, delegated: true }],
])("%s: the question stays with the owner as before", (_label, p) => {
  const { f, released } = setup(p);
  const { q } = ask(f, released);
  expect(q.decider).toBe("human");
  expect(q.delegation_authority).toBeUndefined();
  expect(humanDecisions(f)).toContain(q.id);
  // PM Ops cannot answer an owner-held one.
  if (p.ops)
    expect(
      resolveDelegatedDecision(
        f.state,
        opsActor,
        { decision_id: q.id, option: "keep", rationale: "x" },
        f.io,
      ).ok,
    ).toBe(false);
});

test("a sensitive card's cleanup stays with the owner even when data_deletion is authorized", () => {
  const { f, released } = setup({ ops: true, delegated: true });
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  expect(ask(f, released).q.decider).toBe("human");
});

test("existing open owner-held questions (raised before C-747) move to PM after deployment, once", () => {
  const { f, released } = setup({ ops: true, delegated: true });
  // A question stored before C-747: routed to the human regardless of delegation.
  const { q } = ask(f, released);
  const { delegation_authority: _authority, ...stored } = current(
    f,
    q,
  ) as Decision;
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [
        {
          collection: "decisions",
          entity: { ...stored, decider: "human" } as Decision,
        },
      ],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  expect(humanDecisions(f)).toContain(q.id);
  // Only the system (cleanup loop) runs the routing.
  expect(routeWorktreeCleanupDecisions(f.state, human, f.io).ok).toBe(false);
  const result = routeWorktreeCleanupDecisions(f.state, system, f.io);
  const effect = value(result);
  f.commit(result);
  expect(effect.data.map((x) => x.id)).toEqual([q.id]);
  expect(current(f, q)).toMatchObject({ decider: "role:pm" });
  expect(
    effect.events.find((e) => e.type === "decision_requested")?.payload,
  ).toMatchObject({ previous_decider: "human", routed_to: "role:pm" });
  expect(humanDecisions(f)).not.toContain(q.id);
  expect(pmQueue(f)).toContain(q.id);
  // Idempotent: nothing more to move.
  expect(
    value(routeWorktreeCleanupDecisions(f.state, system, f.io)),
  ).toMatchObject({ data: [], events: [] });
});

test("turning data_deletion on moves open owner-held cleanup questions to PM", () => {
  const { f, released } = setup({ ops: true, delegated: false });
  const { q } = ask(f, released);
  expect(q.decider).toBe("human");
  const result = setProjectPreferences(
    f.state,
    human,
    { decision_delegation: { data_deletion: true } },
    f.io,
  );
  const effect = value(result);
  f.commit(result);
  expect(current(f, q)?.decider).toBe("role:pm");
  expect(effect.timeline.find((t) => t.decision_id === q.id)?.body).toContain(
    "工作区清理拍板转给 PM 代拍",
  );
});

test("a question PM escalated to the owner is not pulled back", () => {
  const { f, released } = setup({ ops: true, delegated: true });
  const { q } = ask(f, released);
  f.commit(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      {
        decision_id: q.id,
        option: "keep",
        rationale: "作者可能还要回来看，请所有者定",
        escalate: true,
      },
      f.io,
    ),
  );
  expect(current(f, q)?.decider).toBe("human");
  expect(
    value(routeWorktreeCleanupDecisions(f.state, system, f.io)).data,
  ).toEqual([]);
  expect(current(f, q)?.decider).toBe("human");
});

test.each(["keep", "force_clean"])(
  "PM Ops answers %s under delegation; the owner gets a notice",
  (option) => {
    const { f, released } = setup({ ops: true, delegated: true });
    const { q } = ask(f, released);
    f.commit(
      resolveDelegatedDecision(
        f.state,
        opsActor,
        {
          decision_id: q.id,
          option,
          rationale: "C-517 已取消，提交已备份",
        },
        f.io,
      ),
    );
    expect(current(f, q)).toMatchObject({
      status: "resolved",
      resolution: { option, via: "delegated" },
    });
    const notice = notices(f.state).find((n) => n.decision_id === q.id);
    expect(notice).toMatchObject({ option, resolved_by: "pm", read: false });
    expect(notice?.body).toContain("PM 依常驻授权代拍");
    expect(notice?.body).toContain("C-517 已取消，提交已备份");
  },
);

test("other owner-held questions are not moved by the cleanup routing", () => {
  const { f, released } = setup({ ops: true, delegated: true });
  const other = f.commit(
    requestDecision(
      f.state,
      human,
      {
        category: "spending",
        kind: "choose",
        question: "提高 Actions 支出上限？",
        context: "额度用完",
        options: [
          { key: "raise", description: "提高", impact: "花钱" },
          { key: "wait", description: "等下月", impact: "检查暂停" },
        ],
        recommended: "wait",
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
        decider: "human",
        plain_summary: { changed: "额度", impact: "检查暂停", risk: "花钱" },
      },
      f.io,
    ),
  );
  expect(other.decider).toBe("human");
  ask(f, released);
  const result = routeWorktreeCleanupDecisions(f.state, system, f.io);
  expect(value(result).data.map((x) => x.id)).not.toContain(other.id);
  f.commit(result);
  expect(current(f, other)?.decider).toBe("human");
  expect(humanDecisions(f)).toContain(other.id);
});
