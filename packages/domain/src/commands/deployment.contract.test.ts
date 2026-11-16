import { expect, test } from "vitest";
import {
  controlDeployment,
  currentDeploymentPin,
  recordDeployment,
  recordDeploymentStop,
  requestDeploymentAction,
} from "./deployment.js";

test("deployment controls are human-only and bind exact versions without forging merge evidence", () => {
  let state = fixture();
  const io = ports();
  const pin = {
    action: "pin",
    sha: "a".repeat(40),
    tree: "b".repeat(40),
    reason: "Reviewed rollback",
  } as const;
  for (const caller of [
    actor(),
    actor(4, "pm"),
    actor(5, "host_ops"),
    { kind: "system", project_id: state.project_id } as const,
    { ...human, project_id: "other" },
  ])
    expect(controlDeployment(state, caller, pin, io).ok).toBe(false);
  for (const input of [
    { ...pin, sha: "main" },
    { ...pin, reason: " " },
    {
      action: "adopt",
      from: pin.sha,
      to: pin.sha,
      tree: pin.tree,
      reason: pin.reason,
    } as const,
  ])
    expect(controlDeployment(state, human, input, io).ok).toBe(false);
  const effect = value(controlDeployment(state, human, pin, io));
  expect(effect.changes).toEqual([]);
  expect(effect.events.map((e) => e.type)).toEqual([
    "host_deployment_controlled",
  ]);
  state = apply(state, effect);
  expect(currentDeploymentPin(state.events)?.sha).toBe(pin.sha);
  expect(
    currentDeploymentPin(
      state.events.map((e) => ({
        ...e,
        actor: { kind: "system", project_id: state.project_id },
      })),
    ),
  ).toBeUndefined();
  state = apply(
    state,
    value(
      controlDeployment(
        state,
        human,
        { action: "unpin", reason: "Resume main" },
        io,
      ),
    ),
  );
  expect(currentDeploymentPin(state.events)).toBeUndefined();
  expect(
    value(
      controlDeployment(
        state,
        human,
        { action: "unpin", reason: "Already resumed" },
        io,
      ),
    ).events,
  ).toEqual([]);
});

import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  run,
  value,
} from "./test-fixtures.js";

const record = {
  attempt: "attempt",
  from: "a".repeat(40),
  to: "b".repeat(40),
  status: "deployed" as const,
  build: "passed" as const,
  ready: true,
  downtime_ms: 10,
  summary: "ready",
};

test("deployment audit is system-only; no Agent can forge a successful deployment", () => {
  const state = fixture();
  for (const caller of [
    human,
    actor(1, "coder"),
    actor(4, "pm"),
    actor(5, "host_ops"),
    { kind: "system" as const, project_id: "other" },
  ]) {
    expect(recordDeployment(state, caller, record, ports()).ok).toBe(false);
    expect(recordDeploymentStop(state, caller, record, ports()).ok).toBe(false);
    expect(
      requestDeploymentAction(
        state,
        caller,
        { key: "key", instructions: "help" },
        ports(),
      ).ok,
    ).toBe(false);
  }
  const system = { kind: "system" as const, project_id: state.project_id };
  const result = value(recordDeployment(state, system, record, ports()));
  expect(result.events[0]).toMatchObject({
    type: "host_deployment_recorded",
    actor: system,
    payload: record,
  });
  expect(
    recordDeployment(state, system, { ...record, from: "main" }, ports()).ok,
  ).toBe(false);
});

test("stopping snapshots only running Runs and preserves every workflow state", () => {
  const state = fixture();
  const before = {
    ...state,
    runs: [
      run(1),
      { ...run(2), status: "queued" as const },
      { ...run(3), status: "completed" as const },
      run(4),
    ],
  };
  const original = JSON.stringify(before);
  const effect = value(
    recordDeploymentStop(
      before,
      { kind: "system", project_id: state.project_id },
      record,
      ports(),
    ),
  );
  expect(effect.data.status).toBe("stopping");
  expect(effect.data.stop_snapshot).toEqual({
    captured_at: now,
    runs: [
      {
        run_id: id("run", 1),
        assignment_id: id("assignment", 1),
        card_id: id("card", 1),
      },
      {
        run_id: id("run", 4),
        assignment_id: id("assignment", 4),
        card_id: null,
      },
    ],
  });
  expect(effect.events[0]?.payload).toMatchObject({
    stop_snapshot: effect.data.stop_snapshot,
  });
  expect(effect.changes).toEqual([]);
  expect(JSON.stringify(before)).toBe(original);
  const finished = value(
    recordDeployment(
      before,
      { kind: "system", project_id: state.project_id },
      { ...effect.data, status: "rolled_back" },
      ports(),
    ),
  );
  expect(finished.data.stop_snapshot).toEqual(effect.data.stop_snapshot);
});

test("waiting for publication evidence only records an observation and grants no workflow transition", () => {
  const state = fixture();
  const original = JSON.stringify(state);
  const effect = value(
    recordDeployment(
      state,
      { kind: "system", project_id: state.project_id },
      {
        ...record,
        status: "waiting_for_evidence",
        build: "not_run",
        ready: false,
      },
      ports(),
    ),
  );
  expect(effect.events).toHaveLength(1);
  expect(effect.events[0]?.payload).toMatchObject({
    status: "waiting_for_evidence",
    build: "not_run",
  });
  expect(effect.changes).toEqual([]);
  expect(JSON.stringify(state)).toBe(original);
});

test("backup evidence accepts only generated basenames, never paths or free text", () => {
  const state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  const name = "database-00000000-0000-0000-0000-000000000001.bak";
  expect(
    value(
      recordDeployment(
        state,
        system,
        { ...record, backup_file: name },
        ports(),
      ),
    ).data.backup_file,
  ).toBe(name);
  for (const name of [
    "../database.bak",
    "/private/database.bak",
    "TOKEN=synthetic-secret",
    "arbitrary.bak",
  ])
    expect(
      recordDeployment(state, system, { ...record, backup_file: name }, ports())
        .ok,
    ).toBe(false);
});

test("permission-widening followup stays with the human and is idempotent", () => {
  const state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  const p = { key: "role:pm:version", instructions: "Review the dry-run diff" };
  const effect = value(requestDeploymentAction(state, system, p, ports()));
  expect(effect.data).toMatchObject({
    status: "open",
    triage: "human",
    requested_by: "system",
  });
  const again = value(
    requestDeploymentAction(apply(state, effect), system, p, ports()),
  );
  expect(again.events).toEqual([]);
  expect(again.data.id).toBe(effect.data.id);
});

test("evidence wait actions go to Ops, remain idempotent after completion and do not authorize deployment", () => {
  const state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  const input = {
    key: "deployment-evidence:target",
    instructions: "核对门禁证据",
    reason: "evidence_wait" as const,
  };
  const effect = value(requestDeploymentAction(state, system, input, ports()));
  expect(effect.data).toMatchObject({
    triage: "pm_ops",
    status: "open",
    blocked_work_items: [],
  });
  const next = apply(state, effect);
  expect(next.cards).toEqual(state.cards);
  expect(next.work_items).toEqual(state.work_items);
  expect(next.runs).toEqual(state.runs);
  const completed = {
    ...next,
    human_actions: next.human_actions.map((h) => ({
      ...h,
      status: "done" as const,
    })),
  };
  expect(
    value(requestDeploymentAction(completed, system, input, ports())).events,
  ).toEqual([]);
  for (const caller of [
    human,
    actor(1, "coder"),
    actor(4, "pm"),
    actor(5, "host_ops"),
  ])
    expect(requestDeploymentAction(state, caller, input, ports()).ok).toBe(
      false,
    );
});
