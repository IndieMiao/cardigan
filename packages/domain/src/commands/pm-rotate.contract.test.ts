import { expect, test } from "vitest";
import type {
  Actor,
  Assignment,
  CommandState,
  Decision,
  EmployeeId,
  HumanAction,
  RoleReference,
} from "../index.js";
import {
  postComment,
  rotatePmAfterDeployment,
  rotateStandingPm,
  STANDING_ROLE_TOOLS,
  standingTools,
} from "../index.js";
import { CommandDraft } from "./core.js";
import { hasActivePmOps } from "./delegation.js";
import {
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  run,
  value,
} from "./test-fixtures.js";

const legacyTools = STANDING_ROLE_TOOLS.filter(
  (t) => !["resolve_delegated_decision", "triage_human_action"].includes(t),
);
const pmRole = (version: number, tools = [...STANDING_ROLE_TOOLS]) =>
  ({
    role_id: "pm",
    role_version: version,
    allowed_tools: tools,
    capabilities: ["verify"],
  }) satisfies RoleReference;

function standing(n: number, mode: "ops" | "office"): Assignment {
  return {
    id: id("assignment", n),
    scope: "standing",
    standing_mode: mode,
    role_id: "pm",
    role_version: 2,
    status: "active",
    runtime_state: "running",
    machine_id: "local",
    runtime_ref: {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: `t-${n}`,
      agent_name: `pm-${mode}`,
    },
    mcp_token_id: `token-${n}`,
    created_at: now,
  };
}

/** Real project shape: pm v2 is on duty, the human then appended v3. */
function setup(newTools = [...STANDING_ROLE_TOOLS]) {
  const base = fixture();
  const ops = standing(10, "ops");
  const office = standing(11, "office");
  const decision: Decision = {
    id: id("decision", 1),
    key: id("decision", 1),
    card_id: id("card", 1),
    raised_by: `assignment:${id("assignment", 1)}`,
    kind: "choose",
    category: "general",
    delegation_authority: "project:fixture-project/default/general",
    question: "继续？",
    context: "上下文",
    options: [{ key: "go", description: "继续", impact: "推进" }],
    recommended: "go",
    affected_cards: [id("card", 1)],
    affected_work_items: [],
    blocking: false,
    decider: "role:pm",
    doc_refs: [],
    status: "open",
  };
  const action: HumanAction = {
    id: id("human_action", 1),
    key: id("human_action", 1),
    card_id: id("card", 1),
    requested_by: `assignment:${id("assignment", 1)}`,
    instructions: "登录",
    why_human: "需要人",
    expected_return: "完成",
    blocked_work_items: [],
    status: "open",
    triage: "pm_ops",
  };
  const opsRun = { ...run(20, 10), role_version: 2 };
  const state: CommandState = {
    ...base,
    roles: [
      ...base.roles.filter((r) => r.role_id !== "pm"),
      pmRole(1, legacyTools),
      pmRole(2, legacyTools),
      pmRole(3, newTools),
    ],
    assignments: [
      ...base.assignments.filter((a) => a.scope !== "standing"),
      ops,
      office,
    ],
    runs: [...base.runs, opsRun],
    decisions: [decision],
    human_actions: [action],
    cursors: [{ assignment_id: ops.id, card_id: id("card", 1), acked_seq: 7 }],
  };
  return { state, ops, office, decision, action, opsRun };
}
const draft = (state: CommandState) =>
  new CommandDraft(state, human, "get_updates", ports());

test("rotate puts a new Ops on the newest version and releases the old one atomically", () => {
  const x = setup();
  expect(hasActivePmOps(draft(x.state))).toBe(true);
  expect(hasActivePmOps(draft(x.state), "resolve_delegated_decision")).toBe(
    false,
  );
  const effect = value(
    rotateStandingPm(x.state, human, { standing_mode: "ops" }, ports()),
  );
  const after = apply(x.state, effect);
  const data = effect.data;
  expect(data.unchanged).toBe(false);
  expect(data.from_version).toBe(2);
  expect(data.to_version).toBe(3);
  expect(data.assignment).toMatchObject({
    scope: "standing",
    standing_mode: "ops",
    role_id: "pm",
    role_version: 3,
    status: "active",
    runtime_state: "not_provisioned",
    runtime_ref: null,
  });
  // The new one is written before the old one is released: no window.
  const writes = effect.changes
    .filter((c) => c.collection === "assignments")
    .map((c) => c.entity as Assignment);
  expect(writes.map((a) => [a.id, a.status])).toEqual([
    [data.assignment.id, "active"],
    [x.ops.id, "released"],
  ]);
  const old = after.assignments.find((a) => a.id === x.ops.id);
  expect(old).toMatchObject({ status: "released", runtime_state: "released" });
  expect(hasActivePmOps(draft(after))).toBe(true);
  expect(hasActivePmOps(draft(after), "resolve_delegated_decision")).toBe(true);
  expect(hasActivePmOps(draft(after), "triage_human_action")).toBe(true);
  // The Office is untouched.
  expect(after.assignments.find((a) => a.id === x.office.id)).toEqual(x.office);
  // The old Run is cancelled; the cursor carries over.
  expect(after.runs.find((r) => r.id === x.opsRun.id)?.status).toBe(
    "cancelled",
  );
  expect(data.cancelled_run_ids).toEqual([x.opsRun.id]);
  expect(after.cursors).toContainEqual({
    assignment_id: data.assignment.id,
    card_id: id("card", 1),
    acked_seq: 7,
  });
  expect(effect.events.map((e) => e.type)).toEqual([
    "assignment_released",
    "standing_pm_rotated",
  ]);
  expect(effect.events[0]?.payload).toMatchObject({
    assignment_id: x.ops.id,
    token_id: x.ops.mcp_token_id,
    replaced_by: data.assignment.id,
  });
});

test("rotate transfers PM items to the new Assignment and hands nothing back to the human", () => {
  const x = setup();
  const effect = value(
    rotateStandingPm(x.state, human, { standing_mode: "ops" }, ports()),
  );
  const after = apply(x.state, effect);
  expect(effect.data.decisions).toEqual([x.decision.id]);
  expect(effect.data.human_actions).toEqual([x.action.id]);
  expect(after.decisions.find((q) => q.id === x.decision.id)).toEqual(
    x.decision,
  );
  expect(after.human_actions.find((h) => h.id === x.action.id)).toEqual(
    x.action,
  );
  expect(
    effect.events.some((e) =>
      ["decision_requested", "human_action_requested"].includes(e.type),
    ),
  ).toBe(false);
  expect(effect.changes.map((c) => c.collection)).not.toContain("decisions");
  expect(effect.changes.map((c) => c.collection)).not.toContain(
    "human_actions",
  );
});

test("the old Assignment's identity stops working after rotate", () => {
  const x = setup();
  const after = apply(
    x.state,
    value(rotateStandingPm(x.state, human, { standing_mode: "ops" }, ports())),
  );
  const oldActor: Actor = {
    kind: "assignment",
    project_id: human.project_id,
    assignment_id: x.ops.id,
    ...pmRole(2, legacyTools),
    allowed_tools: standingTools(legacyTools, "ops"),
  };
  const result = postComment(
    after,
    oldActor,
    { card_id: id("card", 1), body: "还在吗" },
    ports(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("unauthorized");
});

test("rotate fails as a whole when a later step is rejected", () => {
  const x = setup();
  // An inconsistent row: the release transition fails after the new
  // Assignment, the cursor copy and the Run cancellation were drafted.
  const broken = {
    ...x.state,
    assignments: x.state.assignments.map((a) =>
      a.id === x.ops.id ? { ...a, runtime_state: "released" as const } : a,
    ),
  };
  const result = rotateStandingPm(
    broken,
    human,
    { standing_mode: "ops" },
    ports(),
  );
  expect(result.ok).toBe(false);
  expect("value" in result).toBe(false);
});

test("rotate with the same version changes nothing", () => {
  const x = setup();
  const same = {
    ...x.state,
    roles: x.state.roles.filter((r) => r.role_version !== 3),
  };
  const effect = value(
    rotateStandingPm(same, human, { standing_mode: "ops" }, ports()),
  );
  expect(effect.data.unchanged).toBe(true);
  expect(effect.data.assignment).toEqual(x.ops);
  expect(effect.changes).toEqual([]);
  expect(effect.events).toEqual([]);
});

test("only the human can rotate a standing PM", () => {
  const x = setup();
  const pm: Actor = {
    kind: "assignment",
    project_id: human.project_id,
    assignment_id: x.ops.id,
    ...pmRole(2, legacyTools),
    allowed_tools: standingTools(legacyTools, "ops"),
  };
  for (const who of [
    pm,
    { kind: "system", project_id: human.project_id } as Actor,
  ]) {
    const result = rotateStandingPm(
      x.state,
      who,
      { standing_mode: "ops" },
      ports(),
    );
    expect(result.ok).toBe(false);
  }
});

test("rotate refuses a suspended or missing standing PM with a Chinese reason", () => {
  const x = setup();
  const paused = {
    ...x.state,
    assignments: x.state.assignments.map((a) =>
      a.id === x.ops.id ? { ...a, status: "suspended" as const } : a,
    ),
  };
  const result = rotateStandingPm(
    paused,
    human,
    { standing_mode: "ops" },
    ports(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("已暂停");
});

test("rotating the Office keeps the Ops and its items in place", () => {
  const x = setup();
  const effect = value(
    rotateStandingPm(x.state, human, { standing_mode: "office" }, ports()),
  );
  const after = apply(x.state, effect);
  expect(effect.data.assignment).toMatchObject({
    standing_mode: "office",
    role_version: 3,
  });
  expect(after.assignments.find((a) => a.id === x.ops.id)).toEqual(x.ops);
  expect(effect.data.decisions).toEqual([]);
});

test("rotate refuses, without any write, a new version that cannot serve the inherited items", () => {
  const x = setup(legacyTools);
  const result = rotateStandingPm(
    x.state,
    human,
    { standing_mode: "ops" },
    ports(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("validation_failed");
    expect(result.error.message).toContain("resolve_delegated_decision");
    expect(result.error.message).toContain("triage_human_action");
    expect(result.error.message).toContain("没有做任何改动");
  }
  // With no PM items pending, the same version can take over.
  const empty = { ...x.state, decisions: [], human_actions: [] };
  const effect = value(
    rotateStandingPm(empty, human, { standing_mode: "ops" }, ports()),
  );
  expect(effect.data.unchanged).toBe(false);
});

test("a review-limit item needs update_work_item, not resolve_delegated_decision", () => {
  const x = setup(STANDING_ROLE_TOOLS.filter((t) => t !== "update_work_item"));
  const state = {
    ...x.state,
    decisions: [{ ...x.decision, trigger: "review_limit" as const }],
    human_actions: [],
  };
  const result = rotateStandingPm(
    state,
    human,
    { standing_mode: "ops" },
    ports(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("update_work_item");
});

test("external Office rotates at the same version, validates employee, and preserves Ops", () => {
  const x = setup();
  const employee = {
    id: id("employee", 1),
    name: "Office Agent",
    avatar: null,
    launch_profile_ref: null,
    title: "PM",
    bio: "",
    role_id: "pm",
    status: "active" as const,
    created_at: now,
    updated_at: now,
  };
  const state = {
    ...x.state,
    roles: x.state.roles.filter((r) => r.role_version !== 3),
    employees: [employee],
  };
  const effect = value(
    rotateStandingPm(
      state,
      human,
      { standing_mode: "office", external: true, employee_id: employee.name },
      ports(),
    ),
  );
  expect(effect.data.assignment).toMatchObject({
    external: true,
    employee_id: employee.id,
    role_version: 2,
  });
  const after = apply(state, effect);
  expect(hasActivePmOps(draft(after))).toBe(true);
  expect(after.decisions).toEqual(state.decisions);
  expect(after.human_actions).toEqual(state.human_actions);
  expect(after.assignments.find((a) => a.id === x.ops.id)).toEqual(x.ops);
  const repeated = value(
    rotateStandingPm(
      after,
      human,
      { standing_mode: "office", external: true, employee_id: employee.id },
      ports(),
    ),
  );
  expect(repeated.data.unchanged).toBe(true);
  expect(repeated.changes).toEqual([]);
  expect(
    value(rotateStandingPm(after, human, { standing_mode: "office" }, ports()))
      .data.unchanged,
  ).toBe(true);
  const named = value(
    rotateStandingPm(
      state,
      human,
      { standing_mode: "office", employee_id: employee.id },
      ports(),
    ),
  );
  expect(named.data.assignment.employee_id).toBe(employee.id);
  expect(named.data.assignment.external).toBeUndefined();
  const upgraded = value(
    rotateStandingPm(
      { ...apply(state, named), roles: x.state.roles },
      human,
      { standing_mode: "office" },
      ports(),
    ),
  );
  expect(upgraded.data.assignment.employee_id).toBe(employee.id);
  expect(upgraded.data.assignment.external).toBeUndefined();
  for (const invalid of [
    { ...employee, status: "inactive" as const },
    { ...employee, role_id: "coder" },
    { ...employee, projects: ["other"] },
  ]) {
    expect(
      rotateStandingPm(
        { ...state, employees: [invalid] },
        human,
        { standing_mode: "office", external: true, employee_id: employee.id },
        ports(),
      ).ok,
    ).toBe(false);
  }
  expect(
    rotateStandingPm(
      state,
      human,
      { standing_mode: "ops", external: true },
      ports(),
    ).ok,
  ).toBe(false);
  expect(
    rotateStandingPm(
      { ...state, runs: [...state.runs, { ...run(21, 11), role_version: 2 }] },
      human,
      { standing_mode: "office", external: true },
      ports(),
    ),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("未结束的 Run") },
  });
});

function deployedPmRoles(state: CommandState) {
  return state.roles
    .filter((r) => r.role_id === "pm")
    .map((r) => ({
      ...r,
      version: r.role_version,
      display_name: "PM",
      kind: "standing" as const,
      core_prompt: "",
      instructions: `Rules v${r.role_version}`,
      harness: "codex" as const,
      launch_profile_ref: "fixture",
      worktree: "readonly" as const,
      abilities: [],
      required_machine_tags: [],
    }));
}

test("deployment rotation retains the Ops employee and cannot widen pinned permissions", () => {
  const x = setup();
  const roles = deployedPmRoles(x.state);
  const system = { kind: "system" as const, project_id: x.state.project_id };
  expect(rotatePmAfterDeployment(x.state, system, roles, ports()).ok).toBe(
    false,
  );
  const safeRoles = roles.map((r) => ({
    ...r,
    allowed_tools: [...STANDING_ROLE_TOOLS],
  }));
  const state = {
    ...x.state,
    runs: [],
    roles: safeRoles,
    employees: [
      {
        id: "E-1" as EmployeeId,
        name: "PM employee",
        title: "PM",
        bio: "",
        avatar: null,
        role_id: "pm",
        launch_profile_ref: null,
        status: "active" as const,
        created_at: now,
        updated_at: now,
      },
    ],
    assignments: x.state.assignments.map((a) =>
      a.id === x.ops.id ? { ...a, employee_id: "E-1" as EmployeeId } : a,
    ),
  };
  expect(
    rotatePmAfterDeployment(
      {
        ...state,
        employees: state.employees.map((e) => ({
          ...e,
          status: "inactive" as const,
        })),
      },
      system,
      safeRoles,
      ports(),
    ).ok,
  ).toBe(false);
  const effect = value(
    rotatePmAfterDeployment(state, system, safeRoles, ports()),
  );
  expect(effect.data.assignment).toMatchObject({
    standing_mode: "ops",
    employee_id: "E-1",
    role_version: 3,
  });
  expect(
    effect.events.find((e) => e.type === "standing_pm_rotated")?.actor,
  ).toEqual(system);
  expect(rotatePmAfterDeployment(state, human, safeRoles, ports()).ok).toBe(
    false,
  );
  expect(
    rotatePmAfterDeployment(
      state,
      { ...system, project_id: "other" },
      safeRoles,
      ports(),
    ).ok,
  ).toBe(false);
  const asg = {
    ...human,
    kind: "assignment" as const,
    assignment_id: x.ops.id,
    role_id: "pm",
    role_version: 2,
    allowed_tools: [...STANDING_ROLE_TOOLS],
    capabilities: ["verify"],
  };
  expect(rotatePmAfterDeployment(state, asg, safeRoles, ports()).ok).toBe(
    false,
  );
});

test("deployment of anonymous Ops defers for an external-only roster, then selects the internal PM without touching Office", () => {
  const x = setup();
  const roles = deployedPmRoles(x.state);
  const external = {
    id: id("employee", 1),
    name: "Office",
    title: "PM",
    bio: "",
    avatar: null,
    role_id: "pm",
    launch_profile_ref: null,
    status: "active" as const,
    created_at: now,
    updated_at: now,
    projects: [x.state.project_id],
  };
  const office = { ...x.office, external: true, employee_id: external.id };
  const state = {
    ...x.state,
    runs: [],
    employees: [external],
    assignments: [x.ops, office],
  };
  const deploy = (state: CommandState) =>
    rotatePmAfterDeployment(
      state,
      { kind: "system", project_id: state.project_id },
      roles,
      ports(),
    );
  expect(deploy(state)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("外接员工") },
  });
  expect(
    rotateStandingPm(
      state,
      human,
      { standing_mode: "ops", employee_id: external.name },
      ports(),
    ),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("外接员工") },
  });
  const internal = { ...external, id: id("employee", 2), name: "Internal" };
  const staffed = { ...state, employees: [external, internal] };
  const effect = value(deploy(staffed));
  expect(effect.data.assignment.employee_id).toBe(internal.id);
  expect(
    apply(staffed, effect).assignments.find((a) => a.id === office.id),
  ).toEqual(office);
  const offsite = value(
    rotateStandingPm(
      state,
      human,
      { standing_mode: "office", external: true, employee_id: external.id },
      ports(),
    ),
  );
  expect(offsite.data.assignment).toMatchObject({
    employee_id: external.id,
    external: true,
    role_version: 3,
  });
});
