import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { CardDetail, CardListItem } from "../src/api.js";
import {
  card,
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

// Seed label 408, three fixed synthetic cards. C-283's shape only, no production prose.
const now = "2026-11-17T00:00:00.000Z";
Date.now = () => Date.parse(now);
const states = ["backlog", "in_progress", "review"] as const;
const ids = ["C-283", "C-501", "C-502"];
const details: CardDetail[] = states.map((status, index) => {
  const base = cardDetail();
  const id = ids[index] ?? "C-283";
  return {
    ...base,
    card: {
      ...base.card,
      id,
      status,
      title:
        index === 0
          ? "整理后续接管契约与确认顺序"
          : index === 1
            ? "实现共享卡片详情与抽屉布局"
            : "统一详情与抽屉布局，并保留长标题、完整操作后果和审核记录的阅读入口",
      goal: "整理卡片信息，让状态、下一步和关键操作容易找到。长标题与无值状态使用固定合成样本核对。",
      acceptance_criteria: [
        "详情页和抽屉使用同一套组件",
        "保留确认与键盘操作，窄屏没有横向溢出",
      ],
      created_at: now,
      why: index === 0 ? "待规划" : "",
      source: {
        kind: "quote",
        text: "这是一段用于布局验证的合成来源：标题只保留一次，状态信息紧凑排列，背景默认折叠。用于检查长文本和单行省略。",
      },
      risk_tags: ["permission", "security", "numeric_rule"],
      waiting_on:
        index === 2
          ? [{ kind: "review", ref: "W-2", label: "等代码审核" }]
          : [],
      next_owners: index
        ? [
            {
              kind: "role",
              ref: index === 1 ? "coder" : "reviewer",
              author_display: index === 1 ? "开发员工" : "审核员工",
            },
          ]
        : [],
      prechecks:
        index === 2
          ? [
              {
                attempt_id: "06GYDF22VAN4WMAVRJ9XKPB514",
                head_sha: "a".repeat(40),
                status: "passed",
                updated_at: "2026-11-16T23:45:00.000Z",
                log_ref: "06GYDF22VAN4WMAVRJ9XKPB514.log",
              },
            ]
          : [],
    },
    updated_at: "2026-11-16T23:30:00.000Z",
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
    merge_confirmations: [],
    decisions: [],
    deliveries: [],
    reviews: [],
    attachments: [],
    recent_conclusions: [],
    relations: {
      cards: [{ id: "C-139", title: "共享组件规范（合成）", status: "done" }],
      decisions: [],
      pull_requests: [],
    },
    work_items: base.work_items.map((w) => ({ ...w, card_id: id })),
    timeline: [
      timelineEntry({
        id: `${id}#1`,
        card_id: id,
        body: "固定合成评论，用于核对时间线入口和草稿保留。",
        created_at: now,
      }),
    ],
    counts: { timeline: 1, deliveries: 0, reviews: 0, open_decisions: 0 },
  };
});
const cards: CardListItem[] = details.map((d) => ({ ...card, ...d.card }));
const client = fakeClient({
  cards: async (_p, filter) => ({
    project_id: "p-1",
    cards,
    server_filtered: true,
    lanes: Object.fromEntries(
      states.map((status) => [status, { total: 1, next_cursor: null }]),
    ),
    filter,
    counts: { total: 3, needs_me: 0, agent: 2 },
  }),
  card: async (_p, id) => {
    const detail = details.find((d) => d.card.id === id);
    if (!detail) throw new Error("Unknown synthetic card");
    return detail;
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
