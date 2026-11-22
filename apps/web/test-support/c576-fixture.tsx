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

// C-576 evidence: the synthetic machines of the unit tests (本机, 构建机,
// Mac mini), one capacity record and the synthetic card list. `?scene=max`
// puts 本机's Agent limit at its host maximum (16). No backend, host or
// production record is read or written; limit writes only resolve.
Date.now = () => new Date(NOW).getTime();
const atMaximum = new URLSearchParams(location.search).get("scene") === "max";
const machine = (id: string): MachineView => {
  const found = fixtureMachines.find((m) => m.id === id);
  if (!found) throw new Error(`合成数据中没有机器 ${id}`);
  return atMaximum && id === "local"
    ? { ...found, run_limit: found.run_limit_maximum }
    : found;
};
const capacity: ExecutionCapacity = {
  agents: [
    {
      machine_id: "local",
      label: "本机",
      running: 3,
      total_running: 4,
      limit: atMaximum ? 16 : 6,
      max_limit: 16,
      queued: 2,
      merge_check_slots: 0,
    },
    {
      machine_id: "builder",
      label: "构建机",
      running: 0,
      total_running: 0,
      limit: 4,
      max_limit: 8,
      queued: 0,
      merge_check_slots: 0,
    },
  ],
  merge_checks: [{ machine_id: "ci", running: 1, limit: 3, queued: 4 }],
  merge_config_invalid: false,
};
const client = fakeClient({
  ...settingsPanels,
  executionCapacity: async () => capacity,
  machines: async () => ({
    machines: fixtureMachines.map((m) => machine(m.id)),
  }),
  machine: async (_p, id) => ({ machine: machine(id) }),
  setRunLimit: async () => {},
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
