import {
  type Actor,
  type CommandState,
  finishRun,
  reportBlocker,
  resumeWorkWaits,
} from "@cardigan/domain";
import { routeEvent } from "@cardigan/router";
import { expect, test } from "vitest";
import {
  actor,
  apply,
  fixture,
  id,
  ports,
  run,
  value,
} from "../../../packages/domain/src/commands/test-fixtures.js";

function recovered() {
  let state = fixture();
  const io = ports();
  const system: Actor = { kind: "system", project_id: state.project_id };
  const base = "a".repeat(40);
  state = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === id("assignment", 1) ? { ...a, base_sha: base } : a,
    ),
    events: [
      {
        id: io.ids.nextEventId(),
        seq: io.ids.nextEventSequence(state.project_id, id("card", 1)),
        card_id: id("card", 1),
        actor: system,
        type: "precheck_finished",
        created_at: io.clock.now(),
        payload: {
          attempt_id: "conflict-1",
          card_id: id("card", 1),
          work_item_id: id("work_item", 1),
          assignment_id: id("assignment", 1),
          head_sha: "c".repeat(40),
          base_sha: "b".repeat(40),
          branch: "agent/fixture",
          machine_id: "local",
          status: "environment_failed",
          failure_kind: "candidate_conflict",
        },
      },
    ],
  };
  const end = value(
    finishRun(
      state,
      actor(),
      {
        run_id: id("run", 1),
        outcome: "completed",
        summary: "Wait for baseline",
      },
      io,
    ),
  );
  state = apply(state, end);
  const first = value(
    resumeWorkWaits(
      state,
      system,
      { baseline: { branch: "main", sha: "b".repeat(40) } },
      io,
    ),
  );
  expect(first.data).toEqual([id("work_item", 1)]);
  state = apply(state, first);
  const trigger = first.events.find(
    (e) => e.type === "work_item_resume_requested",
  );
  const finished = end.events.find((e) => e.type === "run_finished");
  if (!trigger || !finished) throw new Error("Missing recovery evidence");
  const followup = {
    ...run(4, 1),
    kind: "followup" as const,
    trigger_event_id: trigger.id,
  };
  state = { ...state, runs: [...state.runs, followup] };
  return { state, io, system, base, followup, finished };
}

test.each(["baseline_updated", "precheck_finished", "legacy"] as const)(
  "a repeated blocker after conflict recovery reaches PM (%s)",
  (kind) => {
    const x = recovered();
    const report = value(
      reportBlocker(
        x.state,
        actor(),
        {
          work_item_id: id("work_item", 1),
          needs: "role",
          reason: "自动同步后仍无法取得所需基线，请主机处理",
          ...(kind !== "legacy"
            ? {
                resume_when: {
                  kind,
                  target_id:
                    kind === "baseline_updated" ? x.base : "conflict-1",
                },
              }
            : {}),
        },
        x.io,
      ),
    );
    let state = apply(x.state, report);
    const reported = report.events.find((e) => e.type === "blocker_reported");
    if (!reported) throw new Error("Missing blocker event");
    expect(
      state.work_items.find((w) => w.id === id("work_item", 1))
        ?.reported_blocker?.auto_resume_disabled,
    ).toBe(true);
    expect(report.data.guidance).toContain("请 PM");
    expect(
      routeEvent({ event: reported, snapshot: state }).notifications,
    ).toMatchObject([{ recipient: { kind: "pm_ops" }, kind: "escalation" }]);
    state = apply(
      state,
      value(
        finishRun(
          state,
          actor(),
          {
            run_id: x.followup.id,
            outcome: "blocked",
            summary: "Still need baseline",
          },
          x.io,
        ),
      ),
    );
    const retry = value(
      resumeWorkWaits(
        state,
        x.system,
        { baseline: { branch: "main", sha: "d".repeat(40) } },
        x.io,
      ),
    );
    expect(retry.data).toEqual([]);
    expect(retry.events).toEqual([]);
  },
);

test("a followup without output reaches PM after its conflict was consumed", () => {
  const x = recovered();
  const end = value(
    finishRun(
      x.state,
      actor(),
      { run_id: x.followup.id, outcome: "completed", summary: "No delivery" },
      x.io,
    ),
  );
  const state = apply(x.state, end);
  const finished = end.events.find((e) => e.type === "run_finished");
  if (!finished) throw new Error("Missing finished event");
  expect(
    routeEvent({ event: finished, snapshot: state }).notifications,
  ).toMatchObject([{ recipient: { kind: "pm_ops" }, kind: "run_attention" }]);
  expect(
    value(
      resumeWorkWaits(
        state,
        x.system,
        { baseline: { branch: "main", sha: "d".repeat(40) } },
        x.io,
      ),
    ).data,
  ).toEqual([]);
});

test("routing the original finished Run after recovery does not raise a false empty-run alert", () => {
  const x = recovered();
  expect(
    routeEvent({ event: x.finished, snapshot: x.state }).notifications,
  ).toEqual([]);
});

test("PM clearance of general waits cannot make a consumed conflict automatically resumable", () => {
  const x = recovered();
  const state: CommandState = {
    ...x.state,
    events: [
      ...x.state.events,
      {
        id: x.io.ids.nextEventId(),
        seq: x.io.ids.nextEventSequence(x.state.project_id, id("card", 1)),
        card_id: id("card", 1),
        type: "work_item_updated",
        actor: { kind: "human", project_id: x.state.project_id },
        payload: {
          work_item_id: id("work_item", 1),
          reported_blocker_cleared: true,
        },
        created_at: x.io.clock.now(),
      },
    ],
  };
  const report = value(
    reportBlocker(
      state,
      actor(),
      {
        work_item_id: id("work_item", 1),
        needs: "role",
        reason: "Wait for the same conflict",
        resume_when: { kind: "precheck_finished", target_id: "conflict-1" },
      },
      x.io,
    ),
  );
  expect(report.data.guidance).toContain("请 PM");
  expect(
    apply(state, report).work_items.find((w) => w.id === id("work_item", 1))
      ?.reported_blocker?.auto_resume_disabled,
  ).toBe(true);
});

test("a limit handoff covers its finished Run but does not hide a later empty Run", () => {
  const x = recovered();
  const first = x.state.events.find((e) => e.type === "precheck_finished");
  if (!first) throw new Error("Missing conflict");
  let state: CommandState = {
    ...x.state,
    events: [
      ...x.state.events,
      {
        ...first,
        id: x.io.ids.nextEventId(),
        seq: x.io.ids.nextEventSequence(x.state.project_id, first.card_id),
        payload: {
          ...(first.payload as Record<string, string>),
          attempt_id: "conflict-2",
        },
      },
    ],
  };
  const finish = (runId: typeof x.followup.id) => {
    const effect = value(
      finishRun(
        state,
        actor(),
        { run_id: runId, outcome: "completed", summary: "No delivery" },
        x.io,
      ),
    );
    state = apply(state, effect);
    const event = effect.events.find((e) => e.type === "run_finished");
    if (!event) throw new Error("Missing finish");
    return event;
  };
  const finished = finish(x.followup.id);
  const limit = value(
    resumeWorkWaits(
      state,
      x.system,
      {
        baseline: { branch: "main", sha: "d".repeat(40) },
        conflict_max_resumes: 1,
      },
      x.io,
    ),
  );
  state = apply(state, limit);
  const handoff = limit.events.find(
    (e) => e.type === "baseline_conflict_limit_reached",
  );
  if (!handoff) throw new Error("Missing limit handoff");
  expect(
    routeEvent({ event: handoff, snapshot: state }).notifications,
  ).toMatchObject([{ recipient: { kind: "pm_ops" }, kind: "escalation" }]);
  expect(
    routeEvent({ event: finished, snapshot: state }).notifications,
  ).toEqual([]);
  state = {
    ...state,
    runs: [...state.runs, { ...run(5, 1), kind: "followup" as const }],
  };
  const later = finish(id("run", 5));
  expect(
    routeEvent({ event: later, snapshot: state }).notifications,
  ).toMatchObject([{ recipient: { kind: "pm_ops" }, kind: "run_attention" }]);
});
