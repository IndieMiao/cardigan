import { expect, test } from "vitest";
import { completeHumanAction, triageHumanAction } from "./coordination.js";
import {
  controlDeployment,
  currentDeploymentPin,
  reconcileSupervisorNotice,
  recordDeployment,
  recordDeploymentStop,
  recordHelperUpgradeChecks,
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
  machine,
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

test.each(["waiting_for_evidence", "waiting_for_capacity"] as const)(
  "%s only records an observation and grants no workflow transition",
  (status) => {
    const state = fixture();
    const original = JSON.stringify(state);
    const effect = value(
      recordDeployment(
        state,
        { kind: "system", project_id: state.project_id },
        {
          ...record,
          status,
          build: "not_run",
          ready: false,
        },
        ports(),
      ),
    );
    expect(effect.events).toHaveLength(1);
    expect(effect.events[0]?.payload).toMatchObject({
      status,
      build: "not_run",
    });
    expect(effect.changes).toEqual([]);
    expect(JSON.stringify(state)).toBe(original);
  },
);

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

test("only system reconciles supervisor notices; a verified notice stays unique after restart, revert or manual handling", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  const input = {
    supervisor: "a".repeat(40),
    main: "b".repeat(40),
    affected: ["packages/host"],
  };
  const legacy = value(
    requestDeploymentAction(
      state,
      system,
      {
        key: `supervisor-outdated:${input.supervisor}`,
        instructions: "旧提醒",
      },
      io,
    ),
  );
  state = apply(state, legacy);
  for (const caller of [
    human,
    actor(1, "coder"),
    actor(5, "host_ops"),
    { ...system, project_id: "other" },
  ])
    expect(reconcileSupervisorNotice(state, caller, input, io).ok).toBe(false);
  for (const status of ["done", "cancelled"] as const) {
    const handled = { ...state, human_actions: [{ ...legacy.data, status }] };
    expect(
      value(reconcileSupervisorNotice(handled, system, input, io)).events,
    ).toEqual([]);
  }
  const adopted = value(reconcileSupervisorNotice(state, system, input, io));
  state = apply(state, adopted);
  expect(
    state.human_actions.find((h) => h.id === legacy.data.id)?.instructions,
  ).toContain("packages/host");
  expect(adopted.events.map((e) => e.type)).toEqual([
    "host_deployment_supervisor_change",
  ]);
  expect(
    value(reconcileSupervisorNotice(state, system, input, io)).changes,
  ).toEqual([]);
  const reverted = value(
    reconcileSupervisorNotice(state, system, { ...input, affected: [] }, io),
  );
  state = apply(state, reverted);
  expect(reverted.events).toMatchObject([
    {
      type: "human_action_cancelled",
      payload: {
        human_action_id: legacy.data.id,
        reason: expect.stringContaining("没有监督器运行差异"),
      },
    },
  ]);
  expect(
    value(reconcileSupervisorNotice(state, system, input, io)).events,
  ).toEqual([]);
});

// Terminal text is presentation, never evidence that the privileged work succeeded.
test("helper maintenance keeps a failed check open and rejects all ordinary completion routes", () => {
  let state = fixture();
  state = {
    ...state,
    machines: [{ ...machine(), id: "remote", herdr_machine: "remote" }],
  };
  const io = ports();
  const input = {
    key: helperKey("remote"),
    reason: "worker_maintenance" as const,
    instructions: "prepared",
    helper_upgrade: { machine_id: "remote", binding: "trusted" },
  };
  const effect = value(
    requestDeploymentAction(
      state,
      { kind: "system", project_id: state.project_id },
      input,
      io,
    ),
  );
  state = apply(state, effect);
  const p = { human_action_id: effect.data.id, text: "installed" };
  expect(completeHumanAction(state, human, p, io).ok).toBe(false);
  expect(
    triageHumanAction(
      state,
      human,
      {
        human_action_id: p.human_action_id,
        disposition: "done",
        rationale: "reported done",
      },
      io,
    ).ok,
  ).toBe(false);
  const passed = { status: "passed", failed_steps: [] } as const;
  const failed = { status: "failed", failed_steps: ["runtime"] } as const;
  const check = {
    ...p,
    binding: "trusted",
    machine_id: "remote",
    checks: { worker: passed, machine: failed },
  };
  expect(recordHelperUpgradeChecks(state, actor(4, "pm"), check, io).ok).toBe(
    false,
  );
  expect(
    recordHelperUpgradeChecks(state, human, { ...check, binding: "other" }, io)
      .ok,
  ).toBe(false);
  const attempt = value(recordHelperUpgradeChecks(state, human, check, io));
  expect(attempt.data).toMatchObject({
    status: "open",
    helper_checks: check.checks,
  });
  state = apply(state, attempt);
  expect(completeHumanAction(state, human, p, io).ok).toBe(false);
  expect(
    value(
      recordHelperUpgradeChecks(
        state,
        human,
        { ...check, checks: { worker: passed, machine: passed } },
        io,
      ),
    ).data,
  ).toMatchObject({
    status: "done",
    result: { text: "installed" },
    helper_checks: { worker: passed, machine: passed },
  });
});

test("an unbound worker notice can record an unavailable check but never complete", () => {
  const io = ports();
  let state = fixture();
  const opened = value(
    requestDeploymentAction(
      state,
      { kind: "system", project_id: state.project_id },
      {
        key: helperKey("remote"),
        reason: "worker_maintenance",
        instructions: "binding unavailable",
        helper_upgrade: { machine_id: "remote", binding: null },
      },
      io,
    ),
  );
  state = apply(state, opened);
  const p = {
    human_action_id: opened.data.id,
    text: "installed",
    binding: null,
    machine_id: "remote",
  };
  const passed = { status: "passed", failed_steps: [] } as const;
  const failed = { status: "failed", failed_steps: ["binding"] } as const;
  expect(completeHumanAction(state, human, p, io).ok).toBe(false);
  expect(
    recordHelperUpgradeChecks(
      state,
      human,
      { ...p, checks: { worker: passed, machine: passed } },
      io,
    ).ok,
  ).toBe(false);
  expect(
    value(
      recordHelperUpgradeChecks(
        state,
        human,
        { ...p, checks: { worker: failed, machine: failed } },
        io,
      ),
    ).data,
  ).toMatchObject({
    status: "open",
    helper_checks: { worker: failed, machine: failed },
  });
});

function helperKey(machine: string, digest = "a") {
  return `worker-helper:${machine}:${Array(3).fill(digest.repeat(64)).join(":")}`;
}

test("legacy helper identity comes only from the project's system creation event, not the text", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system", project_id: state.project_id } as const;
  const open = (key: string) => {
    const effect = value(
      requestDeploymentAction(
        state,
        system,
        {
          key,
          instructions: "worker-helper:remote",
          reason: "worker_maintenance",
        },
        io,
      ),
    );
    state = apply(state, effect);
    return { human_action_id: effect.data.id, text: "done" };
  };
  for (const key of [helperKey("remote"), "worker-helper:unknown-format"]) {
    const action = open(key);
    expect(completeHumanAction(state, human, action, io).ok).toBe(false);
    expect(
      triageHumanAction(
        state,
        human,
        { ...action, disposition: "done", rationale: "done" },
        io,
      ).ok,
    ).toBe(false);
    const events = state.events.map((e) => ({
      ...e,
      actor: { ...system, project_id: "other" },
    }));
    expect(
      completeHumanAction({ ...state, events }, human, action, io).ok,
    ).toBe(true);
  }
  const ordinary = open("worker-cooldown:remote");
  expect(completeHumanAction(state, human, ordinary, io).ok).toBe(true);
});

test("a new helper generation cancels only the previous open notice for that exact machine", () => {
  const io = ports();
  let state = fixture();
  const request = (machine_id: string, digest: string) => {
    const effect = value(
      requestDeploymentAction(
        state,
        { kind: "system", project_id: state.project_id },
        {
          key: helperKey(machine_id, digest),
          instructions: "upgrade",
          reason: "worker_maintenance",
          helper_upgrade: { machine_id, binding: "trusted" },
        },
        io,
      ),
    );
    state = apply(state, effect);
    return effect.data.id;
  };
  const first = request("remote", "a"),
    neighbor = request("remote-2", "a"),
    current = request("remote", "b");
  expect(request("remote", "b")).toBe(current);
  expect(state.human_actions.find((h) => h.id === first)).toMatchObject({
    status: "cancelled",
    cancellation: { source: "worker_helper_superseded" },
  });
  expect(
    state.human_actions.filter((h) => h.status === "open").map((h) => h.id),
  ).toEqual([neighbor, current]);
});
