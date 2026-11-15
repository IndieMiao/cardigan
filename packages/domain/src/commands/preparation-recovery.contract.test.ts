import { beforeEach, expect, test } from "vitest";
import {
  abortDispatch,
  type Run,
  recoverPreparation,
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

test("reloaded recovery history cannot create a second successor or reset the budget", () => {
  const next = commit(recover());
  if (!next) throw new Error("Missing successor");
  f.state = JSON.parse(JSON.stringify(f.state));
  commit(recover());
  commit(
    abortDispatch(
      f.state,
      system,
      { run_id: next.id, reason: "directory preparation failed" },
      f.io,
    ),
  );
  commit(recover({ run_id: next.id }));
  commit(recover({ run_id: next.id }));
  expect(f.state.runs).toHaveLength(2);
  expect(f.state.human_actions).toHaveLength(1);
  expect(
    f.state.events.filter((e) => e.type === "run_preparation_stalled"),
  ).toHaveLength(1);
});

test.each([
  { execution_exited: false, category: "git_timeout" },
  { cleanup_complete: false },
  { category: "prepare_failed" },
])(
  "unconfirmed exit, failed cleanup and permanent failures never requeue: %j",
  (overrides) => {
    commit(recover(overrides));
    expect(f.state.runs).toHaveLength(1);
    expect(f.state.human_actions).toHaveLength(1);
  },
);

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
