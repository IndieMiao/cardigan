import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { NeedsDecision } from "../src/api.js";
import {
  cardDetail,
  fakeClient,
  NOW,
  timelineEntry,
} from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

// Local screenshot data only; no business service or database is used.
Date.now = () => new Date(NOW).getTime();
if (!location.hash) location.hash = "#/p/p-1/needs-you";
const cards = [
  { id: "C-1", title: "所属卡片", status: "in_progress" },
  {
    id: "C-2",
    title: "这个受影响卡片的标题很长，需要缩略但保留编号和当前状态",
    status: "review",
  },
  { id: "C-3", title: "已完成的相关工作", status: "done" },
  { id: "C-4", title: "等待后续实施", status: "todo" },
];
const q: NeedsDecision = {
  id: "Q-1",
  card_id: "C-1",
  affected_cards: cards.map((c) => c.id),
  affected_card_views: cards,
  related_cards: cards,
  question: "是否按此方案更新涉及的卡片？",
  context: "核对影响范围后选择方案。",
  why: "需要确认影响范围",
  status: "open",
  blocking: false,
  decider: "human",
  options: [{ key: "yes", description: "继续", impact: "更新关联工作" }],
  recommended: "yes",
  waited_ms: 120000,
  trigger: null,
  category: "general",
  assignment_id: null,
  merge_confirmation: null,
};
const failed: NeedsDecision = {
  ...q,
  id: "Q-2",
  trigger: "merge_confirmation",
  options: [{ key: "merge", description: "合并", impact: "更新基线" }],
  merge_confirmation: {
    completion: {
      id: "D-1",
      work_item_id: "W-1",
      summary: "检查失败的合并确认",
      subject: { kind: "git_head", value: "a".repeat(40) },
    },
    deliveries: [],
    reviews: [],
    known_gaps: [],
    merge_gate_enabled: true,
    merge_check: {
      status: "failed",
      attempt_id: "a-1",
      completion_id: "D-1",
      checks: [],
      updated_at: NOW,
    },
  },
};
const client = fakeClient({
  needsYou: async () => ({
    decisions: [
      failed,
      q,
      {
        ...q,
        id: "Q-3",
        question: "空影响列表：不增加影响行",
        affected_cards: [],
        affected_card_views: [],
      },
      {
        ...q,
        id: "Q-4",
        question: "仅所属卡片：不增加影响行",
        affected_cards: ["C-1"],
        affected_card_views: cards.slice(0, 1),
      },
    ],
    human_actions: [],
    incidents: [],
  }),
  card: async (_projectId, id) =>
    cardDetail({
      card: {
        ...cardDetail().card,
        id,
        title: cards.find((c) => c.id === id)?.title ?? id,
      },
      decisions: [q],
      attachments: [],
      merge_confirmations: [failed],
      relations: { decisions: [q], cards: [], pull_requests: [] },
      timeline: [
        timelineEntry({
          id: `${id}#2`,
          card_id: id,
          event_seq: 2,
          type: "decision_resolved",
          decision_id: q.id,
          decision_option: "yes",
          body: "按此方案继续。",
        }),
        timelineEntry({
          id: `${id}#1`,
          card_id: id,
          event_seq: 1,
          type: "decision_request",
          decision_id: q.id,
        }),
      ],
    }),
});
const root = document.getElementById("root");
if (root) createRoot(root).render(<App client={client} />);
