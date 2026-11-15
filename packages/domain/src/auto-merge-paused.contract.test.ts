import { expect, test } from "vitest";
import { mergeFixture } from "./commands/merge/test-fixtures.js";
import {
  assignment,
  human,
  id,
  machine,
  ports,
  role,
} from "./commands/test-fixtures.js";
import {
  type Actor,
  type Assignment,
  autoMergePaused,
  type CommandState,
  FLOW_VERSION_MAX,
  mergePlan,
  pmMergeBlockers,
  prepareMergePlan,
  projectPreferences,
  recordDecision,
  recordMergeCheck,
  setProjectPreferences,
  standingTools,
} from "./index.js";

/**
 * A3b: the system merge pause. Off unless the human explicitly turns
 * it on; no Agent (PM, host_ops, ...) can change it, and every change leaves a
 * project audit event.
 */
const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
const opsActor: Actor = {
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: ops.id,
  ...role("pm"),
  allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
};
const office: Assignment = {
  ...ops,
  id: id("assignment", 901),
  standing_mode: "office",
};
const officeActor: Actor = {
  ...opsActor,
  assignment_id: office.id,
  allowed_tools: standingTools(role("pm").allowed_tools, "office"),
};
const systemActor: Actor = { kind: "system", project_id: human.project_id };

function setup() {
  const empty: CommandState = {
    project_id: human.project_id,
    machines: [machine()],
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: [ops, office],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
    timeline: [],
    events: [],
  };
  return mergeFixture("confirm", 3, { state: empty, ports: ports() });
}

const audits = (state: CommandState) =>
  state.events
    .filter((e) => e.type === "project_preferences_updated")
    .map((e) => e.payload);

test("pause is off by default and only an explicit true turns it on", () => {
  const f = setup();
  expect(projectPreferences(f.state).auto_merge_paused).toBeUndefined();
  expect(autoMergePaused(projectPreferences(f.state))).toBe(false);
  expect(autoMergePaused(undefined)).toBe(false);
  const prefs = { id: human.project_id, auto_merge_after_minutes: null };
  expect(autoMergePaused({ ...prefs, auto_merge_paused: false })).toBe(false);
  expect(autoMergePaused({ ...prefs, auto_merge_paused: true })).toBe(true);
});

test("only the human toggles it, with a boolean and one audit event per change", () => {
  const f = setup();
  for (const actor of [
    opsActor,
    officeActor,
    f.actor(f.pm),
    f.actor(f.coder),
    f.actor(f.reviewer),
    systemActor,
  ]) {
    const denied = setProjectPreferences(
      f.state,
      actor,
      { auto_merge_paused: true },
      f.io,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok)
      expect(["unauthorized", "forbidden_tool"]).toContain(denied.error.code);
  }
  const invalid = setProjectPreferences(
    f.state,
    human,
    { auto_merge_paused: "on" as unknown as boolean },
    f.io,
  );
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error.code).toBe("validation_failed");

  // Setting the default explicitly is not a change.
  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: false }, f.io),
  );
  expect(audits(f.state)).toEqual([]);

  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: true }, f.io),
  );
  expect(autoMergePaused(projectPreferences(f.state))).toBe(true);
  // Repeating the current value is not a change either.
  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: true }, f.io),
  );
  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: false }, f.io),
  );
  expect(autoMergePaused(projectPreferences(f.state))).toBe(false);
  expect(audits(f.state)).toEqual([
    { old_value: false, new_value: true, preference: "auto_merge_paused" },
    { old_value: true, new_value: false, preference: "auto_merge_paused" },
  ]);
  expect(
    f.state.events
      .filter((e) => e.type === "project_preferences_updated")
      .map((e) => e.actor.kind),
  ).toEqual(["human", "human"]);
  expect(projectPreferences(f.state)).toMatchObject({
    auto_merge_after_minutes: null,
  });
});

test("A3b preserves version gate, checks and human-confirmed publication", async () => {
  const f = setup();
  const { completion } = await f.accept();
  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: true }, f.io),
  );
  expect(FLOW_VERSION_MAX).toBe(1);
  expect(prepareMergePlan(f.state, f.card.id).ok).toBe(true);
  const q = f.state.decisions.find((q) => q.trigger === "merge_confirmation");
  if (!q) throw new Error("Missing confirmation");
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "merge",
        rationale: "Approve",
        raw_quote: "Approve",
      },
      f.io,
    ),
  );
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  // Checks remain a separate gate; a pause cannot make a missing check pass.
  expect(pmMergeBlockers(f.state, q)).toContain(
    "合并闸门检查尚无结果（未开启闸门的项目须交人确认）",
  );
  expect(f.state.deliveries.find((d) => d.id === completion.id)?.status).toBe(
    "accepted",
  );
});

test("A3b pause does not stop A1 failure return in a synthetic newer flow", async () => {
  const f = setup();
  const { completion } = await f.accept();
  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: true }, f.io),
  );
  const state = (): CommandState => ({
    ...f.state,
    project_settings: { merge_gate_enabled: true },
    cards: f.state.cards.map((c) => ({ ...c, flow_version: 2 })),
  });
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
    attempt_id: "pause-a1",
  };
  for (const status of ["queued", "running"] as const)
    f.commit(
      recordMergeCheck(state(), systemActor, { ...identity, status }, f.io),
    );
  f.commit(
    recordMergeCheck(
      state(),
      systemActor,
      {
        ...identity,
        status: "failed",
        summary: "Synthetic failure",
        log_ref: "pause-a1.log",
        checks: [{ name: "test", status: "failed", exit_code: 1 }],
      },
      f.io,
    ),
  );
  expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe(
    "in_progress",
  );
  expect(f.state.deliveries.find((d) => d.id === completion.id)?.status).toBe(
    "superseded",
  );
  expect(autoMergePaused(projectPreferences(f.state))).toBe(true);
});
