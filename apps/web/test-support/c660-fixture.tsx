import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { CardListItem } from "../src/api.js";
import { card, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-660 evidence only: board cards with each waiting/blocked signal, a card
// with every metadata badge, and the existing check/superseded/done styles.
// No network client, database or real employee records.
Date.now = () => new Date(NOW).getTime();

const sha = "a".repeat(40);
const participants = ["开发", "审核", "验收", "设计"].map((name, i) => ({
  employee: {
    id: `E-${i + 1}`,
    name: `示例${name}`,
    title: name,
    avatar: null,
  },
}));
const base = (
  id: string,
  status: CardListItem["status"],
  title: string,
  patch: Partial<CardListItem> = {},
): CardListItem => ({
  ...card,
  id,
  status,
  title,
  why: "等待下一步处理",
  waiting_on: [],
  priority: 2,
  attachment_count: 0,
  participants: participants.slice(0, 3),
  ...patch,
});
const cards: CardListItem[] = [
  base("C-1", "in_progress", "没有等待：普通进行中的卡片"),
  base("C-2", "in_progress", "阻塞：缺少测试环境", {
    waiting_on: [{ kind: "blocked", ref: "W-2", label: "W-2 缺少测试环境" }],
  }),
  base("C-3", "in_progress", "等拍板：选择发布窗口", {
    waiting_on: [{ kind: "decision", ref: "Q-3", label: "选择发布窗口" }],
  }),
  base("C-4", "review", "等人工待办：连接真机设备", {
    waiting_on: [{ kind: "human_action", ref: "H-4", label: "连接真机设备" }],
  }),
  base("C-5", "review", "审核暂停：确认已齐，待你结案恢复", {
    waiting_on: [
      {
        kind: "decision",
        ref: "Q-5",
        review_phase: "待你结案恢复",
        label: "待你结案恢复 Q-5",
      },
    ],
  }),
  base(
    "C-6",
    "review",
    "多个原因同时存在：阻塞、拍板与人工待办，长标题自然换行不挤压角标",
    {
      priority: 4,
      attachment_count: 12,
      participants,
      queued_runs: [{ run_id: "R-6", assignment_id: "A-6", ahead: 3 }],
      waiting_on: [
        { kind: "decision", ref: "Q-6", label: "确定版本号" },
        { kind: "human_action", ref: "H-6", label: "轮换发布凭据" },
        { kind: "blocked", ref: "W-6", label: "W-6 依赖 C-2" },
        { kind: "decision", ref: "Q-7", label: "选择回滚策略" },
      ],
    },
  ),
  base("C-7", "todo", "只等预检结果：不显示阻塞角标", {
    waiting_on: [{ kind: "blocked", ref: "W-7", label: "W-7 阻塞" }],
    prechecks: [{ attempt_id: "P-7", head_sha: sha, status: "running" }],
    checking: { precheck: { attempt_ids: ["P-7"], waiting_items: ["W-7"] } },
  }),
  base("C-8", "awaiting_merge", "待合并：合并检查运行中", {
    checking: { merge_check: { attempt_id: "M-8", status: "running" } },
  }),
  base("C-9", "awaiting_merge", "待合并但人工待办未完成", {
    attachment_count: 3,
    waiting_on: [{ kind: "human_action", ref: "H-9", label: "确认上线时间" }],
  }),
  base("C-10", "cancelled", "已被取代的卡片", {
    resolution: "superseded",
    superseded_by: "C-1",
  }),
  base("C-11", "done", "已完成的卡片", {
    progress: { completed: 2, total: 2 },
  }),
];

const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_project, filter) => ({
    project_id: "p-1",
    filter,
    cards,
    counts: { total: cards.length, needs_me: 0, agent: cards.length },
  }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
