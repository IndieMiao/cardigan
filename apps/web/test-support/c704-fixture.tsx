import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { executionDisplayKey } from "../src/execution-display.js";
import { executionSortKey } from "../src/execution-sort.js";
import { executionDisplayFixture } from "../src/testing/execution-display-fixture.js";
import { fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-704 evidence only: the C-314 synthetic Assignments; four Runs with
// different Harness / model / effort values (one without effort) and four
// Assignments without a Run. No network client or database.
Date.now = () => new Date("2026-11-15T07:47:30Z").getTime();
const mode = new URLSearchParams(location.search).get("mode") ?? "table";
localStorage.setItem(
  executionDisplayKey("p-1"),
  JSON.stringify({ mode, grouped: false }),
);
localStorage.setItem(executionSortKey("p-1"), "asc");
const fixture = executionDisplayFixture();
const configs = [
  { harness: "claude", model: "opus-5.5", effort: "xhigh" },
  { harness: "codex", model: "gpt-5.5", effort: "high" },
  { harness: "pi", model: "deepseek-v4", effort: null },
  { harness: "claude", model: "sonnet-5.5", effort: "medium" },
];
const data = {
  ...fixture,
  runs: fixture.runs.map((run, i) => ({ ...run, ...configs[i] })),
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
