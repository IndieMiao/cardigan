import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { executionDisplayFixture } from "../src/testing/execution-display-fixture.js";
import { card, fakeClient } from "../src/testing/fixtures.js";
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
      cards: async () => ({
        cards: ["todo", "in_progress", "in_progress", "done"].map(
          (status, i) => ({
            ...card,
            id: `C-${i + 1}`,
            status,
            title: `合成卡片 ${i + 1}：共享表格分组、筛选和分页保持一致`,
          }),
        ),
      }),
      execution: async () => data,
      executionRuns: async () => ({ runs: [], total: 0, next_cursor: null }),
    })}
  />,
);
