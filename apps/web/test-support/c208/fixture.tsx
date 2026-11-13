import { createRoot } from "react-dom/client";
import { App } from "../../src/App.js";
import type { NeedsDecision } from "../../src/api.js";
import {
  card,
  cardDetail,
  fakeClient,
  NOW,
  timelineEntry,
} from "../../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../../src/styles.css";
import "./palette.css";

document.documentElement.dataset.c208 =
  new URLSearchParams(location.search).get("palette") === "before"
    ? "before"
    : "after";

// Keep relative times stable while comparing the same DOM under two stylesheets.
Date.now = () => new Date(NOW).getTime();
history.scrollRestoration = "manual";
const sample = {
  ...card,
  title: "暗色主题与编号标签联合核对",
  goal: "用中性深灰区分内容层次，让状态和重点信息更清楚。",
  acceptance_criteria: [
    "五个页面的暗色背景均为中性灰",
    "状态文字与编号标签保持清晰可读",
  ],
  priority: 3,
};
const samples = [
  sample,
  ...["todo", "review", "done"].map((status, i) => ({
    ...sample,
    id: `C-${i + 2}`,
    title: ["补充页面设计说明", "复核状态与标签配色", "确认交付证据"][i],
    status,
    priority: i + 1,
    waiting_on: [],
    why: "按当前验收标准推进",
    progress: { completed: i, total: 3 },
  })),
];
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
      timeline: Array.from({ length: 3 }, (_, i) =>
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
    incident_handling: {
      host_ops: {
        assignment_id: "A-90",
        name: "张良",
        mention: "张良",
        patrol_interval_ms: 30 * 60_000,
      },
      pm_office: { assignment_id: "A-91", name: null, mention: "A-91" },
      hc_session: "cardigan",
    },
    incidents: [
      {
        id: "A-3",
        role_id: "coder",
        runtime_state: "lost",
        waited_ms: 12 * 60_000,
        card_id: card.id,
        disconnected_at: "2026-01-01T00:00:00.000Z",
        lost_at: null,
        last_run: null,
        author: "assignment:A-3",
        author_role: "coder",
        author_display: "未命名的 coder",
        employee: null,
        member: null,
      },
    ],
  }),
  cards: async (_project, filter) => ({
    project_id: "p-1",
    filter,
    cards: samples,
    counts: { total: 4, needs_me: 1, agent: 3 },
  }),
  activity: async () => ({
    cards: samples.map(({ id, title }) => ({ id, title })),
    events: [
      "delivery_submitted",
      "review_submitted",
      "comment_posted",
      "decision_requested",
      "run_started",
      "card_created",
    ].map((type, i) => ({
      id: `event-${i}`,
      card_id: samples[i % 4].id,
      card_title: samples[i % 4].title,
      seq: 12 - i,
      type,
      role: i % 2 ? "reviewer" : "coder",
      created_at: NOW,
      payload: {
        card_id: samples[i % 4].id,
        summary: "本地示例数据，仅用于设计核对",
      },
      actor: { kind: "assignment", assignment_id: `A-${i + 1}` },
      author_display: i % 2 ? "示例审核员" : "示例设计师",
    })),
    next_before: null,
    counts: { returned: 6, matched: 6 },
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
      // C-159: every other runtime / Assignment status in the same column.
      ...(
        [
          ["not_provisioned", "active"],
          ["provisioning", "active"],
          ["idle", "suspended"],
          ["unknown", "active"],
          ["lost", "active"],
          ["released", "released"],
        ] as const
      ).map(([runtime_state, status], i) => ({
        id: `A-${i + 430}`,
        role_id: "coder",
        role_version: 1,
        status,
        runtime_state,
        machine_id: "test",
        standing_mode: null,
        card_id: card.id,
        card_status: card.status,
        work_item_id: `W-${i + 472}`,
        worktree_path: null,
        branch: null,
        session_ref: null,
        runtime_ref: null,
        last_mcp_activity_at: null,
        cursors: [],
      })),
    ],
    runs: [
      {
        id: "R-1",
        assignment_id: "A-1",
        status: "running",
        kind: "initial",
        model: "gpt-6.1-sol",
        harness: "codex",
        effort: "xhigh",
        context_usage: { used_ratio: 0.9, window_tokens: 1000000 },
        role_version: 1,
        agent_cli_version: "1.0",
        summary: "正在核对工作台各页窄屏布局",
        started_at: NOW,
      },
    ],
    machines: [],
  }),
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing test root");
createRoot(root).render(<App client={client} />);

// Design-only candidate for C-204: decorate the existing IdTag, no component edits.
const kinds: Record<string, string> = {
  C: "card",
  W: "work-item",
  Q: "decision",
  A: "assignment",
  R: "run",
  D: "delivery",
  V: "review",
  H: "human-action",
  E: "employee",
  M: "member",
  MB: "merge-batch",
};
const decorate = () =>
  document.querySelectorAll<HTMLElement>(".id-tag").forEach((el) => {
    const prefix = el.textContent?.trim().match(/^([A-Z]+)-/)?.[1] ?? "";
    el.dataset.idKind = kinds[prefix] ?? "unknown";
  });
new MutationObserver(decorate).observe(document.getElementById("root")!, {
  childList: true,
  subtree: true,
});
