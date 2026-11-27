import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import {
  ApiError,
  type ExecutionCapacity,
  type MachineDeviceView,
} from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import { fixtureMachines } from "../src/testing/machines-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-818 evidence: the synthetic machines of the unit tests (本机, 构建机 for
// this project; Mac mini only for the peer) and four synthetic devices: one
// held by this project's Run, one waiting to be enabled (unauthorized), one
// disabled, one unplugged and held by the peer's Run. Device requests only
// resolve with the requested status (or, with `?scene=fail`, are refused).
// No backend, host, device or production record is read or written.
Date.now = () => new Date(NOW).getTime();
const scene = new URLSearchParams(location.search).get("scene");
const since = "2026-01-01T00:00:00.000Z";
const devices: MachineDeviceView[] = [
  {
    machine: "local",
    type: "android.device",
    id: "WGC6R21609003324",
    status: "enabled",
    projects: ["p-1"],
    choices: ["p-1", "peer"],
    model: "MRR-W39",
    version: "12",
    resolution: "1600x2560",
    state: "in_use",
    holder: {
      project: "p-1",
      run_id: "R-31",
      assignment_id: "A-12",
      since,
      card_id: "C-1",
    },
  },
  {
    machine: "local",
    type: "android.device",
    id: "R5CT1234567",
    status: "pending",
    projects: [],
    choices: ["p-1", "peer"],
    model: "SM-S9180",
    state: "unauthorized",
  },
  {
    machine: "local",
    type: "android.device",
    id: "HT7A1B2C3D",
    status: "disabled",
    projects: ["p-1", "peer"],
    choices: ["p-1", "peer"],
    model: "Pixel 7",
    state: "available",
  },
  {
    machine: "builder",
    type: "android.device",
    id: "EMU0001",
    status: "enabled",
    projects: ["p-1"],
    choices: ["p-1"],
    model: "SM-X710",
    state: "missing",
    holder: { project: "peer", run_id: "R-9", assignment_id: "A-9", since },
  },
];
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
  merge_checks: [],
  merge_config_invalid: false,
};
const client = fakeClient({
  ...settingsPanels,
  executionCapacity: async () => capacity,
  machines: async () => ({ machines: fixtureMachines }),
  machine: async (_p, id) => {
    const found = fixtureMachines.find((m) => m.id === id);
    if (!found) throw new Error(`合成数据中没有机器 ${id}`);
    return { machine: found };
  },
  machineDevices: async (_p, machine) => ({
    devices: devices.filter((d) => d.machine === machine),
  }),
  requestMachineDevice: async (_p, machine, _t, id, body) => {
    if (scene === "fail")
      throw new ApiError(
        409,
        "illegal_transition",
        "设备状态刚刚变化，请刷新后重试",
      );
    const found = devices.find((d) => d.machine === machine && d.id === id);
    if (!found) throw new Error("合成数据中没有这台设备");
    return {
      device: {
        ...found,
        status:
          body.request === "disable"
            ? "disabled"
            : body.request === "enable"
              ? "initializing"
              : found.status,
        projects:
          "projects" in body && body.projects ? body.projects : found.projects,
      },
    };
  },
  setRunLimit: async () => {},
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
