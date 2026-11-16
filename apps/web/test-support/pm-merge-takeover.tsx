import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  CardiganClient,
  NeedsDecision,
  NeedsPage,
  NoticeView,
} from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import {
  fixtureNeedsCounts,
  fixtureNeedsSection,
} from "../src/testing/needs-fixture.js";
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
  reads: [] as string[],
  finish: (_success: boolean) => {},
};
const tabScenario = new URLSearchParams(location.search).has("tabs");
let page: NeedsPage = {
  decisions: tabScenario
    ? [
        {
          ...decision,
          id: "Q-2",
          question: title,
          decider: "human",
          trigger: null,
          merge_confirmation: null,
          options: [{ key: "go", description: "继续", impact: "继续执行" }],
        },
      ]
    : [],
  pm_held_merges: [decision],
  human_actions: tabScenario
    ? [
        {
          id: "H-1",
          card_id: "C-1",
          why: "合成操作",
          instructions: "请确认示例设备已连接。",
          expected_return: "完成结果",
          due: null,
          waited_ms: 0,
          blocked_work_items: [],
        },
      ]
    : [],
  incidents: [],
  later: tabScenario
    ? [
        {
          id: "H-2",
          kind: "human_action",
          card_id: "C-1",
          title: "合成：后续核对",
          waiting_for: "等待相关卡片合并",
        },
      ]
    : [],
  notices: tabScenario
    ? (["auto_merge", "timed_merge", "system", "system", "pm"] as const).map(
        (source, i): NoticeView => ({
          id: `notice-${i}`,
          kind: i < 2 ? "merge" : "decision",
          source,
          card_id: "C-1",
          decision_id: i < 2 ? `Q-${i + 3}` : null,
          question: "",
          option:
            [
              "merge",
              "merge",
              "默认角色已自动升级",
              "常驻会话已自动轮换",
              "go",
            ][i] ?? "",
          resolved_by: source === "pm" ? "pm" : "system",
          author: source === "pm" ? "assignment:A-1" : "system",
          author_display: source === "pm" ? "项目经理" : "系统",
          body:
            [
              "合成示例：按自动合并开关完成合并。",
              "合成示例：等待超时，按原超时代批规则确认。",
              "合成示例：部署完成，默认角色已自动升级。",
              "合成示例：常驻会话已由系统轮换。",
              "合成示例：PM 已按授权处理。",
            ][i] ?? "",
          proxy_authority: null,
          at: NOW,
          read: false,
        }),
      )
    : [],
};
Object.assign(window, { takeoverFixture: fixture });
const client = fakeClient({
  needsYou: async () => {
    throw new Error("Full page must not load");
  },
  needsYouCounts: async () => {
    fixture.reads.push("counts");
    return fixtureNeedsCounts(page);
  },
  needsYouSection: async (_project, section) => {
    fixture.reads.push(section);
    return fixtureNeedsSection(page, section);
  },
  markNoticesRead: async (_project, ids) => {
    page = {
      ...page,
      notices:
        page.notices?.map((n) =>
          ids.includes(n.id) ? { ...n, read: true } : n,
        ) ?? [],
    };
  },
  completeAction: async (_project, id) => {
    page = {
      ...page,
      human_actions: page.human_actions.filter((a) => a.id !== id),
    };
  },
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
