import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { executionDisplayFixture } from "../src/testing/execution-display-fixture.js";
import { card, fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

Date.now = () => new Date("2026-11-15T07:47:30Z").getTime();
const source = executionDisplayFixture();
// A focused crowded-header regression: 409 working records out of 701, three
// machines. These are deterministic copies of the small synthetic fixture.
const crowded = new URLSearchParams(location.search).has("crowded");
const machines = crowded
  ? [
      { id: "local", label: "local", status: "online" },
      { id: "worker", label: "synthetic-machine", status: "online" },
      { id: "ci", label: "cardigan-ci", status: "online" },
    ]
  : [
      { id: "local", label: "local", status: "online" },
      { id: "worker", label: "cardigan-ci", status: "online" },
    ];
const assignments = crowded
  ? Array.from({ length: 701 }, (_, i) => {
      const original = source.assignments[i % source.assignments.length];
      if (!original) throw new Error("Missing synthetic assignment");
      return {
        ...original,
        id: `A-${i + 1}`,
        status: i < 409 ? "active" : "released",
        runtime_state: i < 409 ? "running" : "released",
      };
    })
  : source.assignments;
const data = {
  machines,
  assignments: assignments.map((a, i) => ({
    ...a,
    external: false,
    machine_id: machines[i % machines.length]?.id ?? "local",
    runtime_ref: {
      terminal_ref: `t-${i}`,
      runtime_machine: machines[i % machines.length]?.id ?? "local",
    },
    card_title:
      i % 2
        ? "统一执行视图与卡片页的控件、状态和机器信息"
        : "合成任务：核对机器容量与执行状态",
  })),
  runs: source.runs.map((r, i) => ({
    ...r,
    recovery_runtime: {
      machine_id: i % 2 ? "worker" : "local",
      runtime_machine: i % 2 ? "worker" : "local",
    },
    ...(i === 1
      ? {
          queue_ahead: 2,
          dispatch_reason: "等待机器并发名额",
          queue_warning: { after_minutes: 30, waited_ms: 1900000 },
        }
      : {}),
  })),
};
const cards = ["todo", "in_progress", "in_progress", "done"].map(
  (status, i) => ({
    ...card,
    id: `C-${i + 1}`,
    status,
    title: data.assignments[i]?.card_title ?? "合成任务",
  }),
);
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <App
    client={fakeClient({
      subscribe: (_project, callbacks) => {
        callbacks.status("live");
        return () => {};
      },
      cards: async () => ({ cards }),
      execution: async () => data,
      executionCapacity: async () => ({
        agents: machines.map((m, i) => ({
          machine_id: m.id,
          label: m.label,
          running: i ? 1 : 3,
          total_running: i ? 2 : 5,
          limit: i ? 1 : 6,
          max_limit: 12,
          queued: i ? 2 : 0,
          merge_check_slots: 0,
        })),
        merge_checks: [],
        merge_config_invalid: false,
      }),
      executionRuns: async (_project, id) => ({
        runs: data.runs.filter((r) => r.assignment_id === id),
        total: data.runs.filter((r) => r.assignment_id === id).length,
        next_cursor: null,
      }),
    })}
  />,
);
