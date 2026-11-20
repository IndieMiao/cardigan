import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import {
  ApiError,
  type EmployeeOptions,
  type EmployeeSummary,
  type LaunchChange,
  type LaunchProfileCheck,
  type LaunchSettingsView,
} from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import { launchSettingsFixture } from "../src/testing/launch-settings-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-516: the C-518 synthetic launch settings (4 profiles, 3 providers, 2 model
// aliases, 5 references, 4 secrets.env key names, no values) behind a mocked
// C-515 write API: previews are computed here, confirmations apply simple
// changes to this in-memory copy, checks never leave the page (a timer stands
// in for the host). No backend, endpoint, credential or paid call.
//   ?confirm=stale   the first confirmation answers 409 stale_snapshot
//   ?preview=invalid a new profile's name is refused by the "server"
//   ?check=hold      a started check stays running
// Employees (C-516 item 4): the two the launch fixture names as pinning a
// profile (悟空 → claude-opus, 八戒 → claude-local, with a run in progress)
// and one following the role; saving the drawer updates this copy.
Date.now = () => new Date(NOW).getTime();
const query = new URLSearchParams(location.search);
let current: LaunchSettingsView = structuredClone(launchSettingsFixture);
let staleOnce = query.get("confirm") === "stale";
const previews = new Map<string, LaunchChange>();

function diff(change: LaunchChange) {
  const profile = current.profiles.find((p) => p.name === change.name);
  const before: Record<string, unknown> = profile
    ? {
        harness: profile.harness,
        provider: profile.provider,
        model: profile.model_alias ?? profile.model_id,
        ...profile.parameters,
      }
    : {};
  switch (change.op) {
    case "create_profile":
    case "edit_profile":
      return Object.entries(change.fields).map(([k, v]) => ({
        field: `profiles.${change.name}.${k}`,
        before: before[k] ?? null,
        after: v,
      }));
    case "copy_profile":
      return [
        {
          field: `profiles.${change.name}`,
          before: null,
          after: { copy_of: change.source },
        },
      ];
    case "delete_profile":
      return [
        { field: `profiles.${change.name}`, before: change.name, after: null },
      ];
    case "set_model":
      return [
        {
          field: `models.${change.name}.id`,
          before: current.models?.[change.name]?.id ?? null,
          after: change.id,
        },
      ];
    case "edit_provider": {
      const provider = current.providers.find((p) => p.id === change.name);
      const { secret_env, ...rest } = change.fields;
      return [
        ...Object.entries(rest).map(([k, v]) => ({
          field: `providers.${change.name}.${k}`,
          before: provider?.[k as "name" | "base_url"] ?? null,
          after: v,
        })),
        ...Object.entries(secret_env ?? {}).map(([env, key]) => ({
          field: `providers.${change.name}.secret_env.${env}`,
          before: provider?.secret_env?.[env] ?? null,
          after: key,
        })),
      ];
    }
  }
}

function apply(change: LaunchChange) {
  const profiles = [...current.profiles];
  const index = profiles.findIndex((p) => p.name === change.name);
  const base = profiles[index];
  if (change.op === "edit_profile" && base) {
    const { harness, provider, model, ...parameters } = change.fields;
    profiles[index] = {
      ...base,
      ...(harness === undefined ? {} : { harness }),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model_alias: null, model_id: model }),
      parameters: { ...base.parameters, ...parameters },
    };
  } else if (change.op === "delete_profile") profiles.splice(index, 1);
  current = { ...current, profiles };
}

function check(
  mode: LaunchProfileCheck["mode"],
  status: LaunchProfileCheck["status"],
): LaunchProfileCheck {
  return {
    id: "00000000-0000-4000-8000-0000000000c5",
    version: current.version,
    mode,
    started_at: NOW,
    finished_at: status === "running" ? null : NOW,
    status,
    problems: [],
    cli_version: null,
  };
}
const setCheck = (name: string, last: LaunchProfileCheck) => {
  current = {
    ...current,
    profiles: current.profiles.map((p) =>
      p.name === name ? { ...p, last_check: last } : p,
    ),
  };
};

let employees: EmployeeSummary[] = [
  {
    id: "E-3",
    name: "悟空",
    title: "开发工程师",
    status: "active",
    avatar: "/avatars/v1/sun-wukong/head-64.webp",
    role_id: "coder",
    projects: ["p-1"],
    launch_profile_ref: "claude-opus",
    role_change_blocked: null,
  },
  {
    id: "E-4",
    name: "八戒",
    title: "代码审核",
    status: "active",
    avatar: "/avatars/v1/zhu-bajie/head-64.webp",
    role_id: "reviewer",
    projects: ["p-1"],
    launch_profile_ref: "claude-local",
    role_change_blocked: "run",
  },
  {
    id: "E-5",
    name: "悟净",
    title: "开发工程师",
    status: "active",
    avatar: "/avatars/v1/sha-seng/head-64.webp",
    role_id: "coder",
    projects: ["p-1"],
    launch_profile_ref: null,
    role_change_blocked: null,
  },
];
const employeeOptions = async (projectId: string): Promise<EmployeeOptions> => {
  const base = await settingsPanels.employeeOptions?.(projectId);
  return {
    library: (base?.library ?? []).map((item) => {
      const used = employees.find((e) => e.avatar?.includes(`/${item.id}/`));
      return {
        ...item,
        occupied_by: used
          ? { id: used.id, name: used.name, status: "active" as const }
          : null,
      };
    }),
    // What "跟随角色" resolves to (the launch fixture's role references).
    roles: [
      {
        role_id: "coder",
        display_name: "开发工程师",
        launch_profile_ref: "codex-sol",
      },
      {
        role_id: "reviewer",
        display_name: "代码审核",
        launch_profile_ref: "claude-opus",
      },
    ],
    employees: structuredClone(employees),
  };
};

const client = fakeClient({
  ...settingsPanels,
  employeeOptions,
  launchProfileNames: async () => current.profiles.map((p) => p.name),
  updateEmployee: async (_project, id, patch) => {
    employees = employees.map((e) => (e.id === id ? { ...e, ...patch } : e));
    const saved = employees.find((e) => e.id === id);
    if (!saved) throw new ApiError(404, "not_found", "员工不存在");
    return saved;
  },
  // Connected at once: no "正在连接实时更新…" notice over the drawers.
  subscribe: (_project, callbacks) => {
    queueMicrotask(() => callbacks.status("live"));
    return () => {};
  },
  launchSettings: async () => structuredClone(current),
  previewLaunchChange: async (version, change) => {
    if (version !== current.version)
      throw new ApiError(409, "stale_snapshot", "启动配置已变化");
    if (query.get("preview") === "invalid" && change.op === "create_profile")
      throw new ApiError(400, "validation_failed", "未通过校验", false, {
        field: "name",
      });
    const id = crypto.randomUUID();
    previews.set(id, change);
    return { version, preview_id: id, diff: diff(change) };
  },
  confirmLaunchChange: async (_version, id) => {
    if (staleOnce) {
      staleOnce = false;
      throw new ApiError(409, "stale_snapshot", "启动配置已变化");
    }
    const change = previews.get(id);
    if (change) apply(change);
  },
  startLaunchCheck: async (version, profile, mode) => {
    setCheck(profile, check(mode, "running"));
    if (query.get("check") !== "hold")
      window.setTimeout(() => setCheck(profile, check(mode, "passed")), 1200);
    // The same id the read reports, so the page sees this check arrive.
    return {
      id: "00000000-0000-4000-8000-0000000000c5",
      profile,
      mode,
      version,
      status: "running",
    };
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
