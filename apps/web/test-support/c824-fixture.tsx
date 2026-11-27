import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { ExecutionCapacity } from "../src/api.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-824 synthetic data, the same counts as the owner's screenshot: 3 Agent
// machines with resource slots, 2 CI targets, 7 cards. No server or database.
Date.now = () => new Date(NOW).getTime();
const capacity: ExecutionCapacity = {
  agents: [
    {
      machine_id: "cardigan-ci",
      label: "cardigan-ci",
      running: 4,
      total_running: 4,
      limit: 12,
      max_limit: 16,
      queued: 1,
      merge_check_slots: 0,
      resources: [
        { key: "android.emulator", occupied: 1, limit: 1 },
        { key: "blender", occupied: 0, limit: 1 },
        { key: "godot", occupied: 1, limit: 2 },
      ],
    },
    {
      machine_id: "local",
      label: "local",
      running: 2,
      total_running: 3,
      limit: 4,
      max_limit: 8,
      queued: 0,
      merge_check_slots: 0,
      resources: [
        { key: "android.emulator", occupied: 0, limit: 1 },
        { key: "blender", occupied: 0, limit: 1 },
        { key: "godot", occupied: 0, limit: 1 },
      ],
    },
    {
      machine_id: "mac-mini",
      label: "mac-mini",
      running: 2,
      total_running: 2,
      limit: 6,
      max_limit: 8,
      queued: 0,
      merge_check_slots: 0,
      resources: [
        { key: "android.emulator", occupied: 1, limit: 1 },
        { key: "blender", occupied: 0, limit: 1 },
        { key: "godot", occupied: 1, limit: 3 },
        { key: "ios.simulator", occupied: 0, limit: 1 },
      ],
    },
  ],
  merge_checks: [
    {
      machine_id: "github-actions",
      executor_type: "github",
      running: 2,
      limit: 16,
      queued: 0,
    },
    {
      machine_id: "github-actions-sensen",
      executor_type: "github",
      running: 1,
      limit: 4,
      queued: 0,
    },
  ],
  merge_config_invalid: false,
};
const cards = (
  [
    "todo",
    "in_progress",
    "review",
    "awaiting_merge",
    "backlog",
    "cancelled",
    "done",
  ] as const
).map((status, i) => ({
  ...card,
  id: `C-${i + 1}`,
  title:
    i === 1 ? "核对卡片页工具栏、长标题与下一步负责人" : `示例任务 ${i + 1}`,
  status,
  waiting_on: [],
  why: "等待下一步处理",
  priority: i % 5,
  attachment_count: i,
}));
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_project, filter) => ({
    project_id: "p-1",
    filter,
    cards,
    counts: { total: 7, needs_me: 0, agent: 7 },
  }),
  card: async () => cardDetail({ card: cards[1], attachments: [] }),
  executionCapacity: async () => capacity,
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
