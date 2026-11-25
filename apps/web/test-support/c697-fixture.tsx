import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  CardDetail,
  CardListItem,
  NeedsDecision,
  TemplateView,
} from "../src/api.js";
import {
  card,
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-697: the merge confirmation in card details, in the four states of the
// card's acceptance (ready to merge, failed check, PM confirms, held), with
// the C-687 design's synthetic data. No backend, no production data. Fixed
// clock. Writes resolve after a pause so a capture can show them pending;
// `?fail=1` makes them fail with a server reason.
const now = "2026-11-24T08:00:00.000Z";
Date.now = () => Date.parse(now);
const failing = new URLSearchParams(location.search).has("fail");

const devTpl = {
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
} as TemplateView;

const base = cardDetail();
const entries = (id: string, n: number) =>
  Array.from({ length: n }, (_, i) =>
    timelineEntry({
      id: `${id}#${n - i}`,
      card_id: id,
      event_seq: n - i,
      body: i === 0 ? "已提交交付，等审核。" : `合成时间线条目 ${n - i}。`,
      author_display: i % 2 ? "张良" : "晴雯",
      created_at: now,
    }),
  );

const sha = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const merge = (
  id: string,
  cardId: string,
  title: string,
  over: Partial<NeedsDecision> = {},
  check: "passed" | "failed" = "passed",
): NeedsDecision =>
  ({
    id,
    question: "确认合并",
    context: "交付上下文原文：按负责人筛选的实现与测试说明。",
    why: "确认合并",
    status: "open",
    blocking: true,
    decider: "human",
    card_id: cardId,
    affected_cards: [],
    options: [
      { key: "merge", description: "合并已通过验收的交付", impact: "更新基线" },
      { key: "hold", description: "暂缓合并", impact: "等待" },
      { key: "request_changes", description: "退回修改", impact: "返工" },
    ],
    recommended: "merge",
    waited_ms: 3_600_000,
    trigger: "merge_confirmation",
    category: "general",
    assignment_id: "A-9",
    related_cards: [{ id: cardId, title }],
    plain_summary: {
      changed: "卡片列表加了按负责人筛选",
      impact: "列表多一个筛选控件，默认“全部”",
      risk: "无",
    },
    merge_confirmation: {
      blockers: check === "failed" ? ["合并检查：未通过"] : [],
      completion: {
        id: "D-912",
        work_item_id: `W-${cardId.slice(2)}1`,
        summary: "全部验收通过",
        subject: { kind: "git_head", value: sha },
      },
      deliveries: [
        {
          id: "D-911",
          work_item_id: `W-${cardId.slice(2)}1`,
          work_item_title: "开发",
          summary: "加负责人筛选，列表与看板共用。",
          subject: { kind: "git_head", value: sha },
          author_display: "李逵",
        },
      ],
      reviews: [
        {
          id: "V-913",
          delivery_id: "D-911",
          work_item_id: `W-${cardId.slice(2)}2`,
          work_item_title: "代码审核",
          role_id: "reviewer",
          kind: "code",
          verdict: "pass",
          target_sha: sha,
          issues: [],
          author_display: "王熙凤",
        },
      ],
      known_gaps: [],
      merge_gate_enabled: true,
      merge_check: {
        completion_id: "D-912",
        attempt_id: "attempt-912",
        candidate_sha: "b".repeat(40),
        tree_sha: "c".repeat(40),
        status: check,
        checks: [{ name: "test", status: check }],
        ...(check === "failed"
          ? { summary: "web 测试 2 项失败：CardListPage 筛选断言" }
          : {}),
        updated_at: now,
      },
    },
    ...over,
  }) as NeedsDecision;

const make = (
  id: string,
  title: string,
  q: NeedsDecision,
  over: Partial<CardDetail["card"]> = {},
): CardDetail => ({
  ...base,
  card: {
    ...card,
    id,
    title,
    status: "awaiting_merge",
    goal: "合并已验收的负责人筛选。",
    acceptance_criteria: ["合并检查通过", "所有者确认合并"],
    created_at: "2026-11-20T02:00:00.000Z",
    updated_at: now,
    why: "",
    next_owners:
      q.decider === "human"
        ? [{ kind: "human", ref: "human" }]
        : [{ kind: "role", ref: "pm" }],
    waiting_on:
      q.decider === "human"
        ? [{ kind: "decision", ref: q.id, label: `等你确认合并 ${q.id}` }]
        : [],
    risk_tags: [],
    related_cards: [],
    progress: { completed: 2, total: 2 },
    ...over,
  },
  template: devTpl,
  updated_at: now,
  merge_confirmations: [q],
  decisions: [q],
  deliveries: [],
  reviews: [],
  review_matrix: [],
  attachments: [],
  human_actions: [],
  recent_conclusions: [],
  relations: { cards: [], decisions: [], pull_requests: [] },
  work_items: [
    {
      ...base.work_items[0],
      id: `W-${id.slice(2)}1`,
      card_id: id,
      title: "开发",
      role_id: "coder",
      status: "accepted",
    },
    {
      ...base.work_items[1],
      id: `W-${id.slice(2)}2`,
      card_id: id,
      title: "代码审核",
      role_id: "reviewer",
      status: "passed",
    },
  ] as CardDetail["work_items"],
  timeline: entries(id, 6),
  counts: { timeline: 6, deliveries: 1, reviews: 1, open_decisions: 1 },
});

const details: CardDetail[] = [
  make(
    "C-702",
    "列表按负责人筛选：合并",
    merge("Q-902", "C-702", "列表按负责人筛选：合并"),
  ),
  make(
    "C-706",
    "看板导出：合并",
    merge("Q-906", "C-706", "看板导出：合并", {}, "failed"),
  ),
  make(
    "C-707",
    "侧栏加设置入口：合并",
    merge("Q-907", "C-707", "侧栏加设置入口：合并", { decider: "role:pm" }),
  ),
  make(
    "C-708",
    "时间线筛选：合并",
    merge("Q-908", "C-708", "时间线筛选：合并", {
      status: "snoozed",
      snooze: {
        reason: "等周会后再合并",
        until: "2026-11-24T09:30:00.000Z",
        at: now,
        by: "human",
      },
    }),
  ),
];
const cards: CardListItem[] = details.map((d) => ({ ...card, ...d.card }));
const write = () =>
  new Promise<void>((resolve, reject) =>
    setTimeout(
      () =>
        failing ? reject(new Error("合并确认已更新，请刷新后重试")) : resolve(),
      600,
    ),
  );
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
    counts: { total: cards.length, needs_me: 3, agent: 0 },
  }),
  card: async (_p, id) => {
    const detail = details.find((d) => d.card.id === id);
    if (!detail) throw new Error("Unknown synthetic card");
    return detail;
  },
  recordDecision: write,
  recheckMerge: write,
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
