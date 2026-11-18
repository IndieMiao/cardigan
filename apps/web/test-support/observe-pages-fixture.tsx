import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { ActivityData, SnapshotData } from "../src/api.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-458: project activity and snapshot with the cards-page synthetic data.
// Seven cards, 14 events over two days, no network client or database.
Date.now = () => new Date(NOW).getTime();
const statuses = [
  "todo",
  "in_progress",
  "review",
  "awaiting_merge",
  "backlog",
  "cancelled",
  "done",
] as const;
const cards = statuses.map((status, i) => ({
  ...card,
  id: `C-${i + 1}`,
  title:
    i === 1 ? "核对卡片页工具栏、长标题与下一步负责人" : `示例任务 ${i + 1}`,
  status,
  waiting_on: [],
  why: i === 1 ? "等待审核员给出结论后合并" : "等待下一步处理",
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
const employee = {
  id: "E-1",
  name: "示例开发",
  title: "开发工程师",
  avatar: null,
};
type Event = ActivityData["events"][number];
const at = (minutes: number) =>
  new Date(new Date(NOW).getTime() - minutes * 60000).toISOString();
const event = (
  seq: number,
  minutes: number,
  type: string,
  overrides: Partial<Event> = {},
): Event => ({
  id: `event-${seq}`,
  card_id: "C-2",
  card_title: cards[1]?.title ?? null,
  seq,
  type,
  role: "coder",
  created_at: at(minutes),
  payload: { work_item_id: "W-3", note: `合成事件 ${seq}` },
  employee,
  author_display: "示例开发",
  actor: { kind: "assignment", assignment_id: "A-1" },
  ...overrides,
});
const system = { kind: "system" } as const;
const events: Event[] = [
  event(14, 3, "delivery_submitted"),
  event(13, 8, "run_started", {
    actor: system,
    employee: undefined,
    author_display: "系统",
  }),
  event(12, 9, "run_dispatched", {
    actor: system,
    employee: undefined,
    author_display: "系统",
  }),
  event(11, 9, "run_dispatched", {
    actor: system,
    employee: undefined,
    author_display: "系统",
  }),
  event(10, 20, "review_submitted", {
    card_id: "C-3",
    card_title: cards[2]?.title ?? null,
    role: "reviewer",
    employee: undefined,
    author_display: undefined,
  }),
  event(9, 35, "comment_posted", {
    card_id: "C-4",
    card_title: cards[3]?.title ?? null,
    role: "pm",
    employee: undefined,
    author_display: undefined,
    payload: {
      body: "合成评论：请先合入最新基线，再重新申请预检。".repeat(3),
    },
  }),
  event(8, 50, "cross_card_read", {
    card_id: null,
    card_title: null,
    payload: {
      card_ids: ["C-1", "C-3", "C-5", "C-7"],
      card_count: 4,
      tool: "project_snapshot",
    },
  }),
  event(7, 1500, "decision_requested", {
    card_id: "C-1",
    card_title: cards[0]?.title ?? null,
    role: "pm",
    employee: undefined,
    author_display: undefined,
  }),
  event(6, 1520, "card_merged", {
    card_id: "C-7",
    card_title: cards[6]?.title ?? null,
    actor: system,
    employee: undefined,
    author_display: "系统",
  }),
  event(5, 1600, "run_finished"),
  event(4, 1700, "comment_posted", {
    card_id: null,
    card_title: null,
    actor: { kind: "human" },
    role: "human",
    employee: undefined,
    author_display: undefined,
  }),
];
const activity: ActivityData = {
  cards: cards.map((c) => ({ id: c.id, title: c.title })),
  events,
  next_before: "event-4",
  counts: { returned: events.length, matched: 24 },
};
const snapshot: SnapshotData = {
  cards,
  in_progress: cards.filter((c) => c.status === "in_progress"),
  in_review: cards.filter(
    (c) => c.status === "review" || c.status === "awaiting_merge",
  ),
  blocked: [
    { card_id: "C-3", work_item_id: "W-7", label: "等待代码审核 V-12" },
    { card_id: "C-2", work_item_id: "W-3", label: "阻塞：缺少合成测试环境" },
  ],
  waiting: { human: ["C-1", "C-4"], agent: ["C-2", "C-3"] },
  recent_deliveries: [
    {
      id: "D-9",
      work_item_id: "W-3",
      work_item_title: "前端开发",
      submitted_at: at(3),
      card_id: "C-2",
      summary:
        "重构项目动态与项目快照两页，复用页头、工具栏、表格与分组组件；数据与筛选保持不变。",
      status: "submitted",
    },
    {
      id: "D-8",
      work_item_id: "W-6",
      work_item_title: "代码审核",
      submitted_at: at(1520),
      card_id: "C-7",
      summary: "合成交付摘要",
      status: "accepted",
    },
    {
      id: "D-7",
      submitted_at: null,
      card_id: null,
      summary: "项目级交付",
      status: "superseded",
    },
  ],
};
function matching(filter: { card_id?: string; actor?: string }) {
  const found = events.filter(
    (e) =>
      (!filter.card_id || e.card_id === filter.card_id) &&
      (!filter.actor ||
        (filter.actor === "system"
          ? e.actor.kind === "system"
          : e.role === filter.actor)),
  );
  return {
    ...activity,
    events: found,
    next_before: null,
    counts: { returned: found.length, matched: found.length },
  };
}
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
  activity: async (_project, filter) =>
    filter.before
      ? {
          ...activity,
          events: [],
          next_before: null,
          counts: { returned: 0, matched: 24 },
        }
      : filter.card_id || filter.actor
        ? matching(filter)
        : activity,
  snapshot: async () =>
    new URLSearchParams(location.search).has("empty")
      ? {
          ...snapshot,
          cards: [],
          in_progress: [],
          in_review: [],
          blocked: [],
          waiting: { human: [], agent: [] },
          recent_deliveries: [],
        }
      : snapshot,
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
