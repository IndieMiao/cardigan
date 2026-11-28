import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import {
  ApiError,
  type CardiganClient,
  type WorkerWizardStep,
  type WorkerWizardView,
} from "../src/api.js";
import { capturePairingLink } from "../src/pairing-link.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-707 evidence: the machine page with the pairing entry, a pairing link's
// prefilled first step, a refused code, the paired preview and the passed
// wizard with its onboarding report. A synthetic device (Steam Deck-like,
// self-reported facts) and the synthetic machines and cards of the unit
// tests; fixed clock; no backend, host or production record.
// `?scene=passed` / `?scene=manual-passed` hold a passed paired / hand-filled
// session the page continues. The baseline (before) renders the same scenes
// with its own page files and ignores what it does not know.
Date.now = () => new Date(NOW).getTime();
const scene = new URLSearchParams(location.search).get("scene");
const STEPS = [
  "configuration",
  "registration",
  "draft",
  "ssh",
  "account",
  "directories",
  "tools",
  "helpers",
  "resources",
  "mcp",
  "capabilities",
] as const;
const steps = (state: WorkerWizardStep["state"]): WorkerWizardStep[] =>
  STEPS.map((step, i) => ({
    step,
    state,
    elapsed_ms: state === "passed" ? 700 + i * 130 : 0,
  }));
const device = {
  hostname: "steamdeck",
  os: "linux" as const,
  arch: "x64" as const,
  address: "steamdeck.example.ts.net",
  free_id: 2000,
  system: "SteamOS 3.8",
  root_readonly: true,
  cpu: "AMD Custom APU 0405",
  cpu_cores: 8,
  memory_bytes: 16 * 1024 ** 3,
  disks: [
    { path: "/", total_bytes: 5 * 1024 ** 3, free_bytes: 866 * 1024 ** 2 },
    {
      path: "/home",
      total_bytes: 512 * 1024 ** 3,
      free_bytes: 401 * 1024 ** 3,
    },
  ],
  gpu: "AMD Custom GPU 0405",
};
const base = (paired: boolean): WorkerWizardView => ({
  id: "6f1c2a7e-0000-4000-8000-000000000707",
  machine_id: paired ? "steamdeck" : "studio",
  project_id: "p-1",
  label: paired ? "steamdeck" : "工作室",
  os: "linux",
  arch: "x64",
  phase: "preview",
  steps: steps("pending"),
  commands: {
    account:
      "sudo groupadd --gid 2000 cg_p_1 && sudo useradd --uid 2000 --gid 2000 --home-dir /home/cg_p_1 --no-create-home --shell /bin/sh cg_p_1",
    directories:
      "sudo /usr/bin/python3 /home/cardigan-release/deploy/install-linux-worker.py --config /etc/cardigan/worker.json --check",
    tools:
      "sudo /usr/bin/python3 -I - <<'PY'\nimport os, pathlib, platform, runpy\n…\nPY",
    helpers:
      "sudo install -o root -g cg_p_1 -m 0750 /home/cardigan-release/deploy/worker-files.py /home/cardigan-workers/p-1/libexec/worker-files.py",
  },
  work_root: "/home/cardigan-workers/p-1",
  command_guide: "docs/steamos-worker.md",
  command_prerequisites:
    "仅在目标机管理员终端执行。新建账号前核对名称和数字身份均空闲；按操作手册准备受保护的安装包、目录、认领标记和本机安装配置。已有冲突请停下核对。",
  ...(paired
    ? {
        device_init: { state: "waiting" as const },
        device,
        run_limit: { value: 1, state: "pending" as const },
      }
    : {}),
});
const report: NonNullable<WorkerWizardView["report"]> = {
  capabilities: [
    {
      key: "node",
      version: "24.11.0",
      verified_at: NOW,
      state: "verified",
    },
    {
      key: "python",
      version: "3.13.7",
      verified_at: NOW,
      state: "verified",
    },
    {
      key: "harness.claude",
      version: null,
      verified_at: null,
      state: "unverified",
    },
  ],
  suggested: [
    "harness.claude",
    "harness.codex",
    "blender",
    "godot",
    "android.sdk",
    "android.emulator",
    "browser.chromium",
  ],
};
const passed = (paired: boolean): WorkerWizardView => ({
  ...base(paired),
  phase: "passed",
  steps: steps("passed"),
  check_id: "check-707",
  report,
  ...(paired
    ? {
        device_init: { state: "succeeded" as const, at: NOW },
        run_limit: { value: 1, state: "applied" as const },
      }
    : {}),
});
let wizard: WorkerWizardView | undefined =
  scene === "passed"
    ? passed(true)
    : scene === "manual-passed"
      ? passed(false)
      : undefined;
if (wizard) localStorage.setItem("cardigan.worker-wizard.p-1", wizard.id);
else localStorage.removeItem("cardigan.worker-wizard.p-1");
const preview = {
  preview_id: "preview-707",
  expires_at: "2026-01-01T00:15:00.000Z",
  file: "worker-steamdeck-p-1.yaml",
  diff: [
    { field: "version", change: "add", after: 1 },
    { field: "uid", change: "add", after: 2000 },
    { field: "home", change: "add", after: "已隐藏" },
    { field: "layout", change: "add", after: "home" },
    { field: "runtime.machines.0.id", change: "add", after: "steamdeck" },
    { field: "runtime.machines.0.host", change: "add", after: "已隐藏" },
  ],
};
const client = fakeClient({
  ...settingsPanels,
  projects: async () => [
    { id: "p-1", name: "Cardigan 自己", created_at: NOW },
    { id: "p-2", name: "示例游戏", created_at: NOW, code: "GAME" },
  ],
  pairWorkerDevice: async (_p, input) => {
    if (input.code === "EXP2RED2")
      throw new ApiError(410, "pairing_code_expired", "配对码已过期");
    wizard = { ...base(true), preview };
    return { wizard, device };
  },
  workerWizard: async () => {
    if (!wizard) throw new ApiError(404, "not_found", "没有此向导会话");
    return { wizard };
  },
  workerWizardAction: async (_p, _id, action) => {
    if (!wizard) throw new ApiError(404, "not_found", "没有此向导会话");
    if (action.kind === "cancel") {
      wizard = undefined;
      return { cancelled: true };
    }
    const { preview: _, ...rest } = wizard;
    if (action.kind === "confirm") wizard = { ...rest, phase: "ready" };
    return { wizard };
  },
} satisfies Partial<CardiganClient>);
// As main.tsx does: a pairing link leaves the address bar before routing.
capturePairingLink();
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
