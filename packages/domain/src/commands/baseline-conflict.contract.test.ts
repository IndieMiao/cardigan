import { beforeEach, expect, test } from "vitest";
import type { Actor, Precheck } from "../entities.js";
import { reportBlocker } from "./coordination.js";
import { finishRun } from "./runtime.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  run as makeRun,
  ports,
  value,
} from "./test-fixtures.js";
import { resumeWorkWaits } from "./work-waits.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const work = id("work_item", 1),
  owner = id("assignment", 1),
  run = id("run", 1);
const base = "a".repeat(40),
  next = "b".repeat(40),
  head = "c".repeat(40);
let state = fixture(),
  io = ports();
beforeEach(() => {
  state = fixture();
  io = ports();
  state = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === owner ? { ...a, base_sha: base } : a,
    ),
  };
});
function conflict(
  attempt = "conflict-1",
  patch: Partial<Omit<Precheck, "failure_kind">> & {
    failure_kind?: "candidate_conflict" | undefined;
  } = {},
  who = system,
) {
  const raw = {
    attempt_id: attempt,
    card_id: id("card", 1),
    work_item_id: work,
    assignment_id: owner,
    head_sha: head,
    base_sha: next,
    branch: "agent/fixture",
    machine_id: "local",
    status: "environment_failed",
    failure_kind: "candidate_conflict",
    ...patch,
  };
  const check: Precheck = JSON.parse(JSON.stringify(raw));
  state = {
    ...state,
    events: [
      ...state.events,
      {
        id: io.ids.nextEventId(),
        seq: io.ids.nextEventSequence(state.project_id, check.card_id),
        card_id: check.card_id,
        type: "precheck_finished",
        actor: who,
        payload: JSON.parse(JSON.stringify(check)),
        created_at: io.clock.now(),
      },
    ],
  };
}
function finish(wait = false) {
  state = apply(
    state,
    value(
      finishRun(
        state,
        actor(),
        {
          run_id: run,
          outcome: "blocked",
          summary: "Wait for synchronized baseline",
          ...(wait ? { wait_for: { kind: "baseline_updated" as const } } : {}),
        },
        io,
      ),
    ),
  );
}
function scan(sha = next, branch = "main", limit?: number) {
  const result = value(
    resumeWorkWaits(
      state,
      system,
      {
        baseline: { branch, sha },
        ...(limit ? { conflict_max_resumes: limit } : {}),
      },
      io,
    ),
  );
  state = apply(state, result);
  return result;
}
function block(
  condition?: "baseline_updated" | "precheck_finished",
  reason = "需要同步最新基线",
) {
  state = apply(
    state,
    value(
      reportBlocker(
        state,
        actor(),
        {
          work_item_id: work,
          needs: "role",
          reason,
          ...(condition
            ? {
                resume_when: {
                  kind: condition,
                  target_id:
                    condition === "baseline_updated" ? base : "conflict-1",
                },
              }
            : {}),
        },
        io,
      ),
    ),
  );
}

test("a candidate conflict waits for the current Run to end and requests one baseline followup without author opt-in", () => {
  conflict();
  expect(scan().data).toEqual([]);
  finish();
  expect(scan(base).data).toEqual([]);
  expect(scan(next, "other").data).toEqual([]);
  expect(scan("invalid").data).toEqual([]);
  expect(scan().data).toEqual([work]);
  expect(
    state.events.find((e) => e.type === "work_item_resume_requested")?.payload,
  ).toMatchObject({
    conflict_attempt_id: "conflict-1",
    conflict_head_sha: head,
    retry: 1,
    evidence: next,
    previous_run_id: run,
    body: expect.stringContaining("基线前进，自动同步"),
  });
  state = structuredClone(state);
  expect(scan().events).toEqual([]);
});

test.each(["baseline_updated", "precheck_finished", "legacy"] as const)(
  "clears only the baseline blocker (%s) before requesting followup",
  (kind) => {
    conflict();
    block(kind === "legacy" ? undefined : kind);
    if (kind === "legacy")
      state = {
        ...state,
        work_items: state.work_items.map((w) => {
          if (w.id !== work || !w.reported_blocker) return w;
          const { resume_when: _condition, ...legacy } = w.reported_blocker;
          return {
            ...w,
            reported_blocker: { ...legacy, auto_resume_disabled: true },
          };
        }),
      };
    finish();
    expect(scan().data).toEqual([work]);
    expect(state.work_items.find((w) => w.id === work)?.status).toBe(
      "in_progress",
    );
    expect(
      state.work_items.find((w) => w.id === work)?.reported_blocker,
    ).toBeUndefined();
  },
);

test("structured baseline wait works without a conflict and rejects an unregistered SHA", () => {
  expect(
    reportBlocker(
      state,
      actor(),
      {
        work_item_id: work,
        reason: "Wait",
        needs: "role",
        resume_when: { kind: "baseline_updated", target_id: next },
      },
      io,
    ).ok,
  ).toBe(false);
  block("baseline_updated");
  finish();
  expect(scan(base).data).toEqual([]);
  expect(scan().data).toEqual([work]);
  expect(scan().data).toEqual([]);
});

test("three recoveries for the same HEAD persist across restart; the fourth escalates once and a new HEAD has its own allowance", () => {
  for (let i = 1; i <= 4; i++) {
    conflict(`conflict-${i}`);
    state = {
      ...state,
      runs: state.runs.map((r) => {
        if (r.id !== run) return r;
        const { wait_for: _wait, ...rest } = r;
        return { ...rest, status: "running" as const };
      }),
    };
    finish(true);
    const result = scan();
    expect(result.data).toEqual(i <= 3 ? [work] : []);
    state = structuredClone(state);
    expect(scan().events).toEqual([]);
  }
  expect(
    state.events.filter((e) => e.type === "baseline_conflict_limit_reached"),
  ).toHaveLength(1);
  conflict("same-head-again");
  expect(scan().events).toEqual([]);
  conflict("new-head", { head_sha: "d".repeat(40) });
  expect(scan().data).toEqual([work]);
});

test("the host may configure the recovery ceiling", () => {
  conflict();
  finish();
  expect(scan(next, "main", 1).data).toEqual([work]);
  conflict("conflict-2");
  expect(scan(next, "main", 1).events.map((e) => e.type)).toEqual([
    "baseline_conflict_limit_reached",
  ]);
});

test("a consumed conflict does not waive repeated-blocker or repeated-wait protection in the followup", () => {
  conflict();
  finish();
  const recovered = scan();
  const trigger = recovered.events.find(
    (e) => e.type === "work_item_resume_requested",
  );
  if (!trigger) throw new Error("Missing recovery event");
  const followup = {
    ...makeRun(4, 1),
    kind: "followup" as const,
    trigger_event_id: trigger.id,
  };
  state = { ...state, runs: [...state.runs, followup] };
  expect(
    finishRun(
      state,
      actor(),
      {
        run_id: followup.id,
        outcome: "completed",
        summary: "Wait again",
        wait_for: { kind: "baseline_updated" },
      },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  block("baseline_updated");
  expect(
    state.work_items.find((w) => w.id === work)?.reported_blocker
      ?.auto_resume_disabled,
  ).toBe(true);
  state = apply(
    state,
    value(
      finishRun(
        state,
        actor(),
        {
          run_id: followup.id,
          outcome: "blocked",
          summary: "PM must investigate",
        },
        io,
      ),
    ),
  );
  expect(scan("d".repeat(40)).events).toEqual([]);
});

test.each([
  "hold",
  "unknown_run",
  "other_blocker",
  "human_blocker",
  "decision",
  "owner",
  "latest_passed",
  "latest_queued",
  "untrusted",
  "foreign",
])("does not auto-resume through %s", (guard) => {
  conflict(
    "conflict-1",
    {},
    guard === "untrusted"
      ? actor()
      : guard === "foreign"
        ? { kind: "system", project_id: "foreign" }
        : system,
  );
  if (guard === "other_blocker") block(undefined, "需要提供外部账号凭据");
  if (guard === "human_blocker")
    state = apply(
      state,
      value(
        reportBlocker(
          state,
          actor(),
          {
            work_item_id: work,
            reason: "需要凭据才能同步 main",
            needs: "human",
          },
          io,
        ),
      ),
    );
  finish();
  if (guard === "hold")
    state = {
      ...state,
      cards: state.cards.map((c) => ({
        ...c,
        hold: {
          reason: "Paused",
          resume_condition: "PM clearance",
          set_by: "human",
          set_at: io.clock.now(),
        },
      })),
    };
  if (guard === "unknown_run")
    state = {
      ...state,
      runs: state.runs.map((r) =>
        r.id === run ? { ...r, status: "unknown" } : r,
      ),
    };
  if (guard === "owner")
    state = {
      ...state,
      assignments: state.assignments.map((a) =>
        a.id === owner ? { ...a, status: "released" } : a,
      ),
    };
  if (guard === "decision")
    state = {
      ...state,
      decisions: [
        {
          id: id("decision", 1),
          key: id("decision", 1),
          kind: "choose",
          question: "Wait",
          context: "Wait",
          options: [
            { key: "continue", description: "Continue", impact: "Continue" },
          ],
          recommended: "continue",
          doc_refs: [],
          status: "open",
          blocking: true,
          affected_cards: [id("card", 1)],
          affected_work_items: [work],
          decider: "human",
          raised_by: "human",
        },
      ],
    };
  if (guard === "latest_passed" || guard === "latest_queued")
    conflict("newer", {
      status: guard === "latest_passed" ? "passed" : "queued",
      failure_kind: undefined,
    });
  expect(scan().data).toEqual([]);
  expect(
    state.events.some((e) => e.type === "work_item_resume_requested"),
  ).toBe(false);
});

test("a manual assignment resumes once after a verified baseline change", () => {
  conflict("conflict-1");
  finish();
  state = {
    ...state,
    work_items: state.work_items.map((w) =>
      w.id === work ? { ...w, manual_assign: true } : w,
    ),
  };
  expect(scan().data).toEqual([work]);
  expect(scan().events).toEqual([]);
});

test("recognizes the historical host diagnostic but not arbitrary error text", () => {
  conflict("old", {
    failure_kind: undefined,
    summary: "预检查环境故障（准备候选）：Precheck merge conflict",
  });
  finish();
  expect(scan().data).toEqual([work]);
  conflict("unrelated", {
    failure_kind: undefined,
    summary: "Precheck merge conflict in a test log",
  });
  expect(scan().data).toEqual([]);
});
