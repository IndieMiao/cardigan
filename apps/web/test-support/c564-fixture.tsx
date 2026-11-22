import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import {
  ApiError,
  type LaunchChange,
  type LaunchModelList,
  type LaunchSettingsView,
} from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import { launchSettingsFixture } from "../src/testing/launch-settings-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-564: the synthetic launch settings (C-549 fixture: 4 profiles, 4
// Providers, 2 model aliases) behind a mocked model list and preview, both
// computed in the page. No host, models.dev, Provider endpoint, credential
// or inference is contacted.
//   ?models=fail    the model list request fails (HTTP 502)
//   ?models=hold    the model list never answers (loading)
//   ?models=down    the host answers, but the catalog and listing failed
//   ?legacy=1       claude-opus holds a hand-written permission mode
Date.now = () => new Date(NOW).getTime();
const query = new URLSearchParams(location.search);
const settings: LaunchSettingsView = {
  ...structuredClone(launchSettingsFixture),
  profiles: launchSettingsFixture.profiles.map((p) =>
    query.get("legacy") && p.name === "claude-opus"
      ? { ...p, parameters: { ...p.parameters, permission_mode: "default" } }
      : p,
  ),
};
const models: Record<string, LaunchModelList["models"]> = {
  anthropic: [
    {
      id: "claude-fixture-haiku",
      sources: ["catalog"],
      context_window: 200000,
      max_output_tokens: 8000,
    },
    {
      id: "claude-fixture-sonnet",
      sources: ["catalog", "provider"],
      context_window: 1000000,
      max_output_tokens: 64000,
      reasoning_efforts: ["low", "medium", "high"],
    },
    {
      id: "claude-opus-fixture-1",
      sources: ["catalog", "provider"],
      context_window: 200000,
      max_output_tokens: 32000,
      reasoning_efforts: ["low", "medium", "high"],
    },
    { id: "gateway-private-1", sources: ["provider"] },
  ],
  deepseek: [
    {
      id: "deepseek-chat",
      sources: ["catalog", "provider"],
      context_window: 64000,
    },
  ],
};
const diff = (change: LaunchChange) =>
  "fields" in change
    ? Object.entries(change.fields).map(([field, after]) => ({
        field: `profiles.${change.name}.${field}`,
        before:
          field === "model"
            ? "opus"
            : field === "permission_mode"
              ? "bypassPermissions"
              : null,
        after,
      }))
    : [];
const client = fakeClient({
  ...settingsPanels,
  subscribe: (_project, callbacks) => {
    queueMicrotask(() => callbacks.status("live"));
    return () => {};
  },
  launchSettings: async () => structuredClone(settings),
  launchModels: (version, provider) => {
    const mode = query.get("models");
    if (mode === "hold") return new Promise(() => {});
    if (mode === "fail")
      return Promise.reject(new ApiError(502, "bad_gateway", "接入点无响应"));
    return Promise.resolve({
      version,
      provider,
      catalog: {
        status:
          mode === "down"
            ? "unavailable"
            : provider in models
              ? "ok"
              : "not_listed",
        providers: provider in models ? [provider] : [],
        fetched_at: mode === "down" ? null : NOW,
      },
      listing: { status: mode === "down" ? "failed" : "ok" },
      models: mode === "down" ? [] : (models[provider] ?? []),
    });
  },
  // A typed ID: "gateway-hidden" is listed by the Provider, others are not.
  checkLaunchModel: async (_version, provider, model) => ({
    provider,
    model,
    status: model === "gateway-hidden" ? "listed" : "not_listed",
  }),
  previewLaunchChange: async (version, change) => ({
    version,
    preview_id: crypto.randomUUID(),
    diff: diff(change),
  }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
