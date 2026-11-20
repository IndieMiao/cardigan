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

// C-504 evidence only: the C-314 synthetic Assignments with one Run per
// context level and one Run without a reading. No network client or database.
Date.now = () => new Date("2026-11-15T07:47:30Z").getTime();
const mode = new URLSearchParams(location.search).get("mode") ?? "table";
localStorage.setItem(
  executionDisplayKey("p-1"),
  JSON.stringify({ mode, grouped: false }),
);
// Oldest activity first puts the Runs with readings in the first viewport.
localStorage.setItem(executionSortKey("p-1"), "asc");
const fixture = executionDisplayFixture();
const usage = [0.6875, 0.82, 0.9];
const data = {
  ...fixture,
  runs: fixture.runs.map((run, i) => {
    const { context_usage: _, ...rest } = run;
    const ratio = usage[i];
    return ratio === undefined
      ? rest
      : {
          ...rest,
          context_usage: { used_ratio: ratio, window_tokens: 200000 },
        };
  }),
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
