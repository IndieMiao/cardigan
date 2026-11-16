import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { executionDisplayKey } from "../src/execution-display.js";
import { executionSortKey } from "../src/execution-sort.js";
import { executionDisplayFixture } from "../src/testing/execution-display-fixture.js";
import { fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

Date.now = () => new Date("2026-11-15T07:47:30Z").getTime();
localStorage.setItem(
  executionDisplayKey("p-1"),
  JSON.stringify({ mode: "cards", grouped: false }),
);
localStorage.setItem(executionSortKey("p-1"), "state-asc");
const fixture = executionDisplayFixture();
const data = {
  ...fixture,
  assignments: fixture.assignments.map((a, i) => ({
    ...a,
    ...(i === 0
      ? { card_title: "执行视图卡片模式：紧凑布局与空白拖动", card_priority: 3 }
      : {}),
    ...(i === 1
      ? { verification_activity: { status: "running", label: "正在审核" } }
      : {}),
  })),
  runs: fixture.runs.map((run) => ({
    ...run,
    model: "gpt-6-astra",
    effort: "xhigh",
    context_usage: { used_ratio: 0.1354, window_tokens: 828400 },
  })),
};
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <App
    client={fakeClient({
      subscribe: (_project, callbacks) => {
        callbacks.status("live");
        return () => {};
      },
      execution: async () => data,
    })}
  />,
);
