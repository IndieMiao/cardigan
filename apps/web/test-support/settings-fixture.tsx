import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { PreferencesView } from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

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
const client = fakeClient({
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
