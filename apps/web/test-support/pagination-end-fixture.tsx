import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

// C-261: local demo data shared by the baseline and current components.
Date.now = () => new Date(NOW).getTime();
const empty = new URLSearchParams(location.search).has("empty");
const count = empty ? 0 : 2;
const client = fakeClient({
  activity: async () => ({
    cards: [{ id: "C-1", title: "核对页面与交付记录" }],
    events: Array.from({ length: count }, (_, i) => ({
      id: `event-${i}`,
      card_id: "C-1",
      card_title: "核对页面与交付记录",
      seq: i + 1,
      type: i ? "card_created" : "comment_posted",
      created_at: NOW,
      payload: {},
      actor: { kind: "human" as const },
      role: "human",
    })),
    next_before: null,
    counts: { returned: count, matched: count },
  }),
  decisionHistory: async () => ({
    decisions: Array.from({ length: count }, (_, i) => ({
      id: `Q-${i + 1}`,
      question: i ? "是否继续检查页面截图？" : "是否安排下一轮审核？",
      status: "resolved" as const,
      blocking: false,
      decider: "human",
      category: "general" as const,
      affected_cards: ["C-1"],
      decision_maker: "human" as const,
      recommended: "go",
      options: [{ key: "go", description: "继续检查", impact: "核对交付证据" }],
      resolution: {
        option: "go",
        rationale: "按当前安排继续。",
        raw_quote: "继续检查",
        at: NOW,
        resolved_by: "human",
        via: "needs_you",
      },
    })),
    next_cursor: null,
  }),
});
const root = document.getElementById("root");
if (root) createRoot(root).render(<App client={client} />);
