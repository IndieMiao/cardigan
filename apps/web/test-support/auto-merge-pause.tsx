import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { ApiError, type NeedsDecision } from "../src/api.js";
import { fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "../src/styles.css";

// Local, synthetic rendering only: no database, credentials or publish operation.
const scenario =
  new URLSearchParams(location.search).get("scenario") ?? "waiting";
let paused = scenario !== "off";
const client = fakeClient({
  preferences: async () => ({
    auto_merge_after_minutes: null,
    merge_gate_enabled: true,
    auto_merge_paused: paused,
  }),
  setAutoMergePaused: async (_project, value) => {
    if (scenario === "loading") await new Promise(() => {});
    if (scenario === "denied")
      throw new ApiError(403, "unauthorized", "Denied");
    if (scenario === "failed")
      throw new ApiError(
        503,
        "service_unavailable",
        "服务暂时不可用，请稍后重试",
      );
    paused = value;
  },
  needsYou: async () => ({
    decisions:
      scenario === "human"
        ? [
            {
              id: "Q-1",
              card_id: "C-1",
              affected_cards: ["C-1"],
              related_cards: [{ id: "C-1", title: "待人确认的合成合并" }],
              question: "确认合并合成卡片？",
              context: "自动合并暂停不妨碍你亲自确认。",
              why: "等待人确认",
              status: "open",
              blocking: true,
              decider: "human",
              category: "general",
              trigger: "merge_confirmation",
              assignment_id: null,
              waited_ms: 0,
              options: [
                {
                  key: "merge",
                  description: "合并",
                  impact: "按原流程继续发布",
                },
                { key: "hold", description: "暂缓", impact: "继续等待" },
              ],
              recommended: "merge",
              merge_confirmation: null,
            } satisfies NeedsDecision,
          ]
        : [],
    human_actions: [],
    incidents: [],
    auto_merge_pause: { paused, waiting_count: scenario === "zero" ? 0 : 3 },
    waiting_merge_checks_count: scenario === "checks" ? 2 : 0,
    notices: [],
  }),
});
createRoot(document.getElementById("root") as HTMLElement).render(
  <App client={client} />,
);
