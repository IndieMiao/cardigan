import { beforeEach, expect, test } from "vitest";
import type { Actor, Event, JsonValue } from "../entities.js";
import type { ResumeCondition } from "../work-wait.js";
import { reportBlocker } from "./coordination.js";
import type { CommandState } from "./core.js";
import { finishRun, settlePendingRunFinish } from "./runtime.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";
import { resumeWorkWaits } from "./work-waits.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const work = id("work_item", 1),
  runId = id("run", 1),
  owner = id("assignment", 1);
const base = "a".repeat(40),
  next = "b".repeat(40);
let io = ports(),
  state = fixture();
beforeEach(() => {
  io = ports();
  state = fixture();
});
function event(
  type: string,
  payload: JsonValue,
  eventActor: Actor = system,
  card_id = id("card", 2),
) {
  const e: Event = {
    id: io.ids.nextEventId(),
    seq: io.ids.nextEventSequence(state.project_id, card_id),
    type,
    payload,
    actor: eventActor,
    card_id,
    created_at: io.clock.now(),
  };
  state = { ...state, events: [...state.events, e] };
  return e;
}
function block(resume_when?: ResumeCondition) {
  state = apply(
    state,
    value(
      reportBlocker(
        state,
        actor(),
        {
          work_item_id: work,
          reason: "Waiting",
          needs: "role",
          ...(resume_when ? { resume_when } : {}),
        },
        io,
      ),
    ),
  );
}
function finish() {
  state = apply(
    state,
    value(
      finishRun(
        state,
        actor(),
        { run_id: runId, outcome: "blocked", summary: "Waiting" },
        io,
      ),
    ),
  );
}
function scan(baseline?: { branch: string; sha: string }) {
  const effect = value(
    resumeWorkWaits(state, system, baseline ? { baseline } : {}, io),
  );
  state = apply(state, effect);
  return effect;
}
const item = () => state.work_items.find((w) => w.id === work);
const cases: {
  condition: ResumeCondition;
  waiting: () => void;
  settled: () => void;
}[] = [
  {
    condition: { kind: "precheck_finished", target_id: "attempt-1" },
    waiting: () => {
      event("precheck_started", { attempt_id: "attempt-1", status: "running" });
    },
    settled: () => {
      event("precheck_finished", { attempt_id: "attempt-1", status: "failed" });
    },
  },
  {
    condition: { kind: "merge_check_finished", target_id: "attempt-1" },
    waiting: () => {
      event("merge_check_queued", {
        attempt_id: "attempt-1",
        status: "queued",
      });
    },
    settled: () => {
      event("merge_check_finished", {
        attempt_id: "attempt-1",
        status: "passed",
      });
    },
  },
  {
    condition: { kind: "github_run_completed", target_id: "123" },
    waiting: () => {
      event("github_check_dispatch", {
        attempt: "attempt-1",
        externalRun: { run_id: 123 },
        finished: false,
      });
    },
    settled: () => {
      event("github_check_dispatch", {
        attempt: "attempt-1",
        externalRun: { run_id: 123 },
        finished: true,
      });
    },
  },
  {
    condition: { kind: "card_merged", target_id: "C-2" },
    waiting: () => {},
    settled: () => {
      state = {
        ...state,
        cards: state.cards.map((c) =>
          c.id === "C-2" ? { ...c, status: "done" } : c,
        ),
      };
      event("card_merged", { merge_sha: next });
    },
  },
  {
    condition: { kind: "deployment_ready", target_id: next },
    waiting: () => {
      event("host_deployment_recorded", {
        to: next,
        status: "started",
        ready: false,
      });
    },
    settled: () => {
      event("host_deployment_recorded", {
        to: next,
        status: "deployed",
        ready: true,
      });
    },
  },
];
test.each(cases)(
  "$condition.kind resumes once with evidence and a single PM summary",
  ({ condition, waiting, settled }) => {
    waiting();
    block(condition);
    finish();
    expect(scan().data).toEqual([]);
    settled();
    // Serializable state models a process restart without any in-memory waiter.
    state = JSON.parse(JSON.stringify(state)) as CommandState;
    const effect = scan();
    expect(effect.data).toEqual([work]);
    expect(item()).toMatchObject({ status: "in_progress" });
    expect(item()?.reported_blocker).toBeUndefined();
    expect(effect.events.map((e) => e.type)).toEqual([
      "work_item_resume_requested",
      "work_waits_resumed",
    ]);
    expect(effect.events[0]?.payload).toMatchObject({
      condition,
      automatic_wait: true,
      reported_blocker_cleared: true,
    });
    expect(scan().events).toEqual([]);
    state = {
      ...state,
      runs: state.runs.map((r) =>
        r.id === runId ? { ...r, status: "running", outcome: null } : r,
      ),
    };
    block(condition);
    finish();
    expect(item()?.reported_blocker?.auto_resume_disabled).toBe(true);
    expect(scan().events).toEqual([]);
  },
);

test("unknown conditions, unknown targets, self dependency and cross-project evidence are rejected", () => {
  for (const condition of [
    { kind: "unknown", target_id: "whatever" },
    { kind: "card_merged", target_id: "C-1" },
    { kind: "precheck_finished", target_id: "missing" },
    { kind: "deployment_ready", target_id: "short" },
  ])
    expect(
      reportBlocker(
        state,
        actor(),
        {
          work_item_id: work,
          reason: "Wait",
          needs: "role",
          resume_when: condition as ResumeCondition,
        },
        io,
      ).ok,
    ).toBe(false);
  event(
    "precheck_started",
    { attempt_id: "foreign" },
    { kind: "system", project_id: "foreign" },
  );
  expect(
    reportBlocker(
      state,
      actor(),
      {
        work_item_id: work,
        reason: "Wait",
        needs: "role",
        resume_when: { kind: "precheck_finished", target_id: "foreign" },
      },
      io,
    ).ok,
  ).toBe(false);
  expect(resumeWorkWaits(state, actor(), {}, io).ok).toBe(false);
  expect(resumeWorkWaits(state, human, {}, io).ok).toBe(false);
});

test("local timeout, untrusted events and cancellation requests cannot settle a GitHub run", () => {
  const c = cases[2];
  if (!c) throw new Error("Missing case");
  c.waiting();
  block(c.condition);
  finish();
  event("precheck_finished", {
    attempt_id: "attempt-1",
    status: "executor_unreachable",
  });
  event("github_check_dispatch", {
    externalRun: { run_id: 123 },
    finished: false,
    cancel_requested: true,
  });
  event(
    "github_check_dispatch",
    { externalRun: { run_id: 123 }, finished: true },
    actor(),
  );
  expect(scan().data).toEqual([]);
});

test("a condition can settle before finish; no concurrent Run is woken", () => {
  const c = cases[0];
  if (!c) throw new Error("Missing case");
  c.waiting();
  block(c.condition);
  c.settled();
  expect(scan().data).toEqual([]);
  expect(item()?.status).toBe("blocked");
  finish();
  expect(scan().data).toEqual([work]);
});

test.each([
  "hold",
  "manual",
  "closed",
  "suspended",
  "stopped",
  "other_blocker",
])("%s prevents automatic resume without consuming it", (guard) => {
  const c = cases[0];
  if (!c) throw new Error("Missing case");
  c.waiting();
  block(c.condition);
  finish();
  c.settled();
  const before = state;
  if (guard === "hold" || guard === "closed")
    state = {
      ...state,
      cards: state.cards.map((c) =>
        c.id === "C-1"
          ? {
              ...c,
              ...(guard === "hold"
                ? {
                    hold: {
                      reason: "Paused",
                      set_at: io.clock.now(),
                      set_by: "human" as const,
                      resume_condition: "PM resumes",
                    },
                  }
                : { status: "cancelled" as const }),
            }
          : c,
      ),
    };
  if (guard === "manual")
    state = {
      ...state,
      work_items: state.work_items.map((w) =>
        w.id === work ? { ...w, manual_assign: true } : w,
      ),
    };
  if (guard === "suspended")
    state = {
      ...state,
      assignments: state.assignments.map((a) =>
        a.id === owner ? { ...a, status: "suspended" } : a,
      ),
    };
  if (guard === "stopped")
    event("assignment_stopped", { assignment_id: owner }, human, id("card", 1));
  if (guard === "other_blocker")
    state = {
      ...state,
      decisions: [
        {
          id: id("decision", 1),
          kind: "choose",
          key: id("decision", 1),
          doc_refs: [],
          question: "Wait",
          context: "Wait",
          options: [],
          recommended: "",
          affected_cards: [],
          affected_work_items: [work],
          blocking: true,
          decider: "human",
          status: "open",
          raised_by: "human",
        },
      ],
    };
  expect(scan().data).toEqual([]);
  expect(item()?.reported_blocker).toBeDefined();
  state = before;
  expect(scan().data).toEqual([work]);
});

test("resolved decision resumes, revoked/provisional does not", () => {
  state = {
    ...state,
    decisions: [
      {
        id: id("decision", 1),
        kind: "choose",
        key: id("decision", 1),
        doc_refs: [],
        question: "Wait",
        context: "Wait",
        options: [],
        recommended: "",
        affected_cards: [],
        affected_work_items: [work],
        blocking: true,
        decider: "human",
        status: "provisional",
        raised_by: "human",
      },
    ],
  };
  block({ kind: "decision_resolved", target_id: "Q-1" });
  finish();
  expect(scan().data).toEqual([]);
  state = {
    ...state,
    decisions: state.decisions.map((q) => ({ ...q, status: "resolved" })),
  };
  expect(scan().data).toEqual([work]);
});

function baselineWait() {
  state = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === owner ? { ...a, base_sha: base } : a,
    ),
  };
  state = apply(
    state,
    value(
      finishRun(
        state,
        actor(),
        {
          run_id: runId,
          outcome: "completed",
          summary: "Waiting baseline",
          wait_for: { kind: "baseline_updated" },
        },
        io,
      ),
    ),
  );
}
test("explicit baseline wait preserves business status and wakes once only for the matching branch", () => {
  baselineWait();
  expect(item()?.status).toBe("in_progress");
  expect(scan().data).toEqual([]);
  expect(scan({ branch: "main", sha: base }).data).toEqual([]);
  expect(scan({ branch: "other", sha: next }).data).toEqual([]);
  expect(scan({ branch: "main", sha: next }).data).toEqual([work]);
  expect(
    state.runs.find((r) => r.id === runId)?.wait_for?.resumed_by,
  ).toBeDefined();
  expect(scan({ branch: "main", sha: next }).events).toEqual([]);
});
test("plain finish and unstructured blockers keep old behavior", () => {
  block();
  finish();
  event("card_merged", {});
  expect(scan({ branch: "main", sha: next }).data).toEqual([]);
  expect(item()?.status).toBe("blocked");
  state = fixture();
  finish();
  expect(scan({ branch: "main", sha: next }).data).toEqual([]);
});
test("explicit deployment wait rejects failed deployment and accepts ready deployment", () => {
  state = apply(
    state,
    value(
      finishRun(
        state,
        actor(),
        {
          run_id: runId,
          outcome: "blocked",
          summary: "Waiting deployment",
          wait_for: { kind: "deployment_ready", target_id: next },
        },
        io,
      ),
    ),
  );
  event("host_deployment_recorded", {
    to: next,
    status: "failed",
    ready: true,
  });
  expect(scan().data).toEqual([]);
  event("host_deployment_recorded", {
    to: next,
    status: "deployed",
    ready: true,
  });
  expect(scan().data).toEqual([work]);
});
test("disconnected finish keeps the waiting condition through authenticated settlement", () => {
  const ref = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "terminal",
    agent_name: "fixture",
  };
  state = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === owner
        ? { ...a, base_sha: base, runtime_state: "unknown", runtime_ref: ref }
        : a,
    ),
    runs: state.runs.map((r) =>
      r.id === runId ? { ...r, status: "unknown" } : r,
    ),
  };
  const token = {
    id: "current-token",
    project_id: state.project_id,
    assignment_id: owner,
    role_version: 1,
    allowed_tools: ["finish_run" as const],
    revoked_at: null,
  };
  const request = {
    run_id: runId,
    outcome: "completed" as const,
    summary: "Wait",
    wait_for: { kind: "baseline_updated" as const },
  };
  state = apply(
    state,
    value(finishRun(state, actor(), request, { ...io, run_token: token })),
  );
  expect(scan({ branch: "main", sha: next }).data).toEqual([]);
  state = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === owner ? { ...a, runtime_state: "running" } : a,
    ),
    runs: state.runs.map((r) =>
      r.id === runId ? { ...r, status: "running" } : r,
    ),
  };
  state = apply(
    state,
    value(
      settlePendingRunFinish(
        state,
        system,
        { run_id: runId, runtime_ref: ref },
        { ...io, run_token: token },
      ),
    ),
  );
  expect(scan({ branch: "main", sha: next }).data).toEqual([work]);
});

test.each([false, true])(
  "a new blocker after automatic wake goes to PM even with a changed condition/recovered trigger (%s)",
  (recovered) => {
    baselineWait();
    const resumed = scan({ branch: "main", sha: next });
    const trigger = recovered
      ? event("run_preparation_recovered", {})
      : resumed.events[0];
    if (!trigger) throw new Error("Missing automatic wake");
    state = {
      ...state,
      runs: state.runs.map((r) =>
        r.id === runId
          ? { ...r, status: "running", trigger_event_id: trigger.id }
          : r,
      ),
    };
    block({ kind: "deployment_ready", target_id: next });
    finish();
    event("host_deployment_recorded", {
      to: next,
      status: "deployed",
      ready: true,
    });
    expect(item()?.reported_blocker?.auto_resume_disabled).toBe(true);
    expect(scan().data).toEqual([]);
  },
);
