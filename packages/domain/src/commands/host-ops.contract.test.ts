import { expect, test } from "vitest";
import type { Actor, Assignment, ToolName } from "../entities.js";
import { HOST_OPS_ROLE_TOOLS, HOST_OPS_TOOLS } from "../host-ops.js";
import { roleReference } from "../role.js";
import {
  type RequestDecisionParams,
  recordDecision,
  requestDecision,
  requestHumanAction,
  resolveDelegatedDecision,
} from "./coordination.js";
import { attempt, CommandDraft, type CommandState } from "./core.js";
import { createHostOpsAssignment } from "./host-ops.js";
import {
  finishHostOpsRotation,
  prepareHostOpsRotation,
} from "./host-ops-rotate.js";
import { assign } from "./pm.js";
import { setProjectPreferences } from "./preferences.js";
import {
  copyRole,
  createRole,
  type RoleDefinition,
  rollbackRole,
  updateRole,
  validateRole,
} from "./role.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const definition: RoleDefinition = {
  role_id: "host_ops",
  display_name: "Host operations",
  kind: "standing",
  instructions: "Inspect session health; report to PM.",
  harness: "codex",
  launch_profile_ref: "fixture",
  worktree: "none",
  capabilities: [],
  abilities: [],
  required_machine_tags: [],
  allowed_tools: HOST_OPS_ROLE_TOOLS,
};
const forbidden: readonly ToolName[] = [
  "record_decision",
  "resolve_delegated_decision",
  "triage_human_action",
  "submit_delivery",
  "submit_review",
  "create_card",
  "update_card",
  "create_work_item",
  "update_work_item",
  "assign",
  "issue_instruction",
];
function state(): CommandState {
  const base = fixture();
  const role = value(
    createRole(
      { project_id: base.project_id, roles: [] },
      human,
      definition,
      ports(),
    ),
  ).data;
  return { ...base, roles: [...base.roles, roleReference(role)] };
}
function standing(): {
  state: CommandState;
  actor: Extract<Actor, { kind: "assignment" }>;
  assignment: Assignment;
} {
  const base = state();
  const effect = value(createHostOpsAssignment(base, human, {}, ports()));
  const assignment = effect.data.assignment;
  return {
    state: apply(base, effect),
    assignment,
    actor: {
      kind: "assignment",
      project_id: base.project_id,
      assignment_id: assignment.id,
      role_id: "host_ops",
      role_version: 1,
      capabilities: [],
      allowed_tools: HOST_OPS_ROLE_TOOLS,
    },
  };
}

test.each(HOST_OPS_TOOLS)(
  "invariant 1: %s is reserved for standing host_ops on every role write",
  (tool) => {
    for (const role_id of ["pm", "coder", "reviewer", "custom"]) {
      const invalid = { ...definition, role_id, allowed_tools: [tool] };
      const existing = {
        ...invalid,
        version: 1,
        core_prompt: "",
        allowed_tools: [],
      };
      const s = { project_id: human.project_id, roles: [existing] };
      for (const result of [
        createRole({ ...s, roles: [] }, human, invalid, ports()),
        copyRole(
          s,
          human,
          { source: definition, role_id: `${role_id}-copy` },
          ports(),
        ),
        updateRole(s, human, role_id, { allowed_tools: [tool] }, ports()),
        rollbackRole(
          { ...s, roles: [{ ...existing, allowed_tools: [tool] }] },
          human,
          role_id,
          1,
          ports(),
        ),
      ])
        expect(result.ok).toBe(false);
    }
    expect(validateRole({ ...definition, allowed_tools: [tool] }).ok).toBe(
      true,
    );
    for (const kind of ["produce", "verify", "work"] as const)
      expect(
        validateRole({ ...definition, kind, allowed_tools: [tool] }).ok,
      ).toBe(false);
  },
);

test.each(forbidden)(
  "invariant 2: host_ops cannot acquire or invoke %s",
  (tool) => {
    expect(validateRole({ ...definition, allowed_tools: [tool] }).ok).toBe(
      false,
    );
    const s = standing();
    // Even an old or malformed role/token record cannot cross the runtime boundary.
    const widened = {
      ...s.state,
      roles: s.state.roles.map((r) =>
        r.role_id === "host_ops" ? { ...r, allowed_tools: [tool] } : r,
      ),
    };
    expect(
      attempt(
        () =>
          new CommandDraft(
            widened,
            { ...s.actor, allowed_tools: [tool] } as Actor,
            tool,
          ),
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
  },
);

test("invariant 3: host_ops cannot be assigned to produce or verify work, including reuse", () => {
  for (const caller of [human, actor(4, "pm")]) {
    const base = state();
    for (const item of base.work_items) {
      const s = {
        ...base,
        work_items: base.work_items.map((w) =>
          w.id === item.id ? { ...w, role_id: "host_ops" } : w,
        ),
      };
      const before = JSON.stringify(s);
      expect(
        assign(
          s,
          caller,
          { work_item_id: item.id, role_id: "host_ops" },
          ports(),
        ).ok,
      ).toBe(false);
      expect(JSON.stringify(s)).toBe(before);
    }
  }
});

const decision: RequestDecisionParams = {
  kind: "choose",
  category: "general",
  question: "Choose recovery",
  context: "Needs a decision",
  options: [{ key: "wait", description: "Wait", impact: "No operation" }],
  recommended: "wait",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human",
  plain_summary: TEST_PLAIN_SUMMARY,
};
test("invariant 6: host_ops requests retain assignment authorship and only target human or PM", () => {
  const s = standing();
  for (const decider of ["human", "role:pm"] as const) {
    const effect = value(
      requestDecision(s.state, s.actor, { ...decision, decider }, ports()),
    );
    expect(["human", "role:pm"]).toContain(effect.data.decider);
    expect(effect.data.raised_by).toBe(`assignment:${s.assignment.id}`);
    expect(effect.events[0]?.actor).toEqual(s.actor);
  }
  for (const decider of [
    "role:coder",
    "role:reviewer",
    "role:host_ops",
  ] as const) {
    expect(
      requestDecision(s.state, s.actor, { ...decision, decider }, ports()).ok,
    ).toBe(false);
  }
  expect(
    requestDecision(
      s.state,
      human,
      { ...decision, decider: "role:host_ops" },
      ports(),
    ).ok,
  ).toBe(false);
  const effect = value(
    requestHumanAction(
      s.state,
      s.actor,
      {
        card_id: id("card", 1),
        instructions: "Inspect host configuration",
        why_human: "Host access required",
        expected_return: "Result",
        blocked_work_items: [],
      },
      ports(),
    ),
  );
  expect(effect.data.requested_by).toBe(`assignment:${s.assignment.id}`);
});

test.each(["credential"] as const)(
  "B1: %s defaults to human until authorized",
  (category) => {
    const s = standing();
    expect(
      requestDecision(
        s.state,
        s.actor,
        { ...decision, category, decider: "role:pm" },
        ports(),
      ).ok,
    ).toBe(true);
    expect(
      value(
        requestDecision(s.state, s.actor, { ...decision, category }, ports()),
      ).data.decider,
    ).toBe("human");
  },
);

test.each(["spending", "account", "data_deletion"] as const)(
  "invariant 6: host_ops may request %s but only authorized active PM Ops may decide",
  (category) => {
    const s = standing();
    const io = ports();
    let current: CommandState = {
      ...s.state,
      assignments: s.state.assignments.map((a) =>
        a.scope === "standing" && a.id === id("assignment", 4)
          ? { ...a, standing_mode: "ops" as const }
          : a,
      ),
    };
    const ask = () =>
      value(
        requestDecision(
          current,
          s.actor,
          {
            ...decision,
            category,
            decider: "role:pm",
          },
          io,
        ),
      );
    const humanRequest = () => {
      const effect = ask();
      current = apply(current, effect);
      expect(effect.data).toMatchObject({
        decider: "human",
        raised_by: `assignment:${s.assignment.id}`,
      });
      expect(effect.data.delegation_authority).toBeUndefined();
      return effect.data;
    };
    humanRequest();
    current = apply(
      current,
      value(
        setProjectPreferences(
          current,
          human,
          {
            decision_delegation: { [category]: false },
          },
          io,
        ),
      ),
    );
    humanRequest();
    for (const enabled of [true, false])
      expect(
        setProjectPreferences(
          current,
          s.actor,
          {
            decision_delegation: { [category]: enabled },
          },
          io,
        ).ok,
      ).toBe(false);
    current = apply(
      current,
      value(
        setProjectPreferences(
          current,
          human,
          {
            decision_delegation: { [category]: true },
          },
          io,
        ),
      ),
    );
    const grant = current.events.findLast(
      (e) => e.type === "project_preferences_updated",
    );
    const delegated = ask();
    current = apply(current, delegated);
    expect(delegated.data).toMatchObject({
      decider: "role:pm",
      raised_by: `assignment:${s.assignment.id}`,
      delegation_authority: `project:${current.project_id}/decision_delegation/${category}/event:${grant?.id}`,
    });
    expect(grant?.actor).toEqual(human);
    expect(delegated.events[0]?.actor).toEqual(s.actor);
    const before = JSON.stringify(current);
    const answer = {
      decision_id: delegated.data.id,
      option: "wait",
      rationale: "No execution granted",
    };
    expect(
      resolveDelegatedDecision(current, actor(4, "pm"), answer, io).ok,
    ).toBe(true);
    expect(resolveDelegatedDecision(current, s.actor, answer, io).ok).toBe(
      false,
    );
    expect(
      recordDecision(current, s.actor, { ...answer, raw_quote: "approve" }, io)
        .ok,
    ).toBe(false);
    // A caller-supplied tool list cannot enlarge the host role boundary.
    expect(
      resolveDelegatedDecision(
        current,
        {
          ...s.actor,
          allowed_tools: [...HOST_OPS_ROLE_TOOLS, "resolve_delegated_decision"],
        },
        answer,
        io,
      ).ok,
    ).toBe(false);
    expect(
      requestDecision(
        current,
        s.actor,
        { ...decision, category, decider: "role:host_ops" },
        io,
      ).ok,
    ).toBe(false);
    expect(JSON.stringify(current)).toBe(before);
    expect(current.assignments.find((a) => a.id === s.assignment.id)).toEqual(
      s.assignment,
    );
    expect(
      current.roles.find((r) => r.role_id === "host_ops")?.allowed_tools,
    ).toEqual(HOST_OPS_ROLE_TOOLS);
    const unavailable = {
      ...current,
      assignments: current.assignments.map((a) =>
        a.id === id("assignment", 4)
          ? { ...a, status: "suspended" as const }
          : a,
      ),
    };
    expect(
      value(
        requestDecision(
          unavailable,
          s.actor,
          { ...decision, category, decider: "role:pm" },
          io,
        ),
      ).data.decider,
    ).toBe("human");
    current = apply(
      current,
      value(
        setProjectPreferences(
          current,
          human,
          {
            decision_delegation: { [category]: false },
          },
          io,
        ),
      ),
    );
    expect(
      current.decisions.find((q) => q.id === delegated.data.id)?.decider,
    ).toBe("human");
    expect(
      resolveDelegatedDecision(current, actor(4, "pm"), answer, io).ok,
    ).toBe(false);
    humanRequest();
  },
);

test("host_ops bootstrap is human-only and keeps a single standing identity without PM mode", () => {
  const base = state();
  for (const caller of [
    actor(),
    actor(4, "pm"),
    { kind: "system", project_id: base.project_id },
    { kind: "human", project_id: "other" },
  ] as const)
    expect(createHostOpsAssignment(base, caller, {}, ports()).ok).toBe(false);
  const s = standing();
  expect(s.assignment).toMatchObject({
    scope: "standing",
    role_id: "host_ops",
    status: "active",
    runtime_ref: null,
  });
  expect(s.assignment.standing_mode).toBeUndefined();
  expect(s.assignment.work_item_id).toBeUndefined();
  const again = value(createHostOpsAssignment(s.state, human, {}, ports()));
  expect(again.data).toEqual({ assignment: s.assignment, reused: true });
  expect(again.changes).toEqual([]);
  expect(again.events).toEqual([]);
  for (const status of ["suspended", "released"] as const) {
    const changed = {
      ...s.state,
      assignments: s.state.assignments.map((a) =>
        a.id === s.assignment.id ? { ...a, status } : a,
      ),
    };
    expect(requestDecision(changed, s.actor, decision, ports()).ok).toBe(false);
  }
  expect(
    requestDecision(
      s.state,
      { ...s.actor, project_id: "other" },
      decision,
      ports(),
    ).ok,
  ).toBe(false);
});

test("bootstrap pins the role and employee; disabled or ambiguous new identities fail atomically", () => {
  const employee = {
    id: id("employee", 1),
    name: "Operator",
    title: "Operations",
    bio: "",
    avatar: null,
    role_id: "host_ops",
    launch_profile_ref: null,
    status: "active" as const,
    created_at: now,
    updated_at: now,
  };
  const scoped = {
    ...state(),
    employees: [{ ...employee, projects: ["other"] }],
  };
  for (const [params, reason] of [
    [{}, "本项目没有可用员工"],
    [{ employee_id: employee.id }, "不属于本项目"],
  ] as const) {
    expect(
      createHostOpsAssignment(scoped, human, params, ports()),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(reason) },
    });
  }
  const base = { ...state(), employees: [employee] };
  const effect = value(createHostOpsAssignment(base, human, {}, ports()));
  expect(effect.data.assignment.employee_id).toBe(employee.id);
  const next = apply(base, effect);
  const newer = {
    ...next,
    roles: [
      ...next.roles,
      {
        ...roleReference({ ...definition, core_prompt: "", version: 2 }),
        allowed_tools: [],
      },
    ],
  };
  expect(
    value(createHostOpsAssignment(newer, human, {}, ports())).data.assignment
      .role_version,
  ).toBe(1);
  for (const employees of [
    [{ ...employee, status: "inactive" as const }],
    [{ ...employee, role_id: "pm" }],
  ])
    expect(
      createHostOpsAssignment(
        { ...base, employees },
        human,
        { employee_id: employee.id },
        ports(),
      ).ok,
    ).toBe(false);
  const second = { ...employee, id: id("employee", 2), name: "Second" };
  expect(
    createHostOpsAssignment(
      { ...base, employees: [employee, second] },
      human,
      {},
      ports(),
    ).ok,
  ).toBe(false);
  expect(
    createHostOpsAssignment(
      { ...next, employees: [employee, second] },
      human,
      { employee_id: second.id },
      ports(),
    ).ok,
  ).toBe(false);
  for (const roles of [
    [],
    base.roles.map((r) => ({ ...r, status: "inactive" as const })),
  ])
    expect(
      createHostOpsAssignment({ ...base, roles }, human, {}, ports()).ok,
    ).toBe(false);
});

test("rotation changes identity and cursors atomically after a read-only human preflight", () => {
  const s = standing();
  const allocator = ports();
  allocator.ids.next(s.state.project_id, "assignment");
  const role = s.state.roles.find((r) => r.role_id === "host_ops");
  if (!role) throw new Error("Missing host_ops role");
  let state: CommandState = {
    ...s.state,
    roles: [...s.state.roles, { ...role, role_version: 2 }],
    cursors: [
      { assignment_id: s.assignment.id, card_id: id("card", 1), acked_seq: 7 },
    ],
  };
  for (const caller of [
    s.actor,
    { kind: "system", project_id: state.project_id },
  ] as const)
    expect(prepareHostOpsRotation(state, caller).ok).toBe(false);
  const ready = value(prepareHostOpsRotation(state, human));
  expect(ready.changes).toEqual([]);
  expect(ready.events).toEqual([]);
  expect(ready.data.unchanged).toBe(false);
  const params = { previous_assignment_id: s.assignment.id, to_version: 2 };
  expect(finishHostOpsRotation(state, s.actor, params, allocator).ok).toBe(
    false,
  );
  const finished = value(
    finishHostOpsRotation(state, human, params, allocator),
  );
  state = apply(state, finished);
  expect(
    state.assignments.filter(
      (a) => a.role_id === "host_ops" && a.status === "active",
    ),
  ).toEqual([finished.data.assignment]);
  expect(finished.data.assignment.role_version).toBe(2);
  expect(state.cursors).toContainEqual({
    assignment_id: finished.data.assignment.id,
    card_id: id("card", 1),
    acked_seq: 7,
  });
  expect(finishHostOpsRotation(state, human, params, allocator).ok).toBe(false);
  expect(value(prepareHostOpsRotation(state, human)).data.unchanged).toBe(true);
});

test("manual rotation rechecks the chosen operator's project after preflight", () => {
  const s = standing();
  const { project_id } = s.state;
  const operator = {
    id: id("employee", 1),
    name: "Operator",
    title: "Operations",
    role_id: "host_ops",
    bio: "",
    avatar: null,
    launch_profile_ref: null,
    status: "active" as const,
    projects: [project_id],
    created_at: now,
    updated_at: now,
  };
  const second = { ...operator, id: id("employee", 2), name: "Second" };
  const upgraded = {
    ...s.state,
    roles: [
      ...s.state.roles,
      roleReference({ ...definition, core_prompt: "", version: 2 }),
    ],
    employees: [operator, second],
  };
  const ready = value(prepareHostOpsRotation(upgraded, human, operator.name));
  expect(ready.data.employee_id).toBe(operator.id);
  expect(ready.changes).toEqual([]);
  const moved = {
    ...upgraded,
    employees: [{ ...operator, projects: ["other"] }, second],
  };
  expect(
    finishHostOpsRotation(
      moved,
      human,
      {
        previous_assignment_id: s.assignment.id,
        to_version: ready.data.to_version,
        employee_id: operator.id,
      },
      ports(),
    ),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("不属于本项目") },
  });
});
