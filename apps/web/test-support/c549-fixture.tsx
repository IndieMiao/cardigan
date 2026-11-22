import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import {
  ApiError,
  type LaunchChange,
  type LaunchProfileCheck,
  type LaunchProviderView,
  type LaunchSettingsView,
} from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import { launchSettingsFixture } from "../src/testing/launch-settings-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-549: the synthetic launch settings (4 profiles, 4 Providers, 2 model
// aliases, 4 secrets.env key names, no values) behind a mocked preview /
// confirm / probe API computed in the page. Secret values typed by the
// capture script are fake and are dropped here, never stored or shown.
// No backend, endpoint, credential or paid call.
//   ?confirm=stale  the first confirmation answers 409 stale_snapshot
//   ?confirm=fail   the first confirmation answers 500 write_failed
//   ?confirm=lost   the first confirmation and its check get no reply
//   ?check=hold     a started probe stays running
Date.now = () => new Date(NOW).getTime();
const query = new URLSearchParams(location.search);
let current: LaunchSettingsView = structuredClone(launchSettingsFixture);
let failOnce = query.get("confirm") ?? "";
const previews = new Map<string, LaunchChange>();

function diff(change: LaunchChange) {
  if (change.op === "delete_provider" || change.op === "delete_profile")
    return [
      {
        field: `${change.op === "delete_provider" ? "providers" : "profiles"}.${change.name}`,
        before: change.name,
        after: null,
      },
    ];
  if (change.op !== "create_provider" && change.op !== "edit_provider")
    return [{ field: `profiles.${change.name}`, before: null, after: null }];
  const provider = current.providers.find((p) => p.id === change.name);
  const { env, secret_env, ...rest } = change.fields;
  const before = (k: string) =>
    (provider as unknown as Record<string, unknown> | undefined)?.[k] ?? null;
  return [
    ...Object.entries(rest).map(([k, v]) => ({
      field: `providers.${change.name}.${k}`,
      before: before(k),
      after: v,
    })),
    ...Object.entries(env ?? {}).map(([k, v]) => ({
      field: `providers.${change.name}.env.${k}`,
      // V-2708: a hidden value comes back as a status, never its text.
      before: (() => {
        const row = provider?.env?.find((e) => e.name === k);
        return row && row.value === null
          ? { hidden: true }
          : (row?.value ?? null);
      })(),
      after: v,
    })),
    ...Object.entries(secret_env ?? {}).map(([k, v]) => ({
      field: `providers.${change.name}.secret_env.${k}`,
      before: provider?.secret_env?.[k] ?? null,
      after: v,
    })),
    ...[
      ...(change.secrets?.set ?? []).map((key) => [key, "new"] as const),
      ...(change.secrets?.clear ?? []).map((key) => [key, "unset"] as const),
    ].map(([key, after]) => ({
      field: `secrets.${key}`,
      before: provider?.secrets?.find((s) => s.key === key)?.set
        ? "set"
        : "unset",
      after,
    })),
  ];
}

function apply(change: LaunchChange) {
  if (change.op === "delete_provider")
    current = {
      ...current,
      providers: current.providers.filter((p) => p.id !== change.name),
    };
  if (change.op !== "create_provider" && change.op !== "edit_provider") return;
  const old = current.providers.find((p) => p.id === change.name);
  const f = change.fields;
  const secretEnv = { ...(old?.secret_env ?? {}) };
  for (const [k, v] of Object.entries(f.secret_env ?? {}))
    if (v === null) delete secretEnv[k];
    else secretEnv[k] = v;
  const env = (old?.env ?? []).filter((e) => f.env?.[e.name] !== null);
  for (const [k, v] of Object.entries(f.env ?? {}))
    if (v !== null && !env.some((e) => e.name === k))
      env.push({ name: k, value: v });
  const set = new Set(change.secrets?.set ?? []);
  const cleared = new Set(change.secrets?.clear ?? []);
  const next: LaunchProviderView = {
    id: change.name,
    name: f.name ?? old?.name ?? change.name,
    base_url: f.base_url ?? old?.base_url ?? null,
    harness: f.harness === undefined ? (old?.harness ?? null) : f.harness,
    api: f.api === undefined ? (old?.api ?? null) : f.api,
    env,
    secret_env: secretEnv,
    secrets: Object.entries(secretEnv).map(([envName, key]) => ({
      env: envName,
      key,
      set: set.has(key)
        ? true
        : cleared.has(key)
          ? false
          : (old?.secrets?.find((s) => s.key === key)?.set ?? false),
      updated_at: set.has(key) || cleared.has(key) ? NOW : null,
    })),
    profiles: old?.profiles ?? [],
    models: old?.models ?? [],
    last_check: old?.last_check ?? null,
  };
  current = {
    ...current,
    providers: old
      ? current.providers.map((p) => (p.id === change.name ? next : p))
      : [...current.providers, next],
  };
}

function check(
  status: LaunchProfileCheck["status"],
  problems: string[] = [],
): LaunchProfileCheck {
  return {
    id: "00000000-0000-4000-8000-0000000000c9",
    version: current.version,
    mode: "online",
    started_at: NOW,
    finished_at: status === "running" ? null : NOW,
    status,
    problems,
    cli_version: null,
  };
}
const setCheck = (id: string, last: LaunchProfileCheck) => {
  current = {
    ...current,
    providers: current.providers.map((p) =>
      p.id === id ? { ...p, last_check: last } : p,
    ),
  };
};

const client = fakeClient({
  ...settingsPanels,
  subscribe: (_project, callbacks) => {
    queueMicrotask(() => callbacks.status("live"));
    return () => {};
  },
  launchSettings: async () => structuredClone(current),
  previewLaunchChange: async (version, change) => {
    if (version !== current.version)
      throw new ApiError(409, "stale_snapshot", "启动配置已变化");
    const id = crypto.randomUUID();
    previews.set(id, change);
    return { version, preview_id: id, diff: diff(change) };
  },
  confirmLaunchChange: async (_version, id) => {
    if (failOnce === "stale") {
      failOnce = "";
      current = { ...current, version: "c".repeat(64) };
      throw new ApiError(409, "stale_snapshot", "启动配置已变化");
    }
    if (failOnce === "lost" || failOnce === "lost-check") {
      failOnce = failOnce === "lost" ? "lost-check" : "";
      throw new TypeError("Failed to fetch");
    }
    if (failOnce === "fail") {
      failOnce = "";
      throw new ApiError(500, "write_failed", "写入失败，已恢复原文件");
    }
    const change = previews.get(id);
    if (change) apply(change);
  },
  startProviderCheck: async (version, provider) => {
    setCheck(provider, check("running"));
    if (query.get("check") !== "hold")
      window.setTimeout(
        () =>
          setCheck(
            provider,
            provider === "relay"
              ? check("failed", ["missing_secret"])
              : check("passed"),
          ),
        1200,
      );
    return {
      id: "00000000-0000-4000-8000-0000000000c9",
      profile: `provider:${provider}`,
      mode: "online",
      version,
      status: "running",
    };
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
