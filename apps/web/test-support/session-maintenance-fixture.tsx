import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { fakeClient } from "../src/testing/fixtures.js";
import { sessionMaintenanceFixture } from "../src/testing/session-maintenance-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

Date.now = () => new Date("2026-11-17T02:00:30Z").getTime();
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
const empty = new URLSearchParams(location.search).has("empty");
createRoot(root).render(
  <App
    client={fakeClient({
      subscribe: (_project, callbacks) => {
        callbacks.status("live");
        return () => {};
      },
      execution: async () => sessionMaintenanceFixture(empty),
      executionRuns: async (_project, id) => {
        const runs = sessionMaintenanceFixture(empty).runs.filter(
          (r) => r.assignment_id === id,
        );
        return { runs, total: runs.length, next_cursor: null };
      },
    })}
  />,
);
