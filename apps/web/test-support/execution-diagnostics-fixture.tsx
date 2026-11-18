import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { ExecutionDiagnosticsData } from "../src/api.js";
import { executionDisplayFixture } from "../src/testing/execution-display-fixture.js";
import { fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-464: fixed synthetic execution data (8 Assignments) and four diagnostics
// states. No network client, production database or real employee records.
Date.now = () => new Date("2026-11-15T08:00:00Z").getTime();
const state = new URLSearchParams(location.search).get("diag") ?? "ok";
const diagnostics: Record<string, ExecutionDiagnosticsData> = {
  ok: { available: true, configuration: [], sessions: [] },
  unavailable: { available: false, configuration: [], sessions: [] },
  warn: {
    available: true,
    configuration: [
      {
        profile: "fixture-codex",
        code: "codex_approval",
        message: "审批策略可能等待交互确认；请由主机管理员核对生效配置。",
      },
    ],
    sessions: [
      {
        assignment_id: "A-1",
        cause: "waiting_confirmation",
        action: "wait",
        evidence: [],
      },
      {
        assignment_id: "A-3",
        cause: "runtime_exited",
        action: "wait",
        evidence: ["connection_probe_failed"],
      },
    ],
  },
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
      execution: async () => executionDisplayFixture(),
      executionDiagnostics: () =>
        state === "checking"
          ? new Promise<ExecutionDiagnosticsData>(() => {})
          : Promise.resolve(diagnostics[state] ?? diagnostics.ok),
      executionRuns: async (_project, id) => {
        const runs = executionDisplayFixture().runs.filter(
          (r) => r.assignment_id === id,
        );
        return { runs, total: runs.length, next_cursor: null };
      },
      executionCapacity: async () => ({
        agents: [
          {
            machine_id: "fixture",
            label: "示例机器",
            running: 2,
            total_running: 4,
            limit: 6,
            max_limit: 8,
            queued: 1,
            merge_check_slots: 0,
          },
        ],
        merge_checks: [
          { machine_id: "fixture-ci", running: 1, limit: 3, queued: 0 },
        ],
        merge_config_invalid: false,
      }),
    })}
  />,
);
