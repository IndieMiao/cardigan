import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import {
  ApiError,
  type CapabilityGuideTarget,
  type ExecutionCapacity,
  type MachineBindingView,
  type MachineCheckJob,
  type MachineView,
} from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import { fixtureMachines } from "../src/testing/machines-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-727 evidence: the C-708 machine detail fixture (本机 with 8 catalog keys
// of this project) plus capability usage notes held by an in-memory fake of
// the C-725 endpoint: a long Markdown note on android.emulator (folds after
// six lines) with a 本机补充, a short note on godot and on harness.codex.
// Saving a note that names a credential value is refused with the server's
// message, like the domain rule. No backend, host or production record is
// read or written.
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
const notes = new Map<string, string>([
  [
    "capability:android.emulator",
    [
      "模拟器镜像不在默认目录，启动前先设好环境变量：",
      "",
      "- `ANDROID_AVD_HOME` 指向受管镜像目录",
      "- adb 读 `ANDROID_ADB_SERVER_PORT` 与 `ANDROID_SERIAL`，不要写死端口",
      "- 无图形会话也能跑：`emulator -avd <名称> -no-window -no-audio`",
      "",
      "列出镜像用 `emulator -list-avds`；看到空列表时先确认环境变量，不要去翻镜像目录。",
      "",
      "启动后用 `adb wait-for-device` 等到就绪，再装包：",
      "",
      "```sh",
      "adb install -r build/app.apk",
      "```",
      "",
      "跑完用 `adb emu kill` 关掉，名额才会释放。",
    ].join("\n"),
  ],
  [
    "machine:android.emulator:local",
    "本机镜像在外接盘 `/Volumes/avd`，首次启动约 2 分钟。",
  ],
  ["capability:godot", "导出用 `godot --headless --export-release <预设>`。"],
  ["capability:harness.codex", "按角色包启动，不需要另配。"],
]);
const noteKey = (t: CapabilityGuideTarget) =>
  t.scope === "machine"
    ? `machine:${t.key}:${t.machine_id}`
    : `capability:${t.key}`;
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
  capabilityGuides: async (_p, machineId) => ({
    merged: {
      machine_id: machineId,
      capabilities: [
        ...new Set([...notes.keys()].map((k) => k.split(":")[1] as string)),
      ]
        .sort()
        .map((key) => ({
          key,
          usage_note: notes.get(`capability:${key}`) ?? null,
          machine_note: notes.get(`machine:${key}:${machineId}`) ?? null,
        })),
    },
  }),
  setCapabilityGuide: async (_p, target, note) => {
    if (/TOKEN=\w{8,}/.test(note))
      throw new ApiError(
        400,
        "validation_failed",
        "使用说明看起来包含凭据（TOKEN 的取值）；只写受管文件路径和读取方法，不写值",
      );
    notes.set(noteKey(target), note);
  },
  deleteCapabilityGuide: async (_p, target) => {
    notes.delete(noteKey(target));
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
