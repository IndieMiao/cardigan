import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { DecisionHistoryRecord } from "../src/api.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-457: 13 synthetic decisions (10 + 3 behind "加载更多"), every decision
// maker, several categories, superseded/revoked records, plain summaries,
// a human-only reason and a delegation authority. The cards, capacity and
// clock are the page-skeleton fixture's, so the header matches the cards page.
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
const owner = {
  resolved_by: "human",
  via: "needs_you",
  author_display: "示例所有者",
  member: { id: "M-1", name: "示例所有者", title: "所有者", avatar: null },
};
const pm = {
  resolved_by: "assignment:A-2",
  via: "delegated",
  author_display: "示例 PM",
  author_role: "pm",
  employee: { id: "E-2", name: "示例 PM", title: "项目经理", avatar: null },
  proxy_authority: "project:p-1/default-decision-delegation/general",
};
const system = { resolved_by: "system", via: "system" };
const questions = [
  "是否把设置页拆成分组导航，并保留现有每个开关的位置与默认值？",
  "是否安排下一轮审核？",
  "是否继续检查页面截图？",
  "范围是否扩大到 Needs You 的全部标签页？",
  "是否允许 PM 代为处理权限类事项？",
  "是否轮换检查环境的访问凭据？",
  "是否删除过期的合成截图？",
  "是否对外发布版本说明？",
  "Merge C-3 into main?",
  "是否调整默认刷新周期？",
  "是否保留旧筛选写法作为兼容入口？",
  "是否为拍板记录增加卡片筛选？",
  "是否补充帮助页中的拍板说明？",
];
const categories = [
  "feature_detail",
  "general",
  "general",
  "scope_change",
  "permission",
  "credential",
  "data_deletion",
  "publish",
  "general",
  "feature_detail",
  "general",
  "feature_detail",
  "general",
] as const;
const decisions: DecisionHistoryRecord[] = questions.map((question, i) => {
  const maker = (["human", "pm", "system"] as const)[i % 3] ?? "human";
  const merge = question.startsWith("Merge ");
  return {
    id: `Q-${40 - i}`,
    question,
    status: i === 4 ? "superseded" : i === 7 ? "revoked" : "resolved",
    blocking: i % 2 === 0,
    decider: maker === "human" ? "human" : "role:pm",
    category: categories[i] ?? "general",
    card_id: `C-${(i % 7) + 1}`,
    affected_cards: i === 0 ? ["C-2", "C-4"] : [],
    decision_maker: maker,
    recommended: merge ? "merge" : "go",
    ...(merge ? { trigger: "merge_confirmation" } : {}),
    options: merge
      ? [
          { key: "merge", description: "Merge", impact: "合入主分支" },
          { key: "hold", description: "Hold", impact: "保持当前分支" },
        ]
      : [
          {
            key: "go",
            description: i === 0 ? "按分组导航重排设置页" : "继续",
            impact:
              i === 0
                ? "设置页按分组显示，开关位置和默认值不变"
                : "按当前安排继续",
          },
          { key: "hold", description: "暂缓", impact: "保持当前状态" },
        ],
    ...(i % 4 === 0
      ? {
          plain_summary: {
            changed: "设置页按分组导航重新排列。",
            impact: "各开关默认状态不变。",
            risk: i === 4 ? "放宽 PM 的代拍范围" : "无",
          },
        }
      : {}),
    ...(i === 5
      ? { human_required_reason: "凭据轮换需要所有者亲自确认。" }
      : {}),
    resolution: {
      option: i === 9 ? "hold" : merge ? "merge" : "go",
      rationale:
        i === 0
          ? "设置项已经超过一屏，分组后更容易找到；**不改**任何开关的含义。"
          : "按当前安排继续。",
      raw_quote: "继续",
      at: new Date(new Date(NOW).getTime() - i * 3_600_000).toISOString(),
      ...(maker === "human" ? owner : maker === "pm" ? pm : system),
    },
  };
});
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
  decisionHistory: async (_project, filters, cursor) => {
    const empty = new URLSearchParams(location.search).has("empty");
    const matched = empty
      ? []
      : decisions.filter(
          (q) =>
            (!filters.decider || q.decision_maker === filters.decider) &&
            (!filters.category || q.category === filters.category),
        );
    const start = cursor ? 10 : 0;
    return {
      decisions: matched.slice(start, start + 10),
      next_cursor: !cursor && matched.length > 10 ? "page-2" : null,
    };
  },
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
