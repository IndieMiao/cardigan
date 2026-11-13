import { expect, test } from "vitest";
import { mergeFixture } from "./commands/merge/test-fixtures.js";
import { assignment, human, ports, role } from "./commands/test-fixtures.js";
import {
  type Actor,
  type Assignment,
  type CommandState,
  mergeRequiresHuman,
  pmMergeBlockers,
  projectPreferences,
  reviewerBrowserEnabled,
  setProjectPreferences,
  standingTools,
} from "./index.js";

/**
 * P2a-14 ⑧: the reviewer-browser gray switch. It is off unless the human
 * explicitly turns it on, and while off a UI card's merge confirmation behaves
 * exactly as before (C-86: PM Ops confirms, a human still checks screenshots).
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

function setup() {
  const empty: CommandState = {
    project_id: human.project_id,
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

test("the switch is off by default and only an explicit true turns it on", () => {
  const f = setup();
  expect(projectPreferences(f.state).enable_reviewer_browser).toBeUndefined();
  expect(reviewerBrowserEnabled(projectPreferences(f.state))).toBe(false);
  expect(reviewerBrowserEnabled(undefined)).toBe(false);
  expect(
    reviewerBrowserEnabled({
      id: human.project_id,
      auto_merge_after_minutes: null,
      enable_reviewer_browser: false,
    }),
  ).toBe(false);
  expect(
    reviewerBrowserEnabled({
      id: human.project_id,
      auto_merge_after_minutes: null,
      enable_reviewer_browser: true,
    }),
  ).toBe(true);
});

test("only the human toggles it, with a boolean and an audit event per change", () => {
  const f = setup();
  const denied = setProjectPreferences(
    f.state,
    opsActor,
    { enable_reviewer_browser: true },
    f.io,
  );
  expect(denied.ok).toBe(false);
  if (!denied.ok)
    expect(["unauthorized", "forbidden_tool"]).toContain(denied.error.code);
  const invalid = setProjectPreferences(
    f.state,
    human,
    { enable_reviewer_browser: "on" as unknown as boolean },
    f.io,
  );
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error.code).toBe("validation_failed");

  // Setting the default explicitly is not a change.
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { enable_reviewer_browser: false },
      f.io,
    ),
  );
  expect(audits(f.state)).toEqual([]);

  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { enable_reviewer_browser: true },
      f.io,
    ),
  );
  expect(reviewerBrowserEnabled(projectPreferences(f.state))).toBe(true);
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { enable_reviewer_browser: false },
      f.io,
    ),
  );
  expect(reviewerBrowserEnabled(projectPreferences(f.state))).toBe(false);
  expect(audits(f.state)).toEqual([
    {
      old_value: false,
      new_value: true,
      preference: "enable_reviewer_browser",
    },
    {
      old_value: true,
      new_value: false,
      preference: "enable_reviewer_browser",
    },
  ]);
  // Other preferences are untouched.
  expect(projectPreferences(f.state)).toMatchObject({
    auto_merge_after_minutes: null,
  });
  expect(projectPreferences(f.state).pm_merge_confirmation).toBeUndefined();
});

test("C-86 regression: with the switch off, the merge confirmation is unchanged", async () => {
  const plain = setup();
  await plain.accept();
  const off = setup();
  off.commit(
    setProjectPreferences(
      off.state,
      human,
      { enable_reviewer_browser: false },
      off.io,
    ),
  );
  await off.accept();
  const confirmation = (state: CommandState) => {
    const q = state.decisions.find((d) => d.trigger === "merge_confirmation");
    if (!q) throw new Error("Missing merge confirmation");
    return q;
  };
  const a = confirmation(plain.state);
  const b = confirmation(off.state);
  expect({ decider: b.decider, authority: b.delegation_authority }).toEqual({
    decider: a.decider,
    authority: a.delegation_authority,
  });
  expect(b.decider).toBe("role:pm");
  expect(mergeRequiresHuman(off.state, b)).toBe(
    mergeRequiresHuman(plain.state, a),
  );
  expect(mergeRequiresHuman(off.state, b)).toBe(false);
  expect(pmMergeBlockers(off.state, b)).toEqual(
    pmMergeBlockers(plain.state, a),
  );
});
