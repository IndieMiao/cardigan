import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { ExecutionCapacity } from "../src/api.js";
import { card, cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

// Synthetic only: 2 machines, 2 CI targets, 1 card. No business server or database.
Date.now = () => new Date(NOW).getTime();
let capacity: ExecutionCapacity = {
  agents: [
    {
      machine_id: "local",
      label: "示例工作机",
      running: 3,
      total_running: 5,
      limit: 6,
      max_limit: 16,
      queued: 2,
      merge_check_slots: 2,
    },
    {
      machine_id: "example-worker",
      label: "示例远程工作机",
      running: 1,
      total_running: 1,
      limit: 4,
      max_limit: 8,
      queued: 0,
      merge_check_slots: 0,
    },
  ],
  merge_checks: [
    { machine_id: "example-ci", running: 1, limit: 3, queued: 4 },
    { machine_id: "local", running: 1, limit: 1, queued: 0 },
  ],
  merge_config_invalid: false,
};
const sample = { ...card, title: "发布前检查与多机器并发容量展示的长标题核对" };
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    callbacks.status("live");
    const update = () => {
      capacity = {
        ...capacity,
        agents: capacity.agents.map((m, i) =>
          i ? m : { ...m, running: 4, total_running: 6 },
        ),
      };
      callbacks.capacity?.();
    };
    window.addEventListener("synthetic-capacity", update);
    return () => window.removeEventListener("synthetic-capacity", update);
  },
  executionCapacity: async () => capacity,
  setRunLimit: async (_p, machine, limit) => {
    capacity = {
      ...capacity,
      agents: capacity.agents.map((m) =>
        m.machine_id === machine ? { ...m, limit } : m,
      ),
    };
  },
  card: async () => cardDetail({ card: sample, attachments: [] }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
