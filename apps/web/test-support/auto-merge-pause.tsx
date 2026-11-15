import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { ApiError } from "../src/api.js";
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
    if (scenario === "failed") throw new Error("Synthetic unavailable");
    paused = value;
  },
  needsYou: async () => ({
    decisions: [],
    human_actions: [],
    incidents: [],
    auto_merge_pause: { paused, waiting_count: scenario === "zero" ? 0 : 3 },
    waiting_merge_checks_count: scenario === "checks" ? 2 : 0,
    notices:
      scenario === "human"
        ? [
            {
              id: "N-1",
              kind: "decision",
              card_id: "C-1",
              decision_id: "Q-1",
              question: "合成卡片合并",
              option: "merge",
              resolved_by: "human",
              body: "人已亲自确认合并，按原流程继续发布。",
              proxy_authority: null,
              at: "2026-11-15T00:00:00Z",
              read: false,
            },
          ]
        : [],
  }),
});
createRoot(document.getElementById("root") as HTMLElement).render(
  <App client={client} />,
);
