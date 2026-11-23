import { expect, test } from "vitest";
import { completeHumanAction, triageHumanAction } from "./coordination.js";
import {
  completeVerifiedHelperAction,
  controlDeployment,
  currentDeploymentPin,
  reconcileSupervisorNotice,
  recordDeployment,
  recordDeploymentStop,
  recordHelperUpgradeChecks,
  requestDeploymentAction,
  retireVerifiedHelperAction,
} from "./deployment.js";
import { listNeedsYou } from "./queries.js";

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

test.each([
  "waiting_for_evidence",
  "waiting_for_capacity",
  "waiting_for_batch",
  "waiting_for_operations",
] as const)(
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

test("C-609: operation waits carry bounded, copied host records and grant no transition", () => {
  const state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  const op = {
    kind: "mobile_signing",
    project_id: "sensen",
    card_id: "C-14",
    label: "受管送签（android）",
    started_at: now,
  };
  const deferred = [op];
  const effect = value(
    recordDeployment(
      state,
      system,
      {
        ...record,
        status: "stopping",
        deferred_operations: deferred,
        interrupted_operations: [{ ...op, card_id: null }],
        batch_window_ms: 300000,
      },
      ports(),
    ),
  );
  expect(effect.changes).toEqual([]);
  expect(effect.events[0]?.payload).toMatchObject({
    deferred_operations: [op],
    interrupted_operations: [{ ...op, card_id: null }],
    batch_window_ms: 300000,
  });
  const payload = effect.events[0]?.payload as
    | { deferred_operations?: unknown }
    | undefined;
  expect(payload?.deferred_operations).not.toBe(deferred);
  for (const invalid of [
    { deferred_operations: [{ ...op, label: "" }] },
    { deferred_operations: [{ ...op, label: "x".repeat(201) }] },
    { interrupted_operations: [{ ...op, card_id: 7 }] },
    { interrupted_operations: Array.from({ length: 51 }, () => op) },
    { deferred_operations: "signing" },
    { batch_window_ms: 0 },
    { batch_window_ms: 1.5 },
  ])
    expect(
      recordDeployment(
        state,
        system,
        { ...record, ...(invalid as object) },
        ports(),
      ).ok,
    ).toBe(false);
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

test("only verified system evidence retires the matching open manual helper action, without reporting it done", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system", project_id: state.project_id } as const;
  const target = {
    machine_id: "remote",
    binding: "pinned",
    key: helperKey("remote"),
  };
  const request = value(
    requestDeploymentAction(
      state,
      system,
      {
        ...target,
        reason: "worker_maintenance",
        instructions: "manual upgrade",
        helper_upgrade: {
          machine_id: target.machine_id,
          binding: target.binding,
        },
      },
      io,
    ),
  );
  state = apply(state, request);
  for (const caller of [
    human,
    actor(5, "host_ops"),
    { ...system, project_id: "other" },
  ])
    expect(retireVerifiedHelperAction(state, caller, target, io).ok).toBe(
      false,
    );
  for (const different of [
    { key: helperKey("remote", "b") },
    { machine_id: "neighbor" },
    { binding: "other" },
  ])
    expect(
      value(
        retireVerifiedHelperAction(
          state,
          system,
          { ...target, ...different },
          io,
        ),
      ).events,
    ).toEqual([]);
  const result = value(retireVerifiedHelperAction(state, system, target, io));
  expect(result.events.map((e) => e.type)).toEqual(["human_action_cancelled"]);
  state = apply(state, result);
  expect(
    state.human_actions.find((a) => a.id === request.data.id),
  ).toMatchObject({
    status: "cancelled",
    cancellation: { by: "system", source: "worker_helper_superseded" },
  });
  expect(
    value(retireVerifiedHelperAction(state, system, target, io)).events,
  ).toEqual([]);
});

test("patrol completes only a matching open helper action with two passed checks, once", () => {
  const io = ports(),
    machine_id = "remote";
  const system = { kind: "system", project_id: human.project_id } as const;
  const state = {
    ...fixture(),
    machines: [{ ...machine(), id: machine_id, herdr_machine: machine_id }],
  };
  const key = helperKey(machine_id),
    binding = "pinned";
  const opened = value(
    requestDeploymentAction(
      state,
      system,
      {
        key,
        reason: "worker_maintenance",
        instructions: "private text",
        helper_upgrade: { machine_id, binding },
      },
      io,
    ),
  );
  const pending = apply(state, opened);
  const passed = { status: "passed", failed_steps: [] } as const;
  const proof = {
    human_action_id: opened.data.id,
    machine_id,
    binding,
    key,
    checks: { worker: passed, machine: passed },
  };
  for (const caller of [
    human,
    actor(5, "host_ops"),
    { ...system, project_id: "other" },
  ])
    expect(completeVerifiedHelperAction(pending, caller, proof, io).ok).toBe(
      false,
    );
  for (const change of [
    { key: helperKey(machine_id, "b") },
    { machine_id: "other" },
    { binding: "other" },
    {
      checks: {
        worker: passed,
        machine: { ...passed, failed_steps: ["mismatch"] },
      },
    },
  ])
    expect(
      value(
        completeVerifiedHelperAction(
          pending,
          system,
          { ...proof, ...change },
          io,
        ),
      ).events,
    ).toEqual([]);
  const needs = (s: typeof pending) =>
    value(listNeedsYou(s, human)).data.human_actions.map((h) => h.id);
  expect(needs(pending)).toContain(opened.data.id);
  const result = value(
    completeVerifiedHelperAction(pending, system, proof, io),
  );
  expect(result.events.map((e) => e.type)).toEqual([
    "worker_helper_upgrade_checked",
    "human_action_completed",
  ]);
  expect(result.events[1]).toMatchObject({
    actor: system,
    created_at: now,
    payload: { result: expect.stringContaining(machine_id) },
  });
  expect(JSON.stringify(result.events)).not.toMatch(/private text|pinned/);
  const done = apply(pending, result);
  expect(needs(done)).not.toContain(opened.data.id);
  expect(
    value(completeVerifiedHelperAction(done, system, proof, io)).events,
  ).toEqual([]);
});
