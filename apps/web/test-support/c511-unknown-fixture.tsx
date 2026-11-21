import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { ExecutionCapacity, MachineView } from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import { fixtureMachines } from "../src/testing/machines-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-511 Q-1048 evidence: the synthetic machines of the unit tests (本机,
// 构建机, Mac mini) and one capacity record. `?scene=` picks what the
// machine writes answer; every reply is lost in the page (TypeError), no
// backend, host or production record is touched.
//   lost     立即检查 / 排空 replies lost, reads unchanged
//   running  立即检查 reply lost, the next read shows another project's check
Date.now = () => new Date(NOW).getTime();
// Each scene starts without an unknown write kept from the previous one.
window.sessionStorage.clear();
const scene = new URLSearchParams(location.search).get("scene") ?? "lost";
const machines = new Map(fixtureMachines.map((m) => [m.id, m]));
const local = machines.get("local") as MachineView;
const running: MachineView = {
  ...local,
  bindings: local.bindings.map((b) =>
    b.project_id === "peer"
      ? {
          ...b,
          last_requested_check: {
            id: "chk-peer",
            kind: "machine",
            status: "running",
            step: "ssh",
            checked_at: NOW,
            failed_steps: [],
          },
        }
      : b,
  ),
};
let sent = false;
const capacity: ExecutionCapacity = {
  agents: [
    {
      machine_id: "local",
      label: "本机",
      running: 2,
      total_running: 3,
      limit: 6,
      max_limit: 16,
      queued: 1,
      merge_check_slots: 0,
    },
  ],
  merge_checks: [],
  merge_config_invalid: false,
};
const client = fakeClient({
  ...settingsPanels,
  executionCapacity: async () => capacity,
  machines: async () => ({ machines: [...machines.values()] }),
  machine: async (_p: string, id: string) => ({
    machine:
      id === "local" && sent && scene === "running"
        ? running
        : (machines.get(id) as MachineView),
  }),
  setRunLimit: async () => {},
  checkMachine: async () => {
    sent = true;
    throw new TypeError("synthetic lost reply");
  },
  machineCheck: () => new Promise(() => {}),
  setMachineDrain: async () => {
    sent = true;
    throw new TypeError("synthetic lost reply");
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
