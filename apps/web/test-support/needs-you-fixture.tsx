// Synthetic Needs You screenshots (C-459); never imported by the product bundle.
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { NeedsDecision, NeedsPage } from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

Date.now = () => new Date(NOW).getTime();
const author = {
  employee: {
    id: "E-1",
    name: "示例开发",
    title: "开发工程师",
    avatar: null,
  },
  author_role: "coder",
  author_display: "示例开发",
};
const decision = (o: Partial<NeedsDecision>): NeedsDecision => ({
  ...author,
  id: "Q-1",
  question: "选择发布方式",
  context: "两种发布方式都可行，区别在于回滚成本。",
  why: "等待拍板",
  status: "open",
  blocking: true,
  decider: "human",
  card_id: "C-2",
  affected_cards: ["C-2"],
  options: [
    { key: "a", description: "灰度发布", impact: "先开放给一半项目" },
    { key: "b", description: "直接发布", impact: "全部项目同时生效" },
  ],
  recommended: "a",
  waited_ms: 25 * 60_000,
  trigger: null,
  category: "general",
  assignment_id: null,
  related_cards: [
    { id: "C-2", title: "核对卡片页工具栏、长标题与下一步负责人" },
  ],
  merge_confirmation: null,
  ...o,
});
const mergeView = (blockers: string[]) => ({
  blockers,
  completion: {
    id: "D-9",
    work_item_id: "W-1",
    summary: "全部验收通过",
    subject: { kind: "git_head" as const, value: "abcdef1234567890" },
  },
  deliveries: [
    {
      id: "D-8",
      work_item_id: "W-1",
      work_item_title: "前端开发",
      subject: { kind: "git_head" as const, value: "abcdef1234567890" },
      summary: "统一列表行与详情",
      ...author,
    },
  ],
  reviews: [
    {
      id: "V-1",
      delivery_id: "D-8",
      work_item_id: "W-2",
      work_item_title: "代码审核",
      role_id: "reviewer",
      kind: "code",
      verdict: "pass",
      target_sha: "abcdef1234567890",
      issues: [],
      ...author,
    },
  ],
  known_gaps: [],
});
const plain = {
  changed: "统一 Needs You 各标签页的列表行。",
  impact: "各标签页的主操作位置一致。",
  risk: "无",
};
const data = {
  decisions: [
    decision({}),
    decision({
      id: "Q-2",
      question: "是否把超时阈值从 10 分钟调到 15 分钟",
      blocking: false,
      waited_ms: 3 * 3_600_000,
      card_id: "C-3",
      related_cards: [{ id: "C-3", title: "示例任务 3" }],
    }),
    decision({
      id: "Q-3",
      question: "确认合并",
      trigger: "merge_confirmation",
      why: "确认合并",
      card_priority: 1,
      plain_summary: plain,
      merge_confirmation: mergeView([]),
      related_cards: [{ id: "C-4", title: "示例任务 4" }],
      card_id: "C-4",
    } as Partial<NeedsDecision>),
    decision({
      id: "Q-4",
      question: "确认合并",
      trigger: "merge_confirmation",
      why: "确认合并",
      card_priority: 2,
      plain_summary: plain,
      waited_ms: 90 * 60_000,
      merge_confirmation: mergeView(["代码审核尚未通过"]),
      related_cards: [{ id: "C-5", title: "示例任务 5" }],
      card_id: "C-5",
    } as Partial<NeedsDecision>),
  ],
  human_actions: [
    {
      ...author,
      id: "H-1",
      card_id: "C-6",
      why: "在外部后台创建测试账号",
      instructions: "登录后台，创建只读测试账号。",
      expected_return: "账号已创建",
      due: null,
      waited_ms: 40 * 60_000,
      blocked_work_items: [],
    },
  ],
  incidents: [],
  attention: [
    {
      kind: "review_limit_not_resumed",
      card_id: "C-7",
      work_item_id: "W-7",
      resolved_at: NOW,
      waited_ms: 15 * 60_000,
      detail: "审核加轮后没有恢复运行。",
    },
  ],
  later: [
    {
      kind: "human_action",
      id: "H-2",
      card_id: "C-6",
      title: "合并后在测试环境核对页面",
      waiting_for: "等 C-6 合并",
    },
    {
      kind: "decision",
      id: "Q-9",
      card_id: "C-3",
      title: "确认下一阶段范围",
      waiting_for: "等 C-3 有新交付",
    },
  ],
  notices: [
    {
      ...author,
      id: "N-1",
      kind: "merge",
      source: "auto_merge",
      card_id: "C-1",
      decision_id: "Q-7",
      question: "示例任务 1 已自动合并",
      option: "merge",
      resolved_by: "system",
      body: "检查和审核都通过，系统已合并。",
      proxy_authority: null,
      at: NOW,
      read: false,
    },
    {
      ...author,
      id: "N-2",
      kind: "decision",
      source: "pm",
      card_id: "C-2",
      decision_id: "Q-8",
      question: "PM 已代拍文案方案",
      option: "a",
      resolved_by: "pm",
      body: "按既有授权选择方案 A。",
      proxy_authority: "general",
      at: NOW,
      read: true,
    },
  ],
  notices_next_cursor: null,
} as unknown as NeedsPage;
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  needsYou: async () => data,
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App client={client} />);
