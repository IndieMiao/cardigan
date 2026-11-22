import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { PreferencesView } from "../src/api.js";
import { ApiError } from "../src/api.js";
import { fakeFeishuSettings } from "../src/testing/feishu-settings.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-455: one synthetic project preference record; no backend or live data.
Date.now = () => new Date(NOW).getTime();
let preferences: PreferencesView = {
  auto_merge_after_minutes: null,
  merge_gate_enabled: false,
  flow_version: 5,
  cross_card_read: true,
  auto_merge_paused: false,
  system_auto_assign_verifiers: true,
  system_reminders: false,
  system_reminder_policy: null,
  review_max_rounds: 5,
  independent_review_max_rounds: 3,
  review_max_rounds_ceiling: 20,
  merge_confirm_stall_after_minutes: 60,
  merge_confirm_snooze_default_minutes: 240,
  merge_confirm_snooze_max_minutes: 4320,
  decision_delegation: { spending: false, publish: true },
};
const update = (patch: Partial<PreferencesView>) => {
  preferences = { ...preferences, ...patch };
};
// Evidence scene: a change made elsewhere, seen by the next read.
Object.assign(window, { settingsFixtureUpdate: update });
// Synthetic private-chat binding scenes for design acceptance (no service or SDK).
const feishuState =
  new URLSearchParams(location.search).get("feishu") === "disabled"
    ? "disabled"
    : "connected";
let feishuBound = new URLSearchParams(location.search).has("feishuBound");
Object.assign(window, {
  setFixtureFeishuBound: (bound: boolean) => {
    feishuBound = bound;
  },
});
// C-561: synthetic bot settings (?feishuConfig=1) behind the C-558 endpoints;
// without it the fixture has no settings service, like a non-owner session.
// Evidence scenes: a title limit of 999 is a synthetic failed save; the group
// bot test is sent, the private chat test times out. Nothing leaves the page.
let previewedTitle: unknown;
const feishu = new URLSearchParams(location.search).has("feishuConfig")
  ? fakeFeishuSettings(undefined, {
      now: () => NOW,
      confirmError: () =>
        previewedTitle === 999
          ? new ApiError(400, "invalid_settings", "飞书配置或凭据无效")
          : undefined,
      test: (channel) => (channel === "lark" ? "sent" : "timeout"),
    }).client
  : undefined;
// C-580: a second synthetic project for the push filter scenes (?feishuProjects=1).
const projects = new URLSearchParams(location.search).has("feishuProjects")
  ? {
      projects: async () => [
        { id: "p-1", name: "Cardigan 自己", created_at: NOW },
        { id: "p-2", name: "合成项目二", created_at: NOW },
      ],
    }
  : {};
const client = fakeClient({
  ...projects,
  ...(feishu && {
    ...feishu,
    previewFeishuSettings: (version, change) => {
      previewedTitle = change.settings?.["policy.title_limit"];
      return feishu.previewFeishuSettings(version, change);
    },
  }),
  feishuBinding: async (action) => {
    if (action === "unbind") feishuBound = false;
    return {
      state: feishuState,
      bound: feishuBound,
      ...(action === "code"
        ? {
            code: "00000000000000000000000000000000",
            expires: Date.now() + 300000,
          }
        : {}),
    };
  },
  ...settingsPanels,
  preferences: async () => preferences,
  setPreferences: async (_p, minutes) => {
    // Evidence scenes: 1439 saves slowly, 1438 fails slowly (leaving waits).
    if (minutes === 1439 || minutes === 1438)
      await new Promise((resolve) => setTimeout(resolve, 1500));
    if (minutes === 1438) throw new Error("合成失败：超时合并未保存");
    update({ auto_merge_after_minutes: minutes });
  },
  setSystemRules: async (_p, input) => {
    // Evidence scene: a threshold of 999 minutes is a synthetic failed write.
    if (input.system_reminder_policy?.min_minutes === 999)
      throw new Error("合成失败：催办阈值未保存");
    update(input);
  },
  setCrossCardRead: async (_p, value) => update({ cross_card_read: value }),
  setAutoMerge: async (_p, value) =>
    update({ auto_merge: value ? "on" : "off" }),
  setAutoMergePaused: async (_p, value) => update({ auto_merge_paused: value }),
  setPmMergeConfirmation: async (_p, value) =>
    update({ pm_merge_confirmation: value }),
  setDelegation: async (_p, category, value) =>
    update({
      decision_delegation: {
        ...preferences.decision_delegation,
        [category]: value,
      },
    }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
