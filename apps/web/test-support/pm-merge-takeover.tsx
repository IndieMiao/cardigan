import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { CardiganClient, NeedsDecision } from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "../src/styles.css";

// Fixed seed c312-takeover-v1: one in-memory card/decision, zero events.
// Non-production scale; only local rendering and simulated write feedback.
const waiting = new URLSearchParams(location.search).has("waiting");
const title = `合成示例：优化多设备审阅确认与等待提示，保留现有处理流程 ${"LongTitle".repeat(8)}`;
const decision: NeedsDecision = {
  id: "Q-1",
  card_id: "C-1",
  affected_cards: [],
  related_cards: [{ id: "C-1", title }],
  question: "确认合并合成示例？",
  context: "仅用于界面验收，不连接业务服务。",
  why: "PM 处理中",
  status: "open",
  blocking: false,
  decider: "role:pm",
  category: "general",
  trigger: "merge_confirmation",
  assignment_id: null,
  waited_ms: 0,
  options: [],
  recommended: "merge",
  plain_summary: {
    changed: "优化确认提示",
    impact: "接手前多一次确认",
    risk: "无",
  },
  merge_confirmation: {
    completion: {
      id: "D-1",
      work_item_id: "W-1",
      summary: "合成完成申请",
      subject: { kind: "git_head", value: "a".repeat(40) },
    },
    deliveries: [],
    reviews: [],
    known_gaps: [],
    merge_gate_enabled: true,
    blockers: waiting ? ["合并检查：运行中"] : [],
    merge_check: {
      attempt_id: "synthetic-check",
      completion_id: "D-1",
      status: waiting ? "running" : "passed",
      checks: [],
      updated_at: NOW,
    },
  },
};
const fixture = {
  calls: [] as Parameters<CardiganClient["recordDecision"]>[],
  finish: (_success: boolean) => {},
};
Object.assign(window, { takeoverFixture: fixture });
const client = fakeClient({
  needsYou: async () => ({
    decisions: [],
    pm_held_merges: [decision],
    human_actions: [],
    incidents: [],
  }),
  recordDecision: (...args) => {
    fixture.calls.push(args);
    return new Promise<void>((resolve, reject) => {
      fixture.finish = (success) =>
        success ? resolve() : reject(new Error("合成提交失败，请重试"));
    });
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
