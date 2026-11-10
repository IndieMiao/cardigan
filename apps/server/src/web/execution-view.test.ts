import { type CommandState, type Event, parseEventId } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  fixture,
  human,
  id,
  value,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { executionView } from "./read.js";

const queued = (run: number, created_at: string): Event => ({
  id: value(parseEventId(`${"0".repeat(24)}${run}0`)),
  card_id: id("card", 1),
  seq: run,
  type: "run_queued",
  actor: human,
  payload: { run_id: id("run", run), assignment_id: id("assignment", run) },
  created_at,
});

test("C-73: the execution view reports each Run's queue time so a queued Run has an activity time", () => {
  const base = fixture();
  const state: CommandState = {
    ...base,
    runs: base.runs.map((run) =>
      run.id === id("run", 2)
        ? (({ started_at: _s, ...rest }) => ({ ...rest, status: "queued" }))(
            run,
          )
        : run,
    ),
    events: [queued(2, "2026-01-02T00:00:00.000Z")],
  };
  const view = executionView(state, "2026-01-03T00:00:00.000Z");
  const second = view.assignments.find((a) => a.id === id("assignment", 2));
  expect(second?.run).toMatchObject({
    status: "queued",
    queued_at: "2026-01-02T00:00:00.000Z",
  });
  expect(view.runs.find((r) => r.id === id("run", 2))).toMatchObject({
    queued_at: "2026-01-02T00:00:00.000Z",
  });
  // Older history without a run_queued event stays compatible: no field.
  expect(view.runs.find((r) => r.id === id("run", 1))).not.toHaveProperty(
    "queued_at",
  );
  expect(
    view.assignments.find((a) => a.id === id("assignment", 1))?.run,
  ).not.toHaveProperty("queued_at");
});
