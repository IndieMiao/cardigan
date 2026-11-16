import {
  type CommandState,
  completeHumanAction,
  type Decision,
  prepareMergePlan,
  recordMergeCheck,
  requestHumanAction,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { mergeFixture } from "../../../../packages/domain/src/commands/merge/test-fixtures.js";
import {
  apply,
  id,
  ports,
  value,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { autoMergePauseView } from "./auto-merge-pause.js";

// A3a has not widened Decider yet; system authority is synthetic read input only.
async function setup() {
  const f = mergeFixture();
  const { completion } = await f.accept();
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
    attempt_id: "pause-check",
  };
  const system = { kind: "system" as const, project_id: f.state.project_id };
  for (const status of ["queued", "running"] as const)
    f.commit(
      recordMergeCheck(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        system,
        { ...identity, status },
        f.io,
      ),
    );
  f.commit(
    recordMergeCheck(
      { ...f.state, project_settings: { merge_gate_enabled: true } },
      system,
      {
        ...identity,
        status: "passed",
        summary: "Synthetic pass",
        log_ref: "pause-check.log",
        checks: [{ name: "test", status: "passed", exit_code: 0 }],
      },
      f.io,
    ),
  );
  const state: CommandState = {
    ...f.state,
    project_preferences: [
      {
        id: f.state.project_id,
        auto_merge_after_minutes: null,
        auto_merge_paused: true,
      },
    ],
    cards: f.state.cards.map((c) => ({ ...c, flow_version: 4 })),
    decisions: f.state.decisions.map((q) => ({
      ...q,
      decider: "system" as Decision["decider"],
    })),
  };
  return state;
}

test("A3b counts distinct current system-held cards ready for merge", async () => {
  const state = await setup();
  expect(autoMergePauseView(state)).toEqual({ paused: true, waiting_count: 1 });
  expect(
    autoMergePauseView({
      ...state,
      decisions: [...state.decisions, ...state.decisions],
    }).waiting_count,
  ).toBe(1);
  const confirmed = {
    ...state,
    decisions: state.decisions.map((q) => ({
      ...q,
      status: "resolved" as const,
      resolution: {
        option: "merge",
        resolved_by: "system" as const,
        via: "delegated" as const,
        rationale: "Synthetic",
        raw_quote: "",
        via_chain: [],
        at: "2026-11-15T00:00:00Z",
      },
    })),
  };
  expect(autoMergePauseView(confirmed).waiting_count).toBe(1);
  expect(
    autoMergePauseView({
      ...confirmed,
      decisions: confirmed.decisions.map((q) => ({
        ...q,
        decider: "human" as const,
      })),
    }).waiting_count,
  ).toBe(0);
  expect(
    autoMergePauseView({
      ...confirmed,
      decisions: confirmed.decisions.map((q) => ({
        ...q,
        resolution: { ...q.resolution, resolved_by: "human" as const },
      })),
    }).waiting_count,
  ).toBe(0);
});

test("A3b excludes other flows/projects, terminal cards, human/PM confirmations and checks", async () => {
  const state = await setup();
  for (const patch of [
    { cards: state.cards.map((c) => ({ ...c, flow_version: 3 })) },
    { cards: state.cards.map((c) => ({ ...c, project_id: "other" })) },
    { cards: state.cards.map((c) => ({ ...c, status: "done" as const })) },
    { cards: state.cards.map((c) => ({ ...c, status: "cancelled" as const })) },
    {
      decisions: state.decisions.map((q) => ({
        ...q,
        decider: "human" as const,
      })),
    },
    {
      decisions: state.decisions.map((q) => ({
        ...q,
        decider: "role:pm" as const,
      })),
    },
    {
      decisions: state.decisions.map((q) => ({
        ...q,
        human_required_reason: "Human required",
      })),
    },
    {
      decisions: state.decisions.map((q) => ({
        ...q,
        status: "superseded" as const,
      })),
    },
    { events: [] },
    { project_preferences: [] },
    {
      deliveries: state.deliveries.filter((d) => d.kind !== "card_completion"),
    },
  ])
    expect(autoMergePauseView({ ...state, ...patch }).waiting_count).toBe(0);
});

test.each([false, true])(
  "A3b excludes blocking decisions and human prerequisites until cleared (confirmed=%s)",
  async (confirmed) => {
    const initial = await setup();
    const state: CommandState = confirmed
      ? {
          ...initial,
          decisions: initial.decisions.map((q) => ({
            ...q,
            status: "resolved",
            resolution: {
              option: "merge",
              resolved_by: "system",
              via: "delegated",
              rationale: "Synthetic",
              raw_quote: "",
              via_chain: [],
              at: "2026-11-15T00:00:00Z",
            },
          })),
        }
      : initial;
    expect(autoMergePauseView(state).waiting_count).toBe(1);
    const actor = { kind: "human" as const, project_id: state.project_id };
    const q = state.decisions[0];
    if (!q?.card_id) throw new Error("Missing merge confirmation");
    const io = ports();
    const action = value(
      requestHumanAction(
        state,
        actor,
        {
          card_id: q.card_id,
          instructions: "Synthetic prerequisite",
          why_human: "Manual",
          expected_return: "Done",
          blocked_work_items: [],
          blocks_merge: true,
        },
        io,
      ),
    );
    const held = apply(state, action);
    expect(prepareMergePlan(held, q.card_id).ok).toBe(false);
    expect(autoMergePauseView(held).waiting_count).toBe(0);
    const h = held.human_actions.at(-1);
    if (!h) throw new Error("Missing human action");
    const cleared = apply(
      held,
      value(
        completeHumanAction(
          held,
          actor,
          { human_action_id: h.id, text: "Done" },
          io,
        ),
      ),
    );
    expect(autoMergePauseView(cleared).waiting_count).toBe(1);
    const blocker: Decision = {
      ...q,
      id: id("decision", 777),
      status: "open",
      trigger: "review_limit",
      blocking: true,
    };
    const blocked = { ...state, decisions: [...state.decisions, blocker] };
    expect(prepareMergePlan(blocked, q.card_id).ok).toBe(false);
    expect(autoMergePauseView(blocked).waiting_count).toBe(0);
    expect(
      autoMergePauseView({
        ...state,
        decisions: [
          ...state.decisions,
          { ...blocker, status: "resolved" as const },
        ],
      }).waiting_count,
    ).toBe(1);
    expect(
      autoMergePauseView({
        ...state,
        human_actions: held.human_actions.map((h) => ({
          ...h,
          blocks_merge: false,
        })),
      }).waiting_count,
    ).toBe(1);
  },
);
