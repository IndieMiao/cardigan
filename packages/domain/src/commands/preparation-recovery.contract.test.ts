import { beforeEach, expect, test } from "vitest";
import {
  abortDispatch,
  preparationAwaitsDeployment,
  preparationRetryWaiting,
  type Run,
  recordDeployment,
  recoverPreparation,
  retryPreparationAfterDeployment,
  stopWorkItemAssignment,
  updateCard,
} from "../index.js";
import {
  actor,
  commit,
  dispatch,
  f,
  queue,
  setup,
  system,
} from "./launch/test-fixtures.js";

let run: Run;
let now: number;
beforeEach(() => {
  setup();
  now = Date.parse(f.io.clock.now());
  f.io = { ...f.io, clock: { now: () => new Date(now).toISOString() } };
  run = commit(queue());
  commit(
    abortDispatch(
      f.state,
      system,
      { run_id: run.id, reason: "directory preparation failed" },
      f.io,
    ),
  );
});
const recover = (
  overrides: Partial<Parameters<typeof recoverPreparation>[2]> = {},
) =>
  recoverPreparation(
    f.state,
    system,
    {
      run_id: run.id,
      category: "repository_lock_timeout",
      execution_exited: true,
      cleanup_complete: true,
      expected_runtime_ref: null,
      backoff_ms: 5000,
      ...overrides,
    },
    f.io,
  );

test("cancellation stays final; one durable successor retains snapshots and enforces backoff", () => {
  const next = commit(recover());
  expect(next).toMatchObject({
    kind: run.kind,
    model: run.model,
    role_version: run.role_version,
    preparation_retry: {
      source_run_id: run.id,
      ready_at: new Date(now + 5000).toISOString(),
    },
  });
  expect(f.state.runs.find((r) => r.id === run.id)?.status).toBe("cancelled");
  expect(commit(recover())).toBeUndefined();
  expect(f.state.runs).toHaveLength(2);
  if (!next) throw new Error("Missing successor");
  expect(dispatch(next)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  now += 5000;
  expect(commit(dispatch(next)).status).toBe("dispatched");
});

test("reloaded recovery history cannot duplicate a successor or reset the chain budget", () => {
  const next = commit(recover());
  if (!next) throw new Error("Missing successor");
  f.state = JSON.parse(JSON.stringify(f.state));
  commit(recover());
  let last = next;
  // Two more retries on the long schedule, then the budget is used up.
  for (let i = 0; i < 3; i++) {
    commit(
      abortDispatch(
        f.state,
        system,
        { run_id: last.id, reason: "directory preparation failed" },
        f.io,
      ),
    );
    const successor = commit(recover({ run_id: last.id }));
    commit(recover({ run_id: last.id }));
    f.state = JSON.parse(JSON.stringify(f.state));
    if (successor) last = successor;
  }
  expect(f.state.runs).toHaveLength(4);
  expect(f.state.human_actions).toHaveLength(1);
  expect(
    f.state.events.filter((e) => e.type === "run_preparation_stalled"),
  ).toHaveLength(1);
});

test.each([
  { execution_exited: false, category: "git_timeout" },
  { cleanup_complete: false },
  { category: "permission_denied" },
  { category: "config_error" },
  { category: "unclassified" },
])(
  "unconfirmed exit, failed cleanup and permission/config failures never requeue: %j",
  (overrides) => {
    commit(recover(overrides));
    expect(f.state.runs).toHaveLength(1);
    expect(f.state.human_actions).toHaveLength(1);
    expect(f.state.human_actions[0]?.triage).toBe("human");
    expect(
      f.state.events.find((e) => e.type === "run_preparation_stalled")?.payload,
    ).not.toHaveProperty("exhausted");
  },
);

// C-738: a failure with exit proof (e.g. the readonly target was not readable
// yet) retries after 5, 15 and 60 minutes, then goes to PM with the reason.
test("prepare_failed retries on the long schedule, then hands PM the reason and count", () => {
  const message = "No current Git delivery for readonly work item W-413";
  const failed = { category: "prepare_failed", message };
  const delays: number[] = [];
  let last = run;
  for (const _ of [1, 2, 3]) {
    const next = commit(recover({ ...failed, run_id: last.id }));
    if (!next?.preparation_retry) throw new Error("Missing successor");
    delays.push(Date.parse(next.preparation_retry.ready_at) - now);
    expect(dispatch(next)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    now = Date.parse(next.preparation_retry.ready_at);
    commit(
      abortDispatch(
        f.state,
        system,
        { run_id: next.id, reason: "directory preparation failed" },
        f.io,
      ),
    );
    last = next;
  }
  expect(delays).toEqual([300_000, 900_000, 3_600_000]);
  const recovered = f.state.events.filter(
    (e) => e.type === "run_preparation_recovered",
  );
  expect(recovered.map((e) => e.payload)).toMatchObject([
    { attempt: 1, max_retries: 3, message, category: "prepare_failed" },
    { attempt: 2, max_retries: 3, message },
    { attempt: 3, max_retries: 3, message },
  ]);
  expect(commit(recover({ ...failed, run_id: last.id }))).toBeUndefined();
  expect(f.state.runs).toHaveLength(4);
  const stalled = f.state.events.find(
    (e) => e.type === "run_preparation_stalled",
  );
  expect(stalled?.payload).toMatchObject({
    exhausted: true,
    attempt: 4,
    max_retries: 3,
    category: "prepare_failed",
    message,
  });
  expect(f.state.human_actions).toMatchObject([
    { triage: "pm_ops", status: "open", requested_by: "system" },
  ]);
  const handoff = f.state.human_actions[0]?.instructions ?? "";
  expect(handoff).toContain(message);
  expect(handoff).toContain("已自动重试 3 次");
  expect(handoff).toContain("建议");
});

test("a transient first failure keeps the short backoff; the host schedule sets the limit", () => {
  const first = commit(recover({ retry_schedule_ms: [60_000] }));
  expect(first?.preparation_retry?.ready_at).toBe(
    new Date(now + 5000).toISOString(),
  );
  if (!first) throw new Error("Missing successor");
  commit(
    abortDispatch(
      f.state,
      system,
      { run_id: first.id, reason: "directory preparation failed" },
      f.io,
    ),
  );
  expect(
    commit(recover({ run_id: first.id, retry_schedule_ms: [60_000] })),
  ).toBeUndefined();
  expect(f.state.human_actions).toMatchObject([{ triage: "pm_ops" }]);
  expect(recover({ retry_schedule_ms: [] })).toMatchObject({ ok: false });
  expect(recover({ retry_schedule_ms: [0] })).toMatchObject({ ok: false });
});

test("only a host system can supply preparation evidence", () => {
  const params = {
    run_id: run.id,
    category: "git_timeout",
    execution_exited: true,
    cleanup_complete: true,
    expected_runtime_ref: null,
    backoff_ms: 5000,
  };
  expect(recoverPreparation(f.state, actor(), params, f.io)).toMatchObject({
    ok: false,
  });
  expect(
    recoverPreparation(
      f.state,
      { kind: "human", project_id: f.state.project_id },
      params,
      f.io,
    ),
  ).toMatchObject({ ok: false });
});

test("card cancellation and a concurrent replacement defeat stale recovery", () => {
  const card = f.state.cards[0];
  if (!card) throw new Error("Missing card");
  commit(
    updateCard(
      f.state,
      { kind: "human", project_id: f.state.project_id },
      { card_id: card.id, status: "cancelled" },
      f.io,
    ),
  );
  commit(recover());
  expect(f.state.runs).toHaveLength(1);
  expect(f.state.human_actions).toHaveLength(0);
});

test("a new pending Run prevents a late preparation failure from adding another", () => {
  commit(queue());
  commit(recover());
  expect(f.state.runs).toHaveLength(2);
  expect(
    f.state.events.filter((e) => e.type === "run_preparation_recovered"),
  ).toHaveLength(0);
});

test("human stop prevents a delayed failure from restoring execution", () => {
  commit(
    stopWorkItemAssignment(
      f.state,
      { kind: "human", project_id: f.state.project_id },
      { assignment_id: f.coder.id, reason: "human stop" },
      f.io,
    ),
  );
  commit(recover());
  expect(f.state.runs).toHaveLength(1);
  expect(
    f.state.events.filter((e) => e.type === "run_preparation_recovered"),
  ).toHaveLength(0);
});

test("confirmed Git timeout can retry while a changed runtime reference cannot", () => {
  commit(
    recover({
      category: "git_timeout",
      expected_runtime_ref: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "other",
        agent_name: "other",
      },
    }),
  );
  expect(f.state.runs).toHaveLength(1);
  const next = commit(recover({ category: "git_timeout" }));
  expect(next?.preparation_retry?.source_run_id).toBe(run.id);
});

// C-738: every ready deployment retries each earlier preparation failure once.
const deploy = (to: string) =>
  commit(
    recordDeployment(
      f.state,
      system,
      {
        attempt: `fixture-${to}`,
        from: "a".repeat(40),
        to,
        status: "deployed",
        ready: true,
        build: "passed",
        downtime_ms: 0,
        summary: "deployed",
      },
      f.io,
    ),
  );
const afterDeploy = (sha: string) =>
  commit(retryPreparationAfterDeployment(f.state, system, { sha }, f.io));
const failAgain = (r: Run, overrides = {}) => {
  commit(
    abortDispatch(
      f.state,
      system,
      { run_id: r.id, reason: "directory preparation failed" },
      f.io,
    ),
  );
  return commit(recover({ run_id: r.id, ...overrides }));
};

test("a later deployment ends a pending backoff once; an earlier one does not", () => {
  deploy("b".repeat(40));
  now += 1000;
  const next = commit(recover({ category: "prepare_failed" }));
  if (!next) throw new Error("Missing successor");
  expect(afterDeploy("b".repeat(40))).toEqual({ expedited: [], queued: [] });
  expect(preparationAwaitsDeployment(f.state, f.io.clock.now())).toBe(true);
  now += 60_000;
  deploy("c".repeat(40));
  now += 1000;
  expect(afterDeploy("c".repeat(40))).toEqual({
    expedited: [next.id],
    queued: [],
  });
  const stored = f.state.runs.find((r) => r.id === next.id);
  if (!stored) throw new Error("Missing successor");
  expect(stored.preparation_retry).toMatchObject({
    ready_at: next.preparation_retry?.ready_at,
    expedited: { at: new Date(now).toISOString() },
  });
  expect(preparationRetryWaiting(stored, f.io.clock.now())).toBe(false);
  expect(
    f.state.events.filter((e) => e.type === "run_preparation_expedited"),
  ).toHaveLength(1);
  expect(preparationAwaitsDeployment(f.state, f.io.clock.now())).toBe(false);
  expect(afterDeploy("c".repeat(40))).toEqual({ expedited: [], queued: [] });
  expect(commit(dispatch(stored)).status).toBe("dispatched");
  // An unknown or unready SHA proves nothing.
  expect(afterDeploy("d".repeat(40))).toEqual({ expedited: [], queued: [] });
});

test("a used-up chain gets one retry per later deployment without a second PM handoff", () => {
  const schedule = { category: "prepare_failed", retry_schedule_ms: [1000] };
  const next = commit(recover(schedule));
  if (!next) throw new Error("Missing successor");
  now += 1000;
  expect(failAgain(next, schedule)).toBeUndefined();
  expect(f.state.human_actions).toHaveLength(1);
  now += 60_000;
  deploy("c".repeat(40));
  now += 1000;
  const { queued } = afterDeploy("c".repeat(40)) ?? { queued: [] };
  expect(queued).toHaveLength(1);
  const retry = f.state.runs.find((r) => r.id === queued[0]);
  if (!retry) throw new Error("Missing retry");
  expect(retry).toMatchObject({
    status: "queued",
    preparation_retry: {
      source_run_id: next.id,
      ready_at: new Date(now).toISOString(),
    },
  });
  expect(
    f.state.events.findLast((e) => e.type === "run_preparation_recovered")
      ?.payload,
  ).toMatchObject({ after_deployment: expect.any(String), attempt: 2 });
  expect(afterDeploy("c".repeat(40))).toEqual({ expedited: [], queued: [] });
  expect(preparationAwaitsDeployment(f.state, f.io.clock.now())).toBe(false);
  // It fails again: one more stall, still one open PM handoff.
  expect(failAgain(retry, schedule)).toBeUndefined();
  expect(
    f.state.events.filter((e) => e.type === "run_preparation_stalled"),
  ).toHaveLength(2);
  expect(f.state.human_actions).toHaveLength(1);
  expect(preparationAwaitsDeployment(f.state, f.io.clock.now())).toBe(true);
  now += 60_000;
  deploy("e".repeat(40));
  now += 1000;
  expect(afterDeploy("e".repeat(40))?.queued).toHaveLength(1);
  expect(f.state.runs).toHaveLength(4);
});

test("permission and configuration stalls are not retried after a deployment", () => {
  commit(recover({ category: "permission_denied" }));
  expect(preparationAwaitsDeployment(f.state, f.io.clock.now())).toBe(false);
  now += 1000;
  deploy("c".repeat(40));
  now += 1000;
  expect(afterDeploy("c".repeat(40))).toEqual({ expedited: [], queued: [] });
  expect(f.state.runs).toHaveLength(1);
});

test("a human stop after the stall defeats the after-deployment retry", () => {
  const schedule = { category: "prepare_failed", retry_schedule_ms: [1000] };
  const next = commit(recover(schedule));
  if (!next) throw new Error("Missing successor");
  now += 1000;
  failAgain(next, schedule);
  commit(
    stopWorkItemAssignment(
      f.state,
      { kind: "human", project_id: f.state.project_id },
      { assignment_id: f.coder.id, reason: "human stop" },
      f.io,
    ),
  );
  now += 1000;
  deploy("c".repeat(40));
  now += 1000;
  expect(afterDeploy("c".repeat(40))).toEqual({ expedited: [], queued: [] });
  expect(f.state.runs).toHaveLength(2);
});
