import { describe, expect, test } from "vitest";
import type { Employee } from "../employee.js";
import { type Actor, type ToolName, toolNames } from "../entities.js";
import {
  canManageRoles,
  type Role,
  type RoleKind,
  roleReference,
  STANDING_ROLE_TOOLS,
} from "../role.js";
import { AGENT_PROTOCOL, SHARED_BOUNDARIES } from "../role-prompt.js";
import { assign } from "./pm.js";
import {
  activateRole,
  copyRole,
  createRole,
  deactivateRole,
  previewRoleUpgrade,
  type RoleCommandState,
  type RoleDefinition,
  rollbackRole,
  updateRole,
  validateRole,
} from "./role.js";
import { finishRun } from "./runtime.js";
import { actor, fixture, human, id, ports, value } from "./test-fixtures.js";

function definition(patch: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    role_id: "coder",
    display_name: "Coder",
    kind: "produce",
    instructions: "Implement the task.",
    harness: "codex",
    launch_profile_ref: "codex-agent",
    allowed_tools: ["submit_delivery"],
    capabilities: ["produce"],
    abilities: [],
    worktree: "write",
    required_machine_tags: [],
    ...patch,
  };
}
const empty: RoleCommandState = { project_id: human.project_id, roles: [] };
const first = (): Role =>
  value(createRole(empty, human, definition(), ports())).data;

test.each<RoleKind>(["produce", "verify", "standing"])(
  "attachment read permission preserves human-only role management for %s",
  (kind) => {
    const role = definition({
      kind,
      worktree: "none",
      allowed_tools: ["read_attachment"],
    });
    expect(
      value(createRole(empty, human, role, ports())).data.allowed_tools,
    ).toEqual(["read_attachment"]);
    expect(createRole(empty, actor(), role, ports())).toMatchObject({
      ok: false,
      error: { code: "forbidden_tool" },
    });
    expect(empty.roles).toEqual([]);
  },
);

test.each([
  "## 协作规则",
  "## 协议（每个 Run 都要遵守）",
  ...SHARED_BOUNDARIES,
  ...AGENT_PROTOCOL,
])(
  "rejects system prompt content through every role write: %s",
  (systemText) => {
    const instructions = `Custom role.\n\n${systemText}\n`;
    const original = first();
    const invalid = { ...original, instructions };
    const state = { ...empty, roles: [original] };
    const commands = [
      createRole(empty, human, definition({ instructions }), ports()),
      updateRole(state, human, "coder", { instructions }, ports()),
      copyRole(empty, human, { source: invalid, role_id: "copy" }, ports()),
      rollbackRole({ ...empty, roles: [invalid] }, human, "coder", 1, ports()),
      deactivateRole({ ...empty, roles: [invalid] }, human, "coder", ports()),
      activateRole(
        { ...empty, roles: [{ ...invalid, status: "inactive" as const }] },
        human,
        "coder",
        ports(),
      ),
    ];
    for (const result of commands) {
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "validation_failed",
          message: expect.stringContaining("instructions 不得包含"),
        },
      });
    }
    expect(state.roles).toEqual([original]);
    // The same text is legal in an old, complete core_prompt, with no instructions.
    const { instructions: _instructions, ...legacy } = definition();
    expect(
      value(
        createRole(
          empty,
          human,
          { ...legacy, core_prompt: instructions },
          ports(),
        ),
      ).data.core_prompt,
    ).toBe(instructions);
  },
);

describe("human-only role management", () => {
  test.each<Actor>([
    actor(),
    actor(4, "pm"),
    { kind: "system", project_id: human.project_id },
    { kind: "human", project_id: "another-project" },
  ])("rejects $kind without effects", (caller) => {
    const state = { ...empty, roles: [first()] };
    const commands = [
      () => createRole(empty, caller, definition(), ports()),
      () =>
        copyRole(
          empty,
          caller,
          { source: definition(), role_id: "copy" },
          ports(),
        ),
      () =>
        updateRole(
          state,
          caller,
          "coder",
          { display_name: "Changed" },
          ports(),
        ),
      () => deactivateRole(state, caller, "coder", ports()),
      () => activateRole(state, caller, "coder", ports()),
      () => rollbackRole(state, caller, "coder", 1, ports()),
    ];
    expect(canManageRoles(caller, empty.project_id)).toBe(false);
    for (const command of commands)
      expect(command()).toMatchObject({
        ok: false,
        error: { code: "forbidden_tool" },
      });
    expect(state.roles).toEqual([first()]);
  });
});

describe("tool and worktree boundaries", () => {
  test("all role saves derive withdrawal without mutating historical versions", () => {
    const source = definition({
      role_id: "reviewer",
      kind: "verify",
      worktree: "readonly",
      allowed_tools: ["submit_review"],
    });
    const previous: Role = { ...source, core_prompt: "", version: 1 };
    const state = { ...empty, roles: [previous] };
    for (const result of [
      createRole(empty, human, source, ports()),
      updateRole(
        state,
        human,
        "reviewer",
        { display_name: "Reviewer" },
        ports(),
      ),
      copyRole(empty, human, { source, role_id: "copied" }, ports()),
      rollbackRole(state, human, "reviewer", 1, ports()),
    ]) {
      const saved = value(result).data;
      expect(saved.allowed_tools).toEqual(["submit_review", "withdraw_review"]);
      expect(value(validateRole(saved)).allowed_tools).toEqual(
        saved.allowed_tools,
      );
    }
    expect(previous.allowed_tools).toEqual(["submit_review"]);
    expect(source.allowed_tools).toEqual(["submit_review"]);
    expect(
      value(previewRoleUpgrade(state, human, "reviewer", source)),
    ).toMatchObject({
      unchanged: false,
      diff: { added_tools: ["withdraw_review"] },
      patch: { allowed_tools: ["submit_review", "withdraw_review"] },
    });
    expect(
      validateRole({
        ...source,
        role_id: "host_ops",
        kind: "standing",
        allowed_tools: ["withdraw_review"],
      }).ok,
    ).toBe(false);
  });
  test("verifiers may collaborate, upload evidence and request decisions", () => {
    const tools = [
      "submit_review",
      "upload_attachment",
      "post_comment",
      "request_decision",
    ] as const;
    const created = value(
      createRole(
        empty,
        human,
        definition({
          role_id: "reviewer",
          kind: "verify",
          worktree: "readonly",
          allowed_tools: tools,
        }),
        ports(),
      ),
    );
    expect(created.data.allowed_tools).toEqual([...tools, "withdraw_review"]);
  });
  test.each<RoleKind>(["produce", "verify", "standing"])(
    "checks every system tool for %s",
    (kind) => {
      for (const tool of toolNames) {
        const expected = tool.startsWith("host_ops_")
          ? false
          : kind === "produce"
            ? !["submit_review", "withdraw_review"].includes(tool)
            : kind === "verify"
              ? tool !== "submit_delivery"
              : (STANDING_ROLE_TOOLS as readonly string[]).includes(tool);
        expect(
          validateRole(
            definition({
              role_id: "pm",
              kind,
              worktree: "none",
              allowed_tools: [tool],
            }),
          ).ok,
          tool,
        ).toBe(expected);
      }
    },
  );
  test.each<RoleKind>(["produce", "verify", "standing"])(
    "rejects unknown tools and non-pm record_decision for %s",
    (kind) => {
      for (const tool of [
        "git_push",
        "git_credentials",
        "launch_rocket",
        "record_decision",
      ]) {
        expect(
          validateRole(
            definition({
              kind,
              worktree: "none",
              allowed_tools: [tool as ToolName],
            }),
          ).ok,
          tool,
        ).toBe(false);
      }
    },
  );
  test.each(["none", "readonly", "write"] as const)(
    "verifier worktree %s",
    (worktree) => {
      expect(
        validateRole(
          definition({
            kind: "verify",
            worktree,
            allowed_tools: ["submit_review"],
          }),
        ).ok,
      ).toBe(worktree !== "write");
    },
  );
  test("legacy work does not bypass verifier restrictions", () => {
    expect(
      validateRole(
        definition({
          kind: "work",
          allowed_tools: ["submit_delivery", "submit_review"],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateRole(
        definition({
          kind: "work",
          allowed_tools: [],
          capabilities: ["verify"],
        }),
      ).ok,
    ).toBe(false);
  });
  test("copy and rollback revalidate old permissions", () => {
    const invalid = { ...first(), allowed_tools: ["git_push" as ToolName] };
    expect(
      copyRole(empty, human, { source: invalid, role_id: "clone" }, ports()).ok,
    ).toBe(false);
    expect(
      rollbackRole({ ...empty, roles: [invalid] }, human, "coder", 1, ports())
        .ok,
    ).toBe(false);
    expect(
      copyRole(
        empty,
        human,
        {
          source: definition({
            role_id: "pm",
            allowed_tools: ["record_decision"],
          }),
          role_id: "not-pm",
        },
        ports(),
      ).ok,
    ).toBe(false);
  });
  test("rejects malformed input and managed field patches", () => {
    for (const patch of [
      { kind: "root" },
      { role_id: "../role" },
      { allowed_tools: [null] },
      { worktree: "root" },
      { instructions: null },
      { harness: "other" },
    ]) {
      expect(
        validateRole({ ...definition(), ...patch } as RoleDefinition).ok,
      ).toBe(false);
    }
    const state = { ...empty, roles: [first()] };
    for (const patch of [
      { version: 1 },
      { status: "inactive" },
      { role_id: "other" },
      {},
    ]) {
      expect(
        updateRole(state, human, "coder", patch as never, ports()).ok,
      ).toBe(false);
    }
  });
});

test("create, update, copy, deactivate, activate and rollback append immutable project versions", () => {
  const original = first();
  const state = { ...empty, roles: [original] };
  const changed = value(
    updateRole(
      state,
      human,
      "coder",
      { instructions: "Second", display_name: "New" },
      ports(),
    ),
  );
  expect(changed.data).toMatchObject({ version: 2, instructions: "Second" });
  state.roles.push(changed.data);
  const stopped = value(deactivateRole(state, human, "coder", ports()));
  state.roles.push(stopped.data);
  expect(stopped.data).toMatchObject({ version: 3, status: "inactive" });
  expect(value(deactivateRole(state, human, "coder", ports()))).toMatchObject({
    roles: [],
    events: [],
  });
  const reverted = value(rollbackRole(state, human, "coder", 1, ports()));
  state.roles.push(reverted.data);
  expect(reverted.data).toMatchObject({
    version: 4,
    status: "inactive",
    instructions: original.instructions,
    display_name: original.display_name,
  });
  const active = value(activateRole(state, human, "coder", ports()));
  state.roles.push(active.data);
  expect(active.data).toMatchObject({ version: 5, status: "active" });
  expect(value(activateRole(state, human, "coder", ports()))).toMatchObject({
    roles: [],
    events: [],
  });
  const copied = value(
    copyRole(
      empty,
      human,
      { source: active.data, role_id: "copy", display_name: "Copy" },
      ports(),
    ),
  );
  expect(copied.data).toMatchObject({
    role_id: "copy",
    version: 1,
    status: "active",
    instructions: original.instructions,
  });
  expect(copied.events[0]).toMatchObject({
    type: "role_copied",
    actor: human,
    payload: { role: copied.data },
  });
  expect(original).toEqual(first());
  expect(createRole(state, human, definition(), ports()).ok).toBe(false);
  expect(rollbackRole(state, human, "coder", 99, ports()).ok).toBe(false);
  expect(
    updateRole(empty, human, "coder", { display_name: "Missing" }, ports()).ok,
  ).toBe(false);
});

test("latest inactive version blocks new assignments even when requesting an old active version", () => {
  const role = first();
  const inactive = value(
    deactivateRole({ ...empty, roles: [role] }, human, "coder", ports()),
  ).data;
  const before = fixture();
  const roles = [
    ...before.roles.filter((r) => r.role_id !== "coder"),
    roleReference(role),
    roleReference(inactive),
  ];
  const state = {
    ...before,
    employees: [
      {
        id: id("employee", 1),
        name: "Alice",
        title: "Coder",
        bio: "",
        avatar: null,
        role_id: "coder",
        launch_profile_ref: null,
        status: "active",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      } satisfies Employee,
    ],
    roles,
    assignments: [],
    runs: [],
    work_items: before.work_items.map(
      ({ assignment_id: _old, ...item }) => item,
    ),
  };
  for (const employee_id of [undefined, "E-1", "Alice"]) {
    for (const role_version of [undefined, 1, 2]) {
      expect(
        assign(
          state,
          human,
          {
            work_item_id: id("work_item", 1),
            role_id: "coder",
            ...(employee_id === undefined ? {} : { employee_id }),
            ...(role_version === undefined ? {} : { role_version }),
          },
          ports(),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "validation_failed", message: "停用的角色不能被新指派" },
      });
    }
  }
  // Existing assignments still authenticate against their own version and can finish their run.
  const existing = {
    ...before,
    roles: [
      ...roles.filter((r) => r.role_version !== 1 || r.role_id !== "coder"),
      { ...roleReference(role), allowed_tools: toolNames },
    ],
  };
  expect(
    value(
      assign(
        existing,
        human,
        { work_item_id: id("work_item", 1), role_id: "coder" },
        ports(),
      ),
    ).data.id,
  ).toBe(id("assignment", 1));
  expect(
    finishRun(
      existing,
      actor(),
      {
        run_id: id("run", 1),
        outcome: "completed",
        summary: "Existing responsibility",
      },
      ports(),
    ).ok,
  ).toBe(true);
  const enabled = value(
    activateRole(
      { ...empty, roles: [role, inactive] },
      human,
      "coder",
      ports(),
    ),
  ).data;
  expect(
    value(
      assign(
        { ...state, roles: [...roles, roleReference(enabled)] },
        human,
        { work_item_id: id("work_item", 1), role_id: "coder" },
        ports(),
      ),
    ).data.role_version,
  ).toBe(3);
});
