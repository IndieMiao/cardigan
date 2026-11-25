import { expect, test } from "vitest";
import {
  type Actor,
  type CommandState,
  commandEventHistory,
  eventsOfType,
  listNeedsYou,
  projectSnapshot,
  referenceProjectSnapshot,
  referenceReadState,
  verificationActivity,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";

/** Same shape as loadCommandState: telemetry only in the journal. */
const split = (state: CommandState): CommandState => ({
  ...state,
  events: commandEventHistory([state.events]),
});

test("C-643: project_snapshot shows a started review as running from command state", async () => {
  const f = mergeFixture();
  await f.deliver();
  f.start(f.reviewer);
  const item = f.state.work_items.find((w) => w.id === f.reviewer.work_item_id);
  if (!item) throw new Error("missing review item");
  const state = split(f.state);
  expect(eventsOfType(state.events, "run_started").length).toBeGreaterThan(0);
  // The scoped read view keeps the journal.
  const view = referenceReadState(state, f.reviewer);
  expect(eventsOfType(view.events, "run_started")).toEqual(
    eventsOfType(referenceReadState(f.state, f.reviewer).events, "run_started"),
  );
  expect(verificationActivity(item, view)?.label).toBe("正在审核");
  const actor = f.actor(f.reviewer);
  const snapshot = (s: CommandState) => {
    const result = referenceProjectSnapshot(s, actor);
    if (!result.ok) throw result.error;
    return result.value.data;
  };
  // The whole snapshot equals the one built from the complete plain history.
  expect(snapshot(state)).toEqual(snapshot(f.state));
  expect(JSON.stringify(snapshot(state))).toContain("正在审核");
});

test("C-643: PM project views match the complete plain history", async () => {
  const f = mergeFixture();
  await f.deliver();
  f.start(f.reviewer);
  const human: Actor = { kind: "human", project_id: f.state.project_id };
  const views = (s: CommandState) => {
    const snapshot = projectSnapshot(s, human);
    const needs = listNeedsYou(s, human);
    if (!snapshot.ok) throw snapshot.error;
    if (!needs.ok) throw needs.error;
    return [snapshot.value.data, needs.value.data];
  };
  expect(views(split(f.state))).toEqual(views(f.state));
});
