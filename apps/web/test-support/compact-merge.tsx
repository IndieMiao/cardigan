import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { NeedsDecision } from "../src/api.js";
import { cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

// Local rendering only. Q-337 prose is the historical excerpt in C-205#9;
// check names, delivery IDs and other scenarios are illustrative fixtures.
Date.now = () => Date.parse(NOW);
const scenario =
  new URLSearchParams(location.search).get("scenario") ?? "ready";
const title =
  "P2a-14 ⑧ 跟进：灰度开关 enable_reviewer_browser 接入界面卡代确认判定";
const summary =
  "孙悟空：按已确认方案把开关接上界面卡代确认。代码审核和独立复核已通过，角色正文改动需要人确认后合并。";
const q: NeedsDecision = {
  id: "Q-337",
  card_id: "C-199",
  affected_cards: [],
  related_cards: [{ id: "C-199", title }],
  question: "将 C-199 合并到 main？",
  context: "合并后还需升级 PM、独立复核员两个角色。具体命令在原交付说明中。",
  why: "等你确认",
  status: scenario === "pm" ? "snoozed" : "open",
  blocking: true,
  decider: scenario === "pm" ? "role:pm" : "human",
  category: "general",
  trigger: "merge_confirmation",
  assignment_id: null,
  waited_ms: 0,
  author_display: "孙悟空",
  author_role: "coder",
  options: [
    { key: "merge", description: "合并", impact: "更新基线" },
    { key: "hold", description: "暂缓", impact: "等待" },
    { key: "request_changes", description: "退回修改", impact: "返工" },
  ],
  recommended: "merge",
  suggestion: {
    option: "merge",
    rationale: "合并检查、代码审核、独立复核和 PM 验收均通过",
    stale: false,
    at: NOW,
    by: "assignment:A-1",
  },
  plain_summary: {
    changed: "开了截图核对开关后，界面卡的截图核对只能由独立复核员给结论",
    impact: "开关默认关着，现在行为不变",
    risk: "改了 PM 和独立复核员的角色规则，须由你亲自确认",
  },
  ...(scenario === "pm"
    ? {
        snooze: {
          until: "2026-11-13T10:21:00Z",
          at: NOW,
          by: "assignment:A-2",
          reason: "等截图核对通过后交人确认，不由我代确认",
        },
      }
    : {}),
  merge_confirmation: {
    completion: {
      id: "D-1",
      work_item_id: "W-1",
      summary,
      subject: { kind: "git_head", value: "a".repeat(40) },
    },
    deliveries: [
      {
        id: "D-1",
        work_item_id: "W-1",
        work_item_title: "开发",
        summary,
        subject: { kind: "git_head", value: "a".repeat(40) },
        author_display: "孙悟空",
      },
    ],
    reviews: ["代码审核", "独立复核", "PM 验收"].map((work_item_title, i) => ({
      id: `V-${i + 1}`,
      work_item_id: `W-${i + 2}`,
      delivery_id: "D-1",
      work_item_title,
      role_id: null,
      kind: "code",
      verdict: "pass",
      target_sha: "a".repeat(40),
      issues: [],
    })),
    known_gaps:
      scenario === "zero"
        ? []
        : [{ description: "合并后：升级 PM、独立复核员两个角色" }],
    pre_merge_checks: [
      {
        label: "截图核对",
        status: "passed",
        note: "宽屏、窄屏、暗色已核对",
        updated_at: NOW,
      },
    ],
    merge_gate_enabled: true,
    merge_check: {
      attempt_id: "00000000-0000-4000-8000-000000000001",
      completion_id: "D-1",
      status: scenario === "failed" ? "failed" : "passed",
      checks: ["类型检查", "组件测试", "构建"].map((name) => ({
        name,
        status: "passed",
        duration_ms: 1000,
      })),
      updated_at: NOW,
      ...(scenario === "failed"
        ? { summary: "示意失败：组件断言需要修复" }
        : {}),
    },
  },
};
// C-271: identical synthetic facts for both pages and both code versions.
if (scenario.startsWith("premerge-")) {
  const status = scenario.slice("premerge-".length);
  const merge = q.merge_confirmation;
  if (!merge?.merge_check) throw new Error("Missing merge fixture");
  q.merge_confirmation = {
    ...merge,
    blockers:
      status === "passed"
        ? []
        : [
            `合并检查：${status === "missing" ? "尚无结果" : status === "queued" ? "排队中" : "运行中"}`,
            "截图核对：待核",
            "独立复核（W-3）：未通过当前交付审核",
          ],
    pre_merge_checks:
      status === "passed"
        ? merge.pre_merge_checks
        : [{ label: "截图核对", status: "pending", updated_at: NOW }],
    ...(status === "missing"
      ? {}
      : {
          merge_check: {
            ...merge.merge_check,
            status: status as "queued" | "running" | "passed",
          },
        }),
  };
  if (status === "missing") delete q.merge_confirmation.merge_check;
}
if (scenario === "legacy")
  delete (q as { plain_summary?: unknown }).plain_summary;
if (scenario === "unknown")
  delete (q.merge_confirmation as { known_gaps?: unknown }).known_gaps;
const noMerge = ["review", "blocked"].includes(scenario);
const base = cardDetail();
const detail = cardDetail({
  card: {
    ...base.card,
    id: "C-199",
    title,
    goal: "压缩拍板信息层级，让关键风险、状态与下一步清楚可见。",
    status: noMerge ? "review" : "awaiting_merge",
    waiting_on: noMerge
      ? [
          {
            kind: scenario === "review" ? "review" : "human_action",
            ref: scenario === "review" ? "W-2" : "H-1",
            label:
              scenario === "review"
                ? "等设计审核"
                : "缺少窄屏截图，设计审核暂不能继续",
          },
        ]
      : [],
    next_owners: [
      {
        kind: scenario === "review" ? "role" : "human",
        ref: scenario === "review" ? "design_director" : "human",
      },
    ],
  },
  merge_confirmations: noMerge ? [] : [q],
  decisions: [],
  attachments: [],
  relations: { decisions: [], cards: [], pull_requests: [] },
  timeline: [],
  counts: {
    timeline: 0,
    deliveries: 0,
    reviews: 0,
    open_decisions: noMerge ? 0 : 1,
  },
});
const client = fakeClient({
  card: async () => detail,
  needsYou: async () => ({ decisions: [q], human_actions: [], incidents: [] }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
