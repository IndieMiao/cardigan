import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { ExecutionAssignment } from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import { launchSettingsFixture } from "../src/testing/launch-settings-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-518: synthetic launch settings (4 profiles, 3 providers, 5 references),
// the existing synthetic settings panels and two execution records; no
// backend, live data or credentials. `?models=empty|error|pending|masked`
// selects the read state (masked: the first two names redacted to `***`).
Date.now = () => new Date(NOW).getTime();
const state = new URLSearchParams(location.search).get("models");
const assignment = (
  n: number,
  employee: { id: string; name: string },
  card_title: string,
): ExecutionAssignment => ({
  id: `A-${n}`,
  role_id: "coder",
  role_version: 2,
  status: "active",
  runtime_state: "idle",
  machine_id: "local",
  standing_mode: null,
  card_id: `C-${n}`,
  card_title,
  card_status: "in_progress",
  work_item_id: `W-${n}`,
  worktree_path: null,
  branch: null,
  session_ref: null,
  runtime_ref: null,
  last_mcp_activity_at: null,
  cursors: [],
  employee: { ...employee, title: "开发工程师", avatar: null },
});
const client = fakeClient({
  ...settingsPanels,
  // A-2 is 八戒's, but its card title names 悟空.
  execution: async () => ({
    machines: [],
    runs: [],
    assignments: [
      assignment(1, { id: "E-3", name: "悟空" }, "整理模型页"),
      assignment(2, { id: "E-4", name: "八戒" }, "给悟空核对配置"),
    ],
  }),
  launchSettings: async () => {
    if (state === "pending") return new Promise(() => {});
    if (state === "error") throw new Error("合成失败：启动配置读取失败");
    if (state === "empty")
      return { version: "0".repeat(64), profiles: [], providers: [] };
    if (state === "masked")
      return {
        ...launchSettingsFixture,
        profiles: launchSettingsFixture.profiles.map((p, i) =>
          i < 2 ? { ...p, name: "***" } : p,
        ),
      };
    return launchSettingsFixture;
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
