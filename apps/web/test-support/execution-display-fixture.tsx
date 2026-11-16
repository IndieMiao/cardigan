import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { executionDisplayFixture } from "../src/testing/execution-display-fixture.js";
import { fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

Date.now = () => new Date("2026-11-15T07:47:30Z").getTime();
const data = executionDisplayFixture();
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
      executionRuns: async () => ({ runs: [], total: 0, next_cursor: null }),
    })}
  />,
);
