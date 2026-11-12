import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { NeedsDecision } from "../src/api.js";
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
import "../src/styles.css";

// Keep relative times stable while comparing the same DOM under two stylesheets.
Date.now = () => new Date(NOW).getTime();
history.scrollRestoration = "manual";
const sample = { ...card, title: "发布前检查与工作台窄屏布局核对" };
const decision: NeedsDecision = {
  id: "Q-1",
  question: "是否继续安排发布前的检查？",
  context: "主要功能已经完成，需要核对交付记录和页面截图。",
  why: "需要确认下一步安排",
  status: "open",
  blocking: true,
  decider: "human",
  card_id: card.id,
  affected_cards: [card.id],
  options: [
    { key: "go", description: "继续检查", impact: "安排审核并核对页面截图" },
    { key: "hold", description: "暂缓", impact: "保留当前工作进度" },
  ],
  recommended: "go",
  waited_ms: 120000,
  trigger: null,
  category: "general",
  assignment_id: null,
  related_cards: [{ id: sample.id, title: sample.title }],
  merge_confirmation: null,
};
const client = fakeClient({
  ...(new URLSearchParams(location.search).has("capacity")
    ? {
        executionCapacity: async () => ({
          agents: [
            {
              machine_id: "local",
              label: "local",
              running: 5,
              limit: 6,
              max_limit: 16,
              queued: 2,
              merge_check_slots: 0,
            },
          ],
          merge_checks: [
            { machine_id: "test-ci", running: 1, limit: 3, queued: 4 },
          ],
          merge_config_invalid: false,
        }),
      }
    : {}),
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    return () => {};
  },
  card: async (_project, _card, query) =>
    cardDetail({
      card: sample,
      attachments: [],
      counts: { timeline: 25, deliveries: 1, reviews: 0, open_decisions: 0 },
      timeline: Array.from(
        { length: Math.min(query?.limit ?? 20, 25) },
        (_, i) =>
          timelineEntry({
            id: `C-1#${25 - i}`,
            event_seq: 25 - i,
            author_role: "coder",
            body: `第 ${25 - i} 条：已完成页面布局核对，请检查亮暗主题下的长标题和交付信息。`,
          }),
      ),
    }),
  needsYou: async () => ({
    decisions: [decision],
    human_actions: [],
    incidents: [],
  }),
  decisionHistory: async () => ({
    decisions: [
      {
        ...decision,
        card_id: card.id,
        status: "resolved",
        decision_maker: "pm",
        resolution: {
          option: "go",
          rationale: "符合当前安排，继续核对交付证据。",
          raw_quote: "继续检查",
          at: NOW,
          resolved_by: "assignment:A-2",
          via: "delegated",
          proxy_authority: "project:p-1/default-decision-delegation/general",
        },
      },
    ],
  }),
  execution: async () => ({
    assignments: [
      {
        id: "A-1",
        role_id: "coder",
        role_version: 1,
        status: "active",
        runtime_state: "running",
        machine_id: "test",
        standing_mode: null,
        card_id: card.id,
        card_status: card.status,
        work_item_id: "W-1",
        worktree_path: null,
        branch: null,
        session_ref: null,
        runtime_ref: { terminal_ref: "test-terminal", runtime_machine: "test" },
        last_mcp_activity_at: null,
        cursors: [],
      },
    ],
    runs: [
      {
        id: "R-1",
        assignment_id: "A-1",
        status: "running",
        kind: "initial",
        model: "test-model",
        role_version: 1,
        agent_cli_version: "1.0",
        summary: "正在核对工作台各页窄屏布局",
        started_at: NOW,
      },
    ],
    machines: [],
  }),
  snapshot: async () => ({
    cards: [sample],
    in_progress: [sample],
    in_review: [],
    waiting: { human: [card.id], agent: [] },
    blocked: [],
    recent_deliveries: [
      {
        id: "D-1",
        card_id: card.id,
        work_item_id: "W-1",
        work_item_title: "开发与测试",
        summary: "完成页面布局与发布前检查，附测试结果及亮暗截图。",
        status: "submitted",
        submitted_at: NOW,
      },
    ],
  }),
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing test root");
createRoot(root).render(<App client={client} />);
