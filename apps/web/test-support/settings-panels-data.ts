import { AVATAR_LIBRARY } from "../../../packages/domain/src/avatar-library.js";
import type {
  CardiganClient,
  ExecutionCapacity,
  RoleDefinitionView,
  RoleListView,
  TemplateVersion,
} from "../src/api.js";
import { fixtureMachines } from "../src/testing/machines-fixture.js";

// C-479: synthetic data for the capacity, roles, templates and employee
// panels — two Agent machines, one merge-check target, three roles, three
// templates and the 60-person avatar library with two occupants. No backend.
const capacity: ExecutionCapacity = {
  agents: [
    {
      machine_id: "local",
      label: "本机",
      running: 3,
      total_running: 5,
      limit: 6,
      max_limit: 16,
      queued: 2,
      merge_check_slots: 1,
    },
    {
      machine_id: "builder",
      label: "构建机",
      running: 0,
      total_running: 0,
      limit: 4,
      max_limit: 8,
      queued: 0,
      merge_check_slots: 0,
    },
  ],
  merge_checks: [
    {
      machine_id: "ci",
      executor_type: "github",
      running: 1,
      limit: 3,
      queued: 4,
    },
  ],
  merge_config_invalid: false,
};
const allowlists = {
  produce: ["whoami", "get_card", "submit_delivery", "post_comment"],
  verify: ["whoami", "get_card", "submit_review", "post_comment"],
  standing: ["whoami", "get_card", "record_decision"],
};
const coder: RoleDefinitionView = {
  role_id: "coder",
  version: 2,
  display_name: "开发工程师",
  kind: "produce",
  status: "active",
  instructions: "按卡片实现功能并附带测试。\n交付前跑 lint 与相关测试。",
  core_prompt: "",
  harness: "codex",
  launch_profile_ref: "codex-agent",
  allowed_tools: ["whoami", "get_card", "submit_delivery"],
  capabilities: ["produce"],
  abilities: ["code", "test"],
  worktree: "write",
  required_machine_tags: ["linux"],
};
const coderV1: RoleDefinitionView = {
  ...coder,
  version: 1,
  instructions: "按卡片实现功能并附带测试。",
  abilities: ["code"],
};
const roles: RoleListView = {
  project_id: "p-1",
  roles: [
    { ...coder },
    {
      role_id: "reviewer",
      display_name: "代码审核",
      kind: "verify",
      status: "active",
      version: 3,
      harness: "claude-code",
      launch_profile_ref: "claude-agent",
    },
    {
      role_id: "writer",
      display_name: "文档写手",
      kind: "produce",
      status: "inactive",
      version: 1,
      harness: "pi",
      launch_profile_ref: "pi-agent",
    },
  ],
  default_roles: ["pm", "coder", "reviewer"],
  harnesses: ["claude-code", "codex", "pi"],
  allowlists,
};
const at = "2026-01-01T00:00:00.000Z";
const dev: TemplateVersion = {
  id: "dev",
  title: "开发卡",
  description: "实现、代码审核与合并。",
  requires_repo: true,
  merge: "confirm",
  require_acceptance_criteria: true,
  work_items: [
    {
      key: "development",
      title: "开发",
      kind: "produce",
      role_id: "coder",
      required: true,
    },
    {
      key: "code_review",
      title: "代码审核",
      kind: "verify",
      role_id: "reviewer",
      required: true,
      target_work_item_key: "development",
    },
  ],
  primary_work_item_key: "development",
  completion: { mode: "review", reviewer: "human" },
  version: 2,
  builtin: true,
  status: "active",
  summary: "内置",
  created_at: at,
};
const templates: TemplateVersion[] = [
  dev,
  {
    ...dev,
    id: "doc",
    title: "文档卡",
    description: "文档修改。",
    requires_repo: false,
    merge: "none",
    work_items: [dev.work_items[0] as TemplateVersion["work_items"][number]],
    completion: { mode: "human_mark_done" },
    version: 1,
    builtin: false,
    summary: "新建",
  },
  {
    ...dev,
    id: "spike",
    title: "调研卡",
    description: "",
    merge: "none",
    requires_repo: false,
    work_items: [],
    primary_work_item_key: null,
    completion: { mode: "human_mark_done" },
    version: 3,
    builtin: false,
    status: "inactive",
    summary: "停用",
  },
];

let macMiniRead = false;
export const settingsPanels: Partial<CardiganClient> = {
  executionCapacity: async () => capacity,
  // C-512: three synthetic machines (see machines-fixture.ts).
  machines: async () => ({ machines: fixtureMachines }),
  machine: async (_p, id) => {
    // Evidence scene: Mac mini's first detail read fails, then retries.
    if (id === "mac-mini" && !macMiniRead) {
      macMiniRead = true;
      throw new Error("合成失败：机器详情未读取");
    }
    const machine = fixtureMachines.find((m) => m.id === id);
    if (!machine) throw new Error(`合成数据中没有机器 ${id}`);
    return { machine };
  },
  roles: async () => roles,
  role: async (_p, roleId) => {
    const role = roleId === "coder" ? coder : { ...coder, role_id: roleId };
    return {
      project_id: "p-1",
      role,
      previous: roleId === "coder" ? coderV1 : null,
      allowlist: allowlists.produce,
      allowlists,
      harnesses: roles.harnesses,
      legacy_conversion: null,
    };
  },
  roleHistory: async (project_id, role_id) => ({
    project_id,
    role_id,
    versions: [
      {
        version: 2,
        role: coder,
        action: "编辑",
        summary: "编辑：改动 instructions、abilities",
        changes: ["instructions", "abilities"],
        created_at: at,
        actor: "human",
        author_display: "所有者",
      },
      {
        version: 1,
        role: coderV1,
        action: "创建",
        summary: "创建",
        changes: [],
        created_at: at,
        actor: "human",
        author_display: "所有者",
      },
    ],
  }),
  templates: async () => ({ templates }),
  template: async (_p, id) => ({
    template: templates.find((t) => t.id === id) ?? dev,
    previous: id === "dev" ? { ...dev, version: 1, merge: "none" } : null,
  }),
  templateHistory: async (_p, id) => ({
    versions: [templates.find((t) => t.id === id) ?? dev],
  }),
  employeeOptions: async () => ({
    library: AVATAR_LIBRARY.map(([id, name, source]) => ({
      id,
      name,
      source,
      avatar: `/avatars/v1/${id}/head-128.webp`,
      occupied_by:
        id === "zhu-bajie"
          ? { id: "E-1", name: "八戒", status: "active" as const }
          : id === "sha-seng"
            ? { id: "E-2", name: "悟净", status: "inactive" as const }
            : null,
    })),
    roles: [
      { role_id: "coder", display_name: "开发工程师" },
      { role_id: "reviewer", display_name: "代码审核" },
    ],
  }),
};
