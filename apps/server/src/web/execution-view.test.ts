import {
  type CommandState,
  type Event,
  parseEventId,
  type Run,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { CommandDraft } from "../../../../packages/domain/src/commands/core.js";
import { queueResumedRun } from "../../../../packages/domain/src/commands/resumption.js";
import {
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import {
  assignmentActivity,
  sortByActivity,
} from "../../../web/src/execution-sort.js";
import { executionView } from "./read.js";

const eventId = (n: number) =>
  value(parseEventId(`${"0".repeat(24)}${String(n).padStart(2, "0")}`));
const event = (
  n: number,
  type: string,
  payload: Event["payload"],
  created_at: string,
): Event => ({
  id: eventId(n),
  card_id: id("card", 1),
  seq: n,
  type,
  actor: human,
  payload,
  created_at,
});
const at = (minute: number) =>
  `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`;
const queuedRun = (run: Run): Run => {
  const { started_at: _started, ...rest } = run;
  return { ...rest, status: "queued" };
};

/** Sort the view the way the Workbench does (runs are newest first). */
const order = (view: ReturnType<typeof executionView>) =>
  sortByActivity(
    view.assignments.map((a) => ({
      ...a,
      runtime_ref: null,
      worktree_path: a.worktree_path ?? null,
    })),
    (a) =>
      assignmentActivity(
        a,
        view.runs.find((run) => run.assignment_id === a.id),
      ),
    "desc",
  ).map((a) => a.id);

test("C-73: a Run queued by launch reports its run_queued time", () => {
  const base = fixture();
  const state: CommandState = {
    ...base,
    runs: base.runs.map((run) =>
      run.id === id("run", 2) ? queuedRun(run) : run,
    ),
    events: [
      event(
        51,
        "run_queued",
        { run_id: id("run", 2), assignment_id: id("assignment", 2) },
        at(2),
      ),
    ],
  };
  const view = executionView(state, at(30));
  const second = view.assignments.find((a) => a.id === id("assignment", 2));
  expect(second?.run).toMatchObject({ status: "queued", queued_at: at(2) });
  expect(view.runs.find((r) => r.id === id("run", 2))).toMatchObject({
    queued_at: at(2),
  });
  // A Run whose queue event is not in history stays compatible: no field.
  expect(view.runs.find((r) => r.id === id("run", 1))).not.toHaveProperty(
    "queued_at",
  );
});

test("C-73: a Run re-queued after a decision or unblock (no run_queued) counts from its trigger", () => {
  const base = fixture();
  let state: CommandState = {
    ...base,
    // A-1 last talked over MCP at 10:01 and its Run ended blocked; A-2 was
    // active at 10:05; A-3 has no activity.
    assignments: base.assignments.map((a) =>
      a.id === id("assignment", 1)
        ? { ...a, last_mcp_activity_at: at(1) }
        : a.id === id("assignment", 2)
          ? { ...a, last_mcp_activity_at: at(5) }
          : a,
    ),
    runs: base.runs
      .filter((run) => run.id !== id("run", 3))
      .map((run) =>
        run.id === id("run", 1)
          ? {
              ...run,
              status: "completed" as const,
              outcome: "blocked" as const,
              finished_at: at(1),
            }
          : {
              ...run,
              status: "completed" as const,
              outcome: "completed" as const,
            },
      ),
  };
  const draft = new CommandDraft(state, human, "resolve_decision", ports());
  const resolved = draft.emit("decision_resolved", id("card", 1), {
    work_item_id: id("work_item", 1),
  });
  const item = state.work_items.find((w) => w.id === id("work_item", 1));
  if (!item) throw new Error("missing fixture work item");
  queueResumedRun(draft, item, resolved);
  state = apply(state, {
    changes: draft.changes,
    events: draft.events.map((e) => ({ ...e, created_at: at(9) })),
    timeline: draft.timeline,
  } as never);
  const resumed = state.runs.find(
    (run) =>
      run.assignment_id === id("assignment", 1) && run.status === "queued",
  );
  expect(resumed?.trigger_event_id).toBe(resolved.id);
  expect(state.events.some((e) => e.type === "run_queued")).toBe(false);

  const view = executionView(state, at(30));
  expect(
    view.assignments.find((a) => a.id === id("assignment", 1))?.run,
  ).toMatchObject({ id: resumed?.id, status: "queued", queued_at: at(9) });
  expect(order(view)).toEqual([
    id("assignment", 1),
    id("assignment", 2),
    id("assignment", 3),
    id("assignment", 4),
  ]);
});

test("C-73: a replacement Run from dispatch recovery counts from its recovery event", () => {
  const base = fixture();
  const recovered = event(
    7,
    "run_dispatch_recovered",
    {
      assignment_id: id("assignment", 3),
      run_id: id("run", 3),
      replacement_run_id: id("run", 4),
    },
    at(8),
  );
  const state: CommandState = {
    ...base,
    assignments: base.assignments.map((a) =>
      a.id === id("assignment", 2) ? { ...a, last_mcp_activity_at: at(5) } : a,
    ),
    runs: [
      ...base.runs
        .filter((run) => run.id !== id("run", 1))
        .map((run) =>
          run.id === id("run", 3)
            ? { ...run, status: "cancelled" as const, finished_at: at(3) }
            : run.id === id("run", 2)
              ? { ...run, started_at: at(5) }
              : run,
        ),
      {
        ...queuedRun({ ...base.runs[2], id: id("run", 4) } as Run),
        trigger_event_id: recovered.id,
      },
    ],
    events: [recovered],
  };
  const view = executionView(state, at(30));
  expect(
    view.assignments.find((a) => a.id === id("assignment", 3))?.run,
  ).toMatchObject({ id: id("run", 4), queued_at: at(8) });
  expect(order(view).slice(0, 2)).toEqual([
    id("assignment", 3),
    id("assignment", 2),
  ]);
});

test("C-106: the execution view passes the Run's launch settings snapshot through", () => {
  const base = fixture();
  const state: CommandState = {
    ...base,
    runs: base.runs.map((run) =>
      run.id === id("run", 1)
        ? { ...run, harness: "claude-code", effort: "xhigh" }
        : run,
    ),
  };
  const view = executionView(state, at(30));
  expect(view.runs.find((run) => run.id === id("run", 1))).toMatchObject({
    harness: "claude-code",
    effort: "xhigh",
  });
  // Legacy Runs carry neither field; the Workbench shows "—".
  const legacy = view.runs.find((run) => run.id === id("run", 2));
  expect(legacy).not.toHaveProperty("harness");
  expect(legacy).not.toHaveProperty("effort");
});
