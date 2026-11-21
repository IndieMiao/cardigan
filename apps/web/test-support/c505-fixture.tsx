import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  CardDetail,
  CardListItem,
  CardStatus,
  DependencyCard,
} from "../src/api.js";
import {
  attachment,
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

// C-505: synthetic story cards only; no network client, database or real people.
// C-600 a story with five children and sibling dependencies, C-610 an empty
// story, C-620 a long story of twelve children, C-640 a finished story with
// its summary, and C-700 an ordinary card with a dependency graph (regression).
Date.now = () => new Date(NOW).getTime();

type Child = [id: string, title: string, status: CardStatus, after?: string[]];
const stories: Record<
  string,
  {
    title: string;
    status: CardStatus;
    goal: string;
    criteria?: string[];
    children: Child[];
    files?: number;
    groups?: boolean;
    summary?: string;
  }
> = {
  "C-600": {
    title: "需求：看板导出报表",
    status: "in_progress",
    goal: "希望能把看板上当前筛选出来的卡片导出成表格，发给不用 Workbench 的同事看。\n\n导出要包含编号、标题、状态、负责人和最近更新时间；中文不能乱码。",
    criteria: ["导出的表格能用常见表格软件直接打开", "只导出当前筛选结果"],
    children: [
      ["C-601", "导出数据接口", "done"],
      ["C-602", "表格格式与编码", "in_progress", ["C-601"]],
      ["C-603", "导出按钮与下载", "todo", ["C-602"]],
      ["C-604", "导出权限校验", "review"],
      ["C-605", "帮助文档：导出报表", "backlog", ["C-603", "C-604"]],
    ],
    files: 2,
    groups: true,
  },
  "C-610": {
    title: "需求：通知静默时段",
    status: "backlog",
    goal: "晚上十点以后不要再推送飞书通知，第二天早上汇总一次。",
    children: [],
  },
  "C-620": {
    title: "需求：多项目工作台改版（长图）",
    status: "in_progress",
    goal: "把多项目切换、跨项目待办和统一搜索合并进同一个工作台。",
    children: Array.from({ length: 12 }, (_, i): Child => {
      const id = `C-${621 + i}`;
      const status: CardStatus =
        i < 3 ? "done" : i < 5 ? "in_progress" : i === 5 ? "review" : "todo";
      // Two parallel tracks joining at the end.
      const after =
        i === 0 || i === 1
          ? []
          : i === 11
            ? ["C-630", "C-631"]
            : [`C-${621 + i - 2}`];
      return [
        id,
        `改版第 ${i + 1} 步：${["项目切换", "跨项目待办", "统一搜索", "权限合并", "导航重排", "空态与加载"][i % 6]}`,
        status,
        after,
      ];
    }),
  },
  "C-640": {
    title: "需求：卡片批量改优先级",
    status: "review",
    goal: "在列表里多选卡片后一次改优先级。",
    children: [
      ["C-641", "批量选择", "done"],
      ["C-642", "批量修改接口", "done", ["C-641"]],
      ["C-643", "被取消的旧方案", "cancelled"],
    ],
    summary:
      "三张子卡都已结束：批量选择和修改接口已合并，旧方案取消。对照原话：多选后一次改优先级已可用，列表与看板都支持。",
  },
};
const childRows = new Map<string, CardListItem>();
for (const story of Object.values(stories))
  for (const [id, title, status, after = []] of story.children) {
    const siblings = new Map(story.children.map((c) => [c[0], c]));
    const node = (other: string): DependencyCard => {
      const c = siblings.get(other);
      return {
        id: other,
        title: c?.[1] ?? other,
        status: c?.[2] ?? "todo",
        satisfied: c?.[2] === "done",
      };
    };
    const before = after.map(node);
    const next = story.children
      .filter((c) => c[3]?.includes(id))
      .map((c) => node(c[0]));
    childRows.set(id, {
      ...card,
      id,
      title,
      status,
      waiting_on: [],
      why: "等待下一步处理",
      ...(status === "cancelled" ? { resolution: "wontdo" as const } : {}),
      ...(before.length || next.length
        ? {
            dependency: {
              predecessors: before,
              successors: next,
              waiting_on: before.filter((b) => !b.satisfied).map((b) => b.id),
              critical_path_length: 1,
            },
          }
        : {}),
    });
  }
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
const files = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    attachment({
      id: `F-${60 + i}`,
      mime: i ? "text/markdown" : "text/plain",
      inline: false,
      original_filename: i ? "导出字段说明.md" : "export-sample.csv",
      note: i ? "同事整理的字段说明" : "期望的导出样例",
      uploaded_by: "human",
      uploaded_at: NOW,
      basis: null,
      attach_to: { kind: "timeline_entry", id: "C-600#1" },
    }),
  );
function storyDetail(id: string): CardDetail {
  const s = stories[id];
  if (!s) throw new Error("fixture");
  const children = s.children.map(([cid, title, status]) => ({
    id: cid,
    title,
    status,
  }));
  return cardDetail({
    card: {
      ...card,
      id,
      title: s.title,
      status: s.status,
      template: "story",
      goal: s.goal,
      acceptance_criteria: s.criteria ?? [],
      waiting_on: [],
      why: "等待下一步处理",
      story: {
        discussion_rounds: s.groups ? 1 : 0,
        ...(s.summary ? { summary_entry_id: `${id}#9` } : {}),
        ...(s.groups
          ? {
              question_groups: [
                {
                  id: `${id}#3`,
                  questions: [
                    {
                      question: "导出格式用 CSV 还是 Excel？",
                      recommended: "CSV",
                      impact: "决定是否引入表格库",
                    },
                    {
                      question: "要不要包含已取消的卡片？",
                      recommended: "不包含",
                      impact: "影响导出行数",
                      resolution: {
                        source: "answer",
                        value: "不包含",
                        entry_id: `${id}#4`,
                      },
                    },
                  ],
                },
              ],
            }
          : {}),
      },
      story_progress: {
        children,
        counts: counts(s.children),
        finished: s.children.filter((c) => ["done", "cancelled"].includes(c[2]))
          .length,
        total: s.children.length,
      },
    },
    work_items: [],
    deliveries: [],
    review_matrix: [],
    attachments: files(s.files ?? 0),
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
      timelineEntry({
        id: `${id}#1`,
        card_id: id,
        event_seq: 1,
        author: "human",
        body: s.goal,
      }),
    ],
    counts: {
      timeline: s.summary ? 2 : 1,
      deliveries: 0,
      reviews: 0,
      open_decisions: 0,
    },
  });
}
const ordinary = (): CardDetail => {
  const nodes: DependencyCard[] = [
    { id: "C-701", title: "存储迁移脚本", status: "done", satisfied: true },
    {
      id: "C-700",
      title: "普通卡：统一事件格式",
      status: "in_progress",
      satisfied: false,
    },
    { id: "C-702", title: "读模型重建", status: "todo", satisfied: false },
    { id: "C-703", title: "回放报表", status: "backlog", satisfied: false },
  ];
  return cardDetail({
    card: {
      ...card,
      id: "C-700",
      title: "普通卡：统一事件格式",
      waiting_on: [],
      why: "等待下一步处理",
      dependency: {
        predecessors: [nodes[0] as DependencyCard],
        successors: [nodes[2] as DependencyCard, nodes[3] as DependencyCard],
        waiting_on: [],
        critical_path_length: 3,
        graph: {
          nodes,
          edges: [
            { from: "C-701", to: "C-700" },
            { from: "C-700", to: "C-702" },
            { from: "C-702", to: "C-703" },
          ],
        },
      },
    },
  });
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
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
