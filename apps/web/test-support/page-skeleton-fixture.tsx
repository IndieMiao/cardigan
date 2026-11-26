import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// Seven synthetic cards, one per status. No network client or database.
Date.now = () => new Date(NOW).getTime();
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
  participants: [
    {
      employee: {
        id: "E-1",
        name: "示例开发",
        title: "开发工程师",
        avatar: null,
      },
      author: "assignment:A-1",
      author_role: "coder",
      author_display: "示例开发",
    },
  ],
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
  // C-771: the detail's card is bound to a known template, so the facts
  // column and the title marker show its name rather than “未知模板”.
  card: async () =>
    cardDetail({
      card: { ...cards[1], template: "dev", template_version: 2 },
      template: {
        id: "dev",
        title: "开发卡",
        version: 2,
        description: "",
        builtin: true,
        status: "active",
        requires_repo: true,
        merge: "confirm",
        require_acceptance_criteria: true,
        work_items: [],
        primary_work_item_key: "development",
        completion: { mode: "review", reviewer: "reviewer" },
      },
      attachments: [],
    }),
  executionCapacity: async () => ({
    agents: [
      {
        machine_id: "fixture",
        label: "示例机器",
        running: 2,
        total_running: 4,
        limit: 6,
        max_limit: 8,
        queued: 1,
        merge_check_slots: 0,
      },
    ],
    merge_checks: [
      { machine_id: "fixture-ci", running: 1, limit: 3, queued: 0 },
    ],
    merge_config_invalid: false,
  }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
