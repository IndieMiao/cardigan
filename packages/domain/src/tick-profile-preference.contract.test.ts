import { expect, test } from "vitest";
import { mergeFixture } from "./commands/merge/test-fixtures.js";
import {
  assignment,
  human,
  machine,
  ports,
  role,
} from "./commands/test-fixtures.js";
import {
  type Actor,
  type Assignment,
  type CommandState,
  projectPreferences,
  setProjectPreferences,
  standingTools,
  tickProfileOn,
} from "./index.js";

/**
 * C-265: the runtime loop-timing switch. Off unless the human explicitly turns
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
const systemActor: Actor = { kind: "system", project_id: human.project_id };

function setup() {
  const empty: CommandState = {
    project_id: human.project_id,
    machines: [machine()],
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: [ops],
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

test("timing is off by default and only an explicit true turns it on", () => {
  const f = setup();
  expect(projectPreferences(f.state).tick_profile).toBeUndefined();
  expect(tickProfileOn(projectPreferences(f.state))).toBe(false);
  expect(tickProfileOn(undefined)).toBe(false);
  const prefs = { id: human.project_id, auto_merge_after_minutes: null };
  expect(tickProfileOn({ ...prefs, tick_profile: false })).toBe(false);
  expect(tickProfileOn({ ...prefs, tick_profile: true })).toBe(true);
});

test("only the human toggles it, with a boolean and one audit event per change", () => {
  const f = setup();
  for (const actor of [opsActor, systemActor]) {
    const denied = setProjectPreferences(
      f.state,
      actor,
      { tick_profile: true },
      f.io,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok)
      expect(["unauthorized", "forbidden_tool"]).toContain(denied.error.code);
  }
  const invalid = setProjectPreferences(
    f.state,
    human,
    { tick_profile: "on" as unknown as boolean },
    f.io,
  );
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error.code).toBe("validation_failed");

  // Setting the default explicitly is not a change.
  f.commit(
    setProjectPreferences(f.state, human, { tick_profile: false }, f.io),
  );
  expect(audits(f.state)).toEqual([]);

  f.commit(setProjectPreferences(f.state, human, { tick_profile: true }, f.io));
  expect(tickProfileOn(projectPreferences(f.state))).toBe(true);
  // Repeating the current value is not a change either.
  f.commit(setProjectPreferences(f.state, human, { tick_profile: true }, f.io));
  f.commit(
    setProjectPreferences(f.state, human, { tick_profile: false }, f.io),
  );
  expect(tickProfileOn(projectPreferences(f.state))).toBe(false);
  expect(audits(f.state)).toEqual([
    { old_value: false, new_value: true, preference: "tick_profile" },
    { old_value: true, new_value: false, preference: "tick_profile" },
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
