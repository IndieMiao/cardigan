import type { StoryProposal } from "@cardigan/domain";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import {
  ApiError,
  type CardDetail,
  type CardListItem,
  type CardStatus,
  type NeedsPage,
} from "../src/api.js";
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

// C-503: synthetic story cards only; no network client, database or real people.
// C-800 a story whose second proposal waits for confirmation (no children yet),
// C-810 the same proposal confirmed with three children, C-820 a finished story
// with its summary waiting for the human's completion, C-700 an ordinary card.
// `?fail=refused|stale` makes the next confirmation fail the way the server does.
Date.now = () => new Date(NOW).getTime();

const failure = new URLSearchParams(location.hash.split("?")[1] ?? "").get(
  "fail",
);

const plan = (
  version: number,
  confirmed?: readonly string[],
): StoryProposal => ({
  version,
  entry_id: `C-800#${10 + version}`,
  submitted_at: NOW,
  children: [
    {
      title: "导出数据接口",
      template_id: "dev",
      goal: "按当前筛选返回卡片编号、标题、状态、负责人和最近更新时间。",
      acceptance_criteria: ["只返回当前筛选的卡片", "中文字段不乱码"],
      depends_on: [],
      priority: 3,
      owner_role: "coder",
      repo: "example/repo",
      base_branch: "main",
    },
    {
      title: "导出按钮与下载",
      template_id: "ui",
      goal: "在看板工具栏旁提供导出按钮，下载 CSV 文件。",
      acceptance_criteria: ["按钮遵守界面规范", "下载失败原位提示"],
      depends_on: [1],
      priority: 2,
      owner_role: "frontend_engineer",
      state_and_save: "无写入",
    },
    {
      title: "帮助文档：导出报表",
      template_id: "general",
      goal: "在帮助页说明导出范围和字段。",
      acceptance_criteria: ["说明只导出当前筛选结果"],
      depends_on: [2],
      depends_on_cards: ["C-700"],
      priority: 1,
      owner_role: "pm",
    },
  ],
  ...(confirmed
    ? { confirmed: { at: NOW, entry_id: "C-800#30", card_ids: confirmed } }
    : {}),
});

type Child = [id: string, title: string, status: CardStatus];
const stories: Record<
  string,
  {
    title: string;
    status: CardStatus;
    children: Child[];
    proposals: StoryProposal[];
    summary?: string;
  }
> = {
  "C-800": {
    title: "需求：看板导出报表",
    status: "in_progress",
    children: [],
    proposals: [plan(1), plan(2)],
  },
  "C-810": {
    title: "需求：看板导出报表（已开卡）",
    status: "in_progress",
    children: [
      ["C-811", "导出数据接口", "in_progress"],
      ["C-812", "导出按钮与下载", "backlog"],
      ["C-813", "帮助文档：导出报表", "backlog"],
    ],
    proposals: [plan(1), plan(2, ["C-811", "C-812", "C-813"])],
  },
  "C-820": {
    title: "需求：卡片批量改优先级",
    status: "in_progress",
    children: [
      ["C-821", "批量选择", "done"],
      ["C-822", "批量修改接口", "done"],
      ["C-823", "帮助文档：批量修改", "cancelled"],
    ],
    proposals: [plan(1, ["C-821", "C-822", "C-823"])],
    summary:
      "三张子卡都已结束：批量选择和修改接口已合并，帮助文档并入其它卡后取消。对照原话：多选后一次改优先级已可用。",
  },
};
const counts = (children: Child[]) => {
  const result: Record<CardStatus, number> = {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    review: 0,
    awaiting_merge: 0,
    done: 0,
    cancelled: 0,
  };
  for (const [, , status] of children) result[status]++;
  return result;
};
const childRows = new Map<string, CardListItem>(
  Object.values(stories).flatMap((s) =>
    s.children.map(([id, title, status]) => [
      id,
      { ...card, id, title, status, waiting_on: [], why: "等待下一步处理" },
    ]),
  ),
);
function storyDetail(id: string): CardDetail {
  const s = stories[id];
  if (!s) throw new Error("fixture");
  return cardDetail({
    card: {
      ...card,
      id,
      title: s.title,
      status: s.status,
      template: "story",
      goal: "希望能把看板上当前筛选出来的卡片导出成表格，发给不用 Workbench 的同事看。",
      acceptance_criteria: [],
      waiting_on: [],
      why: "等待下一步处理",
      story: {
        discussion_rounds: 1,
        ...(s.summary ? { summary_entry_id: `${id}#9` } : {}),
        proposals: s.proposals,
      },
      story_progress: {
        children: s.children.map(([cid, title, status]) => ({
          id: cid,
          title,
          status,
        })),
        counts: counts(s.children),
        finished: s.children.filter((c) => ["done", "cancelled"].includes(c[2]))
          .length,
        total: s.children.length,
      },
    },
    work_items: [],
    deliveries: [],
    review_matrix: [],
    attachments: [],
    mark_done: { allowed: true, reason: null },
    timeline: [
      ...(s.summary
        ? [
            timelineEntry({
              id: `${id}#9`,
              card_id: id,
              event_seq: 9,
              author_display: "林黛玉",
              body: s.summary,
            }),
          ]
        : []),
      timelineEntry({ id: `${id}#1`, card_id: id, event_seq: 1 }),
    ],
    counts: {
      timeline: s.summary ? 2 : 1,
      deliveries: 0,
      reviews: 0,
      open_decisions: 0,
    },
  });
}
const ordinary = (): CardDetail =>
  cardDetail({
    card: {
      ...card,
      id: "C-700",
      title: "普通卡：统一事件格式",
      waiting_on: [],
      why: "等待下一步处理",
    },
  });
const listCards: CardListItem[] = [
  ...Object.entries(stories).map(([id, s]) => ({
    ...card,
    id,
    title: s.title,
    status: s.status,
    template: "story",
    waiting_on: [],
    why: "等待下一步处理",
  })),
  {
    ...card,
    id: "C-700",
    title: "普通卡：统一事件格式",
    waiting_on: [],
    why: "等待下一步处理",
  },
];
const needs: NeedsPage = {
  decisions: [],
  human_actions: [],
  incidents: [],
  story_proposals: [
    {
      card_id: "C-800",
      card_title: "需求：看板导出报表",
      version: 2,
      entry_id: "C-800#12",
      submitted_at: NOW,
      waited_ms: 25 * 60000,
      children: plan(2).children.map(({ title, template_id, owner_role }) => ({
        title,
        template_id,
        owner_role,
      })),
    },
  ],
};
const refuse = () => {
  if (failure === "stale")
    throw new ApiError(
      409,
      "stale_target",
      "拆解方案已更新到第 3 版，请刷新后再确认",
    );
  throw new ApiError(
    400,
    "validation_failed",
    "第 2 张子卡「导出按钮与下载」无法开出：模板不存在",
  );
};
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_project, filter, options) => {
    const ids = options?.ids?.split(",");
    const cards = ids
      ? ids.flatMap((id) => {
          const row = childRows.get(id);
          return row ? [row] : [];
        })
      : listCards;
    return {
      project_id: "p-1",
      filter,
      cards,
      counts: { total: cards.length, needs_me: 0, agent: cards.length },
    };
  },
  card: async (_project, id) => (id === "C-700" ? ordinary() : storyDetail(id)),
  needsYou: async () => needs,
  confirmStoryProposal: async () => refuse(),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
