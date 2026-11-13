import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { CardListItem } from "../src/api.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";
import "./c210-board.css";

// Design fixture only. All data stays local; the production App is unchanged.
const before = new URLSearchParams(location.search).get("version") === "before";
document.documentElement.dataset.c210 = before ? "before" : "after";
Date.now = () => new Date(NOW).getTime();
if (!location.hash) location.hash = "#/p/p-1/cards?view=board";
const titles = [
  "看板卡片显示优化：加宽、弱化滚动条、标题不加粗",
  "暗色主题改为中性深灰，减少界面装饰",
  "统一编号标签的样式与交互",
  "让拍板时的关键信息更容易找到",
  "长标题：检查跨浏览器的滚动条与键盘访问体验",
  "收起次要说明，保留可追溯的完整信息",
  "改进卡片附件预览的阅读体验",
  "完成亮色、暗色和窄屏下的截图核对",
  "核对等待拍板与阻塞两种状态的区别",
  "保留筛选、排序及列折叠的现有行为",
  "处理包含 very_long_unbroken_identifier_0123456789 的标题",
  "检查更多卡片加载后的布局稳定性",
];
const participants = [
  {
    kind: "assignment" as const,
    ref: "A-1",
    employee: {
      id: "E-8",
      name: "晴雯",
      title: "UI/UX 设计师",
      avatar: "/avatars/v1/qingwen/head-64.webp",
    },
  },
  {
    kind: "assignment" as const,
    ref: "A-2",
    employee: {
      id: "E-9",
      name: "妙玉",
      title: "设计总监",
      avatar: "/avatars/v1/miaoyu/head-64.webp",
    },
  },
];
const cards: CardListItem[] = [
  "todo",
  "in_progress",
  "review",
  "awaiting_merge",
  "done",
].flatMap((status, lane) =>
  titles.slice(0, lane < 3 ? 12 : 2).map((title, i) => ({
    ...card,
    id: `C-${210 - lane * 20 - i}`,
    title,
    status: status as CardListItem["status"],
    priority: i % 5,
    updated_at: new Date(
      new Date(NOW).getTime() - (i + 1) * 3600000,
    ).toISOString(),
    waiting_on:
      i === 3
        ? [{ kind: "decision", ref: "Q-1", label: "请确认设计" }]
        : i === 8
          ? [{ kind: "blocked", ref: "W-1", label: "等待前置交付" }]
          : [],
    why: "按设计要求核对中",
    progress: { completed: lane === 4 ? 3 : i % 3, total: 3 },
    participants,
    next_owners: [{ kind: "role", ref: lane === 2 ? "reviewer" : "coder" }],
    attachment_count: i % 3 === 0 ? 2 : 0,
  })),
);
const client = fakeClient({
  projects: async () => [{ id: "p-1", name: "Cardigan", created_at: NOW }],
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_project, filter) => ({
    project_id: "p-1",
    filter,
    cards,
    counts: { total: cards.length, needs_me: 3, agent: cards.length - 3 },
  }),
  card: async (_project, id) =>
    cardDetail({
      card: cards.find((item) => item.id === id) ?? cards[0],
      attachments: [],
      timeline: [],
    }),
});
const root = document.getElementById("root");
if (root) createRoot(root).render(<App client={client} />);
