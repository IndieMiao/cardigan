import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  ExecutionCapacity,
  MachineBindingView,
  MachineCheckJob,
  MachineView,
} from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import { fixtureMachines } from "../src/testing/machines-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-708 evidence: the synthetic machines of the unit tests (本机, 构建机,
// Mac mini) and the synthetic card list. 本机's binding to this project
// lists the host catalog keys as the machine read now returns them: two
// verified, the first-batch tools unverified with their built-in probes, and
// the browser search's recorded locations. 复查 "registers" node: the fake
// check ends after the machine read already shows it verified. No backend,
// host or production record is read or written.
Date.now = () => new Date(NOW).getTime();
const CHECKED = "2025-12-31T22:00:00.000Z";
const cap = (
  key: string,
  verified: boolean,
  argv?: string[],
): MachineBindingView["capabilities"][number] => ({
  key,
  version: verified ? (key === "node" ? "24.11.0" : "0.98.0") : null,
  verified_at: verified ? CHECKED : null,
  available: verified,
  state: verified ? "verified" : "unverified",
  ...(argv ? { probe: { kind: "command", argv } } : {}),
});
const capabilities = (nodeVerified: boolean) => [
  cap("harness.codex", true, ["codex", "--version"]),
  cap("python", true, ["python3", "--version"]),
  cap("node", nodeVerified, ["node", "--version"]),
  cap("godot", false, ["godot", "--version"]),
  cap("blender", false, ["blender", "--version"]),
  cap("android.sdk", false, ["adb", "version"]),
  cap("android.emulator", false, ["emulator", "-version"]),
  {
    ...cap("browser.chromium", false),
    probe: {
      kind: "search",
      locations: [
        "PATH:chromium",
        "PATH:chromium-browser",
        "PATH:google-chrome",
        "$HOME/.cache/ms-playwright",
      ],
    },
  },
];
let nodeVerified = false;
const machine = (id: string): MachineView => {
  const found = fixtureMachines.find((m) => m.id === id);
  if (!found) throw new Error(`合成数据中没有机器 ${id}`);
  if (id !== "local") return found;
  return {
    ...found,
    bindings: found.bindings.map((b) =>
      b.is_current
        ? {
            ...b,
            runtime: {
              account: "worker-a",
              directory: null,
              session: "cardigan",
              path_entries: 3,
            },
            capabilities: capabilities(nodeVerified),
            capability_failures: [
              {
                key: "browser.chromium",
                search_locations: [
                  "PATH:chromium",
                  "PATH:chromium-browser",
                  "PATH:google-chrome",
                  "$HOME/.cache/ms-playwright",
                ],
              },
            ],
          }
        : b,
    ),
  };
};
const capacity: ExecutionCapacity = {
  agents: [
    {
      machine_id: "local",
      label: "本机",
      running: 3,
      total_running: 4,
      limit: 6,
      max_limit: 16,
      queued: 2,
      merge_check_slots: 0,
    },
  ],
  merge_checks: [],
  merge_config_invalid: false,
};
const job = (patch: Partial<MachineCheckJob> = {}): MachineCheckJob => ({
  id: "chk-708",
  project_id: "p-1",
  machine_id: "local",
  kind: "machine",
  status: "running",
  step: "capabilities",
  started_at: NOW,
  checked_at: NOW,
  failed_steps: [],
  ...patch,
});
const client = fakeClient({
  ...settingsPanels,
  executionCapacity: async () => capacity,
  machines: async () => ({
    machines: fixtureMachines.map((m) => machine(m.id)),
  }),
  machine: async (_p, id) => ({ machine: machine(id) }),
  setRunLimit: async () => {},
  checkMachine: async () => ({ check: job() }),
  machineCheck: async () => {
    nodeVerified = true;
    return { check: job({ status: "passed", step: "finished" }) };
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
