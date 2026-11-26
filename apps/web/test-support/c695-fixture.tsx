import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  CardDetail,
  CardListItem,
  NeedsDecision,
  TemplateView,
} from "../src/api.js";
import {
  attachment,
  card,
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-695: the five card states of the C-687 design (dev in progress, awaiting
// merge, general card waiting for you, story card, open decision) with the
// design's synthetic data. No backend, no production data. Fixed clock.
const now = "2026-11-24T08:00:00.000Z";
Date.now = () => Date.parse(now);

const tpl = (over: Partial<TemplateView>): TemplateView =>
  ({
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
    ...over,
  }) as TemplateView;
const devTpl = tpl({});
const generalTpl = tpl({
  id: "general",
  title: "通用任务",
  version: 1,
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  primary_work_item_key: null,
  completion: { mode: "human_mark_done" },
});
const storyTpl = tpl({
  ...generalTpl,
  id: "story",
  story: true,
  title: "需求卡",
});

const base = cardDetail();
// C-701: `?long` gives every card a timeline long enough to scroll.
const timelineLength = new URLSearchParams(location.search).has("long")
  ? 40
  : 6;
const entries = (id: string, n: number) =>
  Array.from({ length: n }, (_, i) =>
    timelineEntry({
      id: `${id}#${n - i}`,
      card_id: id,
      event_seq: n - i,
      body:
        i === 0
          ? "已提交交付，等审核。"
          : `合成时间线条目 ${n - i}：进度说明与讨论。`,
      author_display: i % 2 ? "张良" : "晴雯",
      created_at: now,
    }),
  );

const decision = (over: Partial<NeedsDecision>): NeedsDecision =>
  ({
    id: "Q-901",
    question: "设置页入口放在侧栏底部还是顶部？",
    context: "两种做法都可以，影响老用户习惯。",
    why: "等你拍板",
    status: "open",
    blocking: true,
    decider: "human",
    card_id: "C-705",
    affected_cards: [],
    options: [
      { key: "bottom", description: "侧栏底部", impact: "与现有习惯一致" },
      { key: "top", description: "侧栏顶部", impact: "更显眼，老用户要适应" },
    ],
    recommended: "bottom",
    waited_ms: 3_600_000,
    trigger: null,
    category: "feature_detail",
    assignment_id: "A-9",
    related_cards: [],
    plain_summary: {
      changed: "设置入口位置二选一",
      impact: "影响所有人找设置的路径",
      risk: "无",
    },
    suggestion: {
      version: 1,
      option: "bottom",
      rationale: "与现有习惯一致，改动最小",
      by: "assignment:A-9",
      at: now,
      stale: false,
    },
    merge_confirmation: null,
    ...over,
  }) as NeedsDecision;

const mergeQ = decision({
  id: "Q-902",
  question: "确认合并",
  context: "",
  why: "确认合并",
  card_id: "C-702",
  trigger: "merge_confirmation",
  category: "general",
  options: [
    { key: "merge", description: "合并已通过验收的交付", impact: "更新基线" },
    { key: "hold", description: "暂缓合并", impact: "等待" },
    { key: "request_changes", description: "退回修改", impact: "返工" },
  ],
  recommended: "merge",
  suggestion: undefined,
  plain_summary: {
    changed: "卡片列表加了按负责人筛选",
    impact: "列表多一个筛选控件，默认“全部”",
    risk: "无",
  },
  related_cards: [{ id: "C-702", title: "列表按负责人筛选" }],
  merge_confirmation: {
    blockers: [],
    completion: {
      id: "V-912",
      work_item_id: "W-921",
      summary: "全部验收通过",
      subject: {
        kind: "git_head",
        value: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
      },
    },
    deliveries: [],
    reviews: [],
    known_gaps: [],
    merge_gate_enabled: true,
    merge_check: {
      completion_id: "V-912",
      attempt_id: "attempt-912",
      candidate_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
      status: "passed",
      checks: [{ name: "test", status: "passed" }],
      summary: "全部通过",
      updated_at: now,
    },
  },
} as Partial<NeedsDecision>);

const workItems = (id: string, coder: string, review: string) => [
  {
    ...base.work_items[0],
    id: `W-${id}1`,
    card_id: `C-${id}`,
    title: "开发",
    role_id: "coder",
    status: coder,
  },
  {
    ...base.work_items[1],
    id: `W-${id}2`,
    card_id: `C-${id}`,
    title: "代码审核",
    role_id: "reviewer",
    status: review,
  },
];

const make = (
  id: string,
  over: Partial<CardDetail["card"]>,
  extra: Partial<CardDetail> = {},
): CardDetail => ({
  ...base,
  card: {
    ...card,
    id,
    created_at: "2026-11-20T02:00:00.000Z",
    updated_at: now,
    why: "",
    waiting_on: [],
    risk_tags: [],
    related_cards: [],
    ...over,
  },
  template: devTpl,
  updated_at: now,
  merge_confirmations: [],
  decisions: [],
  deliveries: [],
  reviews: [],
  review_matrix: [],
  attachments: [],
  human_actions: [],
  recent_conclusions: [],
  relations: { cards: [], decisions: [], pull_requests: [] },
  work_items: workItems(
    id.slice(2),
    "in_progress",
    "todo",
  ) as CardDetail["work_items"],
  timeline: entries(id, timelineLength),
  counts: {
    timeline: timelineLength,
    deliveries: 1,
    reviews: 0,
    open_decisions: 0,
  },
  ...extra,
});

const evidence = Array.from({ length: 14 }, (_, i) =>
  attachment({
    id: `F-${1201 + i}`,
    original_filename: `现场照片-${String(i + 1).padStart(2, "0")}.png`,
    download_path: `/api/projects/p-1/attachments/F-${1201 + i}`,
    thumbnail_path: undefined,
    inline: false,
  } as never),
);

const details: CardDetail[] = [
  make("C-701", {
    title: "卡片列表支持按负责人筛选",
    status: "in_progress",
    goal: "在卡片列表工具栏加“负责人”筛选，默认全部。",
    acceptance_criteria: [
      "工具栏出现“负责人：全部”筛选",
      "选中后只显示该负责人的卡",
      "窄屏不横向溢出",
    ],
    next_owners: [{ kind: "role", ref: "coder", author_display: "李逵" }],
    priority: 2,
    progress: { completed: 0, total: 2 },
  }),
  make(
    "C-702",
    {
      title: "列表按负责人筛选：合并",
      status: "awaiting_merge",
      goal: "合并已验收的负责人筛选。",
      acceptance_criteria: ["合并检查通过", "所有者确认合并"],
      next_owners: [{ kind: "human", ref: "human" }],
      waiting_on: [
        { kind: "decision", ref: "Q-902", label: "等你确认合并 Q-902" },
      ],
      progress: { completed: 2, total: 2 },
    },
    {
      decisions: [mergeQ],
      merge_confirmations: [mergeQ],
      work_items: workItems(
        "702",
        "accepted",
        "passed",
      ) as CardDetail["work_items"],
    },
  ),
  make(
    "C-48",
    {
      title: "现场勘查：三号仓库货架承重复核",
      status: "in_progress",
      goal: "到三号仓库现场复核货架承重标签，拍照记录，并写明是否需要更换。",
      acceptance_criteria: [],
      next_owners: [{ kind: "human", ref: "human" }],
      waiting_on: [
        { kind: "human_action", ref: "H-50", label: "等你执行 H-50" },
      ],
      progress: { completed: 0, total: 0 },
      dependency: {
        predecessors: [
          {
            id: "C-55",
            title: "现场勘查：仓库平面图更新",
            status: "done",
            satisfied: true,
          },
        ],
        successors: [
          {
            id: "C-43",
            title: "货架更换采购单",
            status: "review",
            satisfied: false,
          },
        ],
        waiting_on: [],
        critical_path_length: 3,
        graph: {
          nodes: [
            {
              id: "C-55",
              title: "现场勘查：仓库平面图更新",
              status: "done",
              satisfied: true,
            },
            {
              id: "C-48",
              title: "现场勘查：三号仓库货架承重复核",
              status: "in_progress",
              satisfied: false,
            },
            {
              id: "C-43",
              title: "货架更换采购单",
              status: "review",
              satisfied: false,
            },
            {
              id: "C-40",
              title: "更换施工排期",
              status: "todo",
              satisfied: false,
            },
            {
              id: "C-41",
              title: "安全培训通知",
              status: "todo",
              satisfied: false,
            },
          ],
          edges: [
            { from: "C-55", to: "C-48" },
            { from: "C-48", to: "C-43" },
            { from: "C-43", to: "C-40" },
            { from: "C-43", to: "C-41" },
          ],
        },
      },
    },
    {
      template: generalTpl,
      mark_done: { allowed: true, reason: null },
      work_items: [],
      attachments: evidence,
      counts: {
        timeline: timelineLength,
        deliveries: 0,
        reviews: 0,
        open_decisions: 0,
      },
    },
  ),
  make(
    "C-704",
    {
      title: "需求：看板导出成表格",
      status: "in_progress",
      goal: "希望能把看板导出成表格，方便周会。",
      acceptance_criteria: [],
      next_owners: [{ kind: "human", ref: "human" }],
      story: {
        discussion_rounds: 1,
        question_groups: [
          {
            id: "C-704#3",
            questions: [
              {
                question: "导出格式？",
                recommended: "CSV",
                impact: "决定依赖",
              },
              {
                question: "导出范围？",
                recommended: "当前筛选",
                impact: "数据量",
              },
            ],
          },
        ],
      },
      story_progress: {
        children: [
          { id: "C-711", title: "导出数据模型", status: "done" },
          { id: "C-712", title: "导出接口", status: "in_progress" },
          { id: "C-713", title: "导出按钮", status: "todo" },
        ],
        counts: {
          backlog: 0,
          todo: 1,
          in_progress: 1,
          review: 0,
          awaiting_merge: 0,
          done: 1,
          cancelled: 0,
        },
        finished: 1,
        total: 3,
      },
    } as Partial<CardDetail["card"]>,
    {
      template: storyTpl,
      mark_done: { allowed: false, reason: "子卡未全部结束" },
      work_items: [],
    },
  ),
  make(
    "C-705",
    {
      title: "侧栏加设置入口",
      status: "in_progress",
      goal: "侧栏加设置入口，位置待拍板。",
      acceptance_criteria: ["入口可见", "键盘可达"],
      next_owners: [
        { kind: "human", ref: "human" },
        { kind: "role", ref: "coder", author_display: "李逵" },
      ],
      waiting_on: [{ kind: "decision", ref: "Q-901", label: "等你拍板 Q-901" }],
    },
    { decisions: [decision({})] },
  ),
];
const cards: CardListItem[] = details.map((d) => ({ ...card, ...d.card }));
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  cards: async (_p, filter) => ({
    project_id: "p-1",
    cards,
    server_filtered: true,
    lanes: {},
    filter,
    counts: { total: cards.length, needs_me: 4, agent: 1 },
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
