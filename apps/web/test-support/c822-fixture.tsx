// C-822 evidence: the owner's screenshots in synthetic form. Needs You lists
// the owner's action and one handed to 张良; card C-140 waits on an action
// PM is still triaging. Synthetic data only; no server or database.
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { NeedsCounts, NeedsPage, TimelineEntryView } from "../src/api.js";
import {
  card,
  cardDetail,
  fakeClient,
  NOW,
  timelineEntry,
} from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

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
}));
const action = {
  card_id: "C-203",
  waited_ms: 3_600_000,
  due: null,
  blocked_work_items: [],
  expected_return: "项目编号",
  triage: "human" as const,
};
const page: NeedsPage = {
  decisions: [],
  incidents: [],
  human_actions: [
    {
      ...action,
      id: "H-128",
      instructions: "注册 Mixpanel 账号并建项目",
      why: "注册 Mixpanel 账号并建项目",
      executor: "owner",
      handler: "owner",
    },
    {
      ...action,
      id: "H-118",
      card_id: "C-194",
      instructions: "张良：项目规则第 1 条改指仓库的锁定清单",
      why: "张良：项目规则第 1 条改指仓库的锁定清单",
      executor: "operator",
      handler: "operator",
    },
  ],
};
// What the server answers for this page, before and after C-822 alike.
const counts: NeedsCounts = {
  total_pending: 1,
  tabs: {
    decisions: { count: 0, attention: 0 },
    merges: { count: 0, attention: 0 },
    actions: { count: 2, attention: 1 },
    later: { count: 0, attention: 0 },
    notices: { count: 0, attention: 0 },
  },
};
const instructions =
  "请核对中转线路在 07:25 前后是否中断、限流或账号异常。三个使用该线路的会话在同一分钟内停止产出，相关会话和取证已记录在本卡时间线。只在账号或线路侧查看状态，不要重启会话。";
const entries: TimelineEntryView[] = [
  timelineEntry({
    id: "C-140#3",
    event_seq: 3,
    type: "human_action",
    author: "assignment:A-588",
    author_role: "coder",
    employee: {
      id: "E-3",
      name: "赵云",
      title: "后端工程师",
      avatar: null,
    },
    human_action_id: "H-132",
    human_action_handler: "pm",
    body: `交给张良：${instructions}`,
  }),
  timelineEntry({
    id: "C-140#2",
    event_seq: 2,
    type: "human_action",
    author: "assignment:A-588",
    author_role: "coder",
    employee: {
      id: "E-3",
      name: "赵云",
      title: "后端工程师",
      avatar: null,
    },
    human_action_id: "H-131",
    human_action_handler: "done",
    body: "已在主机上复查，线路恢复。",
  }),
];
const detail = cardDetail({
  card: {
    ...card,
    id: "C-140",
    title: "植被晃动和成熟摆动：表现方案和手机性能评估",
    status: "review",
    waiting_on: [
      {
        kind: "human_action",
        ref: "H-132",
        label: "等待 PM 分拣 H-132",
        handler: "pm",
      },
    ],
    next_owners: [{ kind: "role", ref: "pm" }],
  },
  human_actions: [
    {
      id: "H-132",
      card_id: "C-140",
      instructions,
      why_human: "需要看账号后台",
      expected_return: "线路状态",
      status: "open",
    },
  ],
  timeline: entries,
  counts: {
    timeline: entries.length,
    deliveries: 1,
    reviews: 0,
    open_decisions: 0,
  },
  attachments: [],
});
(window as unknown as { c822: boolean }).c822 = true;
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
  card: async () => detail,
  needsYouCounts: async () => counts,
  needsYouSection: async (_project, section) =>
    section === "actions"
      ? page
      : { decisions: [], human_actions: [], incidents: [] },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
