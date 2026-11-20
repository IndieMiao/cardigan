import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  CardiganClient,
  EmployeeOptions,
  RoleDocumentPreview,
  RoleListView,
  TemplateVersion,
} from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-494 evidence: the C-479 settings panels data plus three synthetic launch
// profiles, two project employees (one with a run in progress) and canned
// role-document previews. No backend, launch.yaml or live data.
Date.now = () => new Date(NOW).getTime();
const base = settingsPanels as Required<
  Pick<
    CardiganClient,
    "roles" | "role" | "employeeOptions" | "templates" | "template"
  >
>;
const roles = async (projectId: string): Promise<RoleListView> => ({
  ...(await base.roles(projectId)),
  launch_profiles: [
    { name: "claude-agent", harness: "claude-code", model: null },
    { name: "codex-agent", harness: "codex", model: "gpt-fixture-1" },
    { name: "pi-agent", harness: "pi", model: "fixture-model-2" },
  ],
});
const employeeOptions = async (
  projectId: string,
): Promise<EmployeeOptions> => ({
  ...(await base.employeeOptions(projectId)),
  employees: [
    {
      id: "E-1",
      name: "八戒",
      title: "开发工程师",
      status: "active",
      avatar: "/avatars/v1/zhu-bajie/head-64.webp",
      role_id: "coder",
      projects: ["p-1"],
      role_change_blocked: "run",
    },
    {
      id: "E-2",
      name: "悟净",
      title: "代码审核",
      status: "inactive",
      avatar: "/avatars/v1/sha-seng/head-64.webp",
      role_id: "reviewer",
      projects: [],
      role_change_blocked: null,
    },
  ],
});
const exported = `---
role_id: proofreader
display_name: 校对员
kind: produce
harness: codex
launch_profile: codex-agent
worktree: readonly
tools:
  set: [whoami, get_card, submit_delivery]
---
对照验收标准检查稿件，逐条列出需修改的地方。
`;
const role = (await base.role("p-1", "coder")).role;
const proofreader = {
  ...role,
  role_id: "proofreader",
  display_name: "校对员",
  version: 1,
  instructions: "对照验收标准检查稿件，逐条列出需修改的地方。",
  worktree: "readonly" as const,
  required_machine_tags: [],
};
const dev = (await base.templates("p-1")).templates[0] as TemplateVersion;
const preview = (markdown: string): RoleDocumentPreview => {
  const append = markdown.includes('"add_work_item"');
  return {
    snapshot: "0".repeat(64),
    role: {
      action: append ? "unchanged" : "create",
      role: proofreader,
      fields: [],
      relaxations: append ? [] : ["新增可用工具：submit_delivery"],
    },
    template: append
      ? {
          action: "update",
          before: { ...dev, id: "doc", builtin: false },
          after: {
            ...dev,
            id: "doc",
            version: 3,
            work_items: [
              ...dev.work_items,
              {
                key: "proofreading",
                title: "校对",
                kind: "produce",
                role_id: "proofreader",
                required: true,
              },
            ],
          },
        }
      : {
          action: "create",
          before: null,
          after: {
            ...dev,
            id: "proofread",
            title: "校对卡",
            version: 1,
            work_items: dev.work_items.map((w) =>
              w.role_id === "reviewer" ? { ...w, role_id: "proofreader" } : w,
            ),
          },
        },
    employees: append
      ? []
      : [
          {
            name: "小林",
            title: "校对员",
            role_id: "proofreader",
            launch_profile_ref: null,
            action: "create",
            id: "preview-0",
          },
        ],
  };
};
const client = fakeClient({
  ...settingsPanels,
  roles,
  employeeOptions,
  copyRole: async () => proofreader,
  role: async (projectId, roleId) =>
    roleId === "proofreader"
      ? {
          ...(await base.role(projectId, "coder")),
          role: proofreader,
          previous: null,
        }
      : base.role(projectId, roleId),
  roleHistory: async (projectId, roleId) => {
    const history = await settingsPanels.roleHistory?.(projectId, roleId);
    if (!history || roleId !== "proofreader") return history as never;
    const [first] = history.versions.slice(-1);
    return {
      ...history,
      versions: first ? [{ ...first, role: proofreader }] : [],
    };
  },
  exportRole: async () => ({ markdown: exported }),
  launchProfileNames: async () => ["claude-agent", "codex-agent", "pi-agent"],
  previewRoleDocument: async (_p, markdown) => preview(markdown),
  applyRoleDocument: async (_p, markdown) => preview(markdown),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
