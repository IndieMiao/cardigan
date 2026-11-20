import type {
  CardiganClient,
  MachineCheckJob,
  WorkerWizardStep,
  WorkerWizardView,
} from "../src/api.js";

/**
 * C-511 evidence: a synthetic add-worker backend (no host, no SSH, no files).
 * The first check stops at SSH; the next one passes. Machine checks stay at
 * their SSH step so the progress can be photographed.
 */
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
const steps = (blocked?: string): WorkerWizardStep[] => {
  const at = blocked ? STEPS.indexOf(blocked as never) : STEPS.length;
  return STEPS.map((step, i) =>
    i < at
      ? { step, state: "passed", elapsed_ms: 800 + i * 150 }
      : i === at
        ? {
            step,
            state: "blocked",
            elapsed_ms: 15000,
            reason: `worker_${step}_blocked`,
            next: "核对 worker-known-hosts 中的主机指纹与 SSH 公钥，确认目标机 22 端口可达后重试。",
          }
        : { step, state: "pending", elapsed_ms: 0 },
  );
};
let wizard: WorkerWizardView | undefined;
let runs = 0;
let polls = 0;
let previews = 0;
const preview = (diff: NonNullable<WorkerWizardView["preview"]>["diff"]) => ({
  preview_id: `preview-${++previews}`,
  expires_at: "2026-01-01T00:15:00.000Z",
  file:
    wizard?.phase === "passed"
      ? "runtime-workers.yaml"
      : "worker-studio-p-1.yaml",
  diff,
});
const job = (): MachineCheckJob => ({
  id: "check-1",
  project_id: "p-1",
  machine_id: "local",
  kind: "machine",
  status: "running",
  step: "ssh",
  started_at: "2025-12-31T23:59:00.000Z",
  checked_at: "2025-12-31T23:59:40.000Z",
  failed_steps: [],
});
export const workerWizardData: Partial<CardiganClient> = {
  checkMachine: async () => ({ check: job() }),
  machineCheck: async () => ({ check: job() }),
  setMachineDrain: async (_p, id, drain) => ({
    machine_id: id,
    status: drain ? "draining" : "online",
  }),
  createWorkerWizard: async (_p, input) => {
    wizard = {
      id: "6f1c2a7e-0000-4000-8000-000000000001",
      machine_id: input.machine_id,
      project_id: "p-1",
      label: input.label,
      os: input.os,
      arch: input.arch,
      phase: "preview",
      steps: steps().map((s) => ({ ...s, state: "pending", elapsed_ms: 0 })),
      commands: {
        account:
          "sudo groupadd --gid 1501 cg_studio && sudo useradd --uid 1501 --gid 1501 --home-dir /home/cg_studio --no-create-home --shell /bin/sh cg_studio",
        directories:
          "sudo /usr/bin/python3 /opt/cardigan/deploy/install-linux-worker.py --config /etc/cardigan/worker.json --check && sudo /usr/bin/python3 /opt/cardigan/deploy/install-linux-worker.py --config /etc/cardigan/worker.json --apply",
        tools:
          "sudo /usr/bin/python3 -I - <<'PY'\nimport os, pathlib, platform, runpy\n…\nPY",
        helpers:
          "sudo test ! -L /srv/cardigan-workers/p-1/libexec/worker-files.py && sudo install -o root -g cg_studio -m 0750 /opt/cardigan/deploy/worker-files.py /srv/cardigan-workers/p-1/libexec/worker-files.py",
      },
      command_guide: "docs/linux-worker.md",
      command_prerequisites:
        "仅在目标机管理员终端执行。新建账号前核对名称和数字身份均空闲；按操作手册准备受保护的安装包、目录、认领标记和本机安装配置。已有冲突请停下核对。",
    };
    wizard = {
      ...wizard,
      preview: preview([
        { field: "version", change: "add", after: 1 },
        { field: "uid", change: "add", after: 1501 },
        { field: "home", change: "add", after: "已隐藏" },
        { field: "mcp_url", change: "add", after: "已隐藏" },
        { field: "runtime.machines.0.id", change: "add", after: "studio" },
        { field: "runtime.machines.0.os", change: "add", after: "linux" },
        { field: "runtime.machines.0.host", change: "add", after: "已隐藏" },
      ]),
    };
    return { wizard };
  },
  workerWizard: async () => {
    if (!wizard) throw new Error("合成向导不存在");
    if (wizard.phase === "running" && ++polls >= 2)
      wizard = {
        ...wizard,
        phase: runs === 1 ? "failed" : "passed",
        steps: runs === 1 ? steps("ssh") : steps(),
      };
    return { wizard };
  },
  workerWizardAction: async (_p, _id, action) => {
    if (!wizard) throw new Error("合成向导不存在");
    const { preview: _, ...rest } = wizard;
    if (action.kind === "cancel") {
      wizard = undefined;
      return { cancelled: true };
    }
    if (action.kind === "confirm") wizard = { ...rest, phase: "ready" };
    else if (action.kind === "enable") wizard = { ...rest, phase: "enabled" };
    else if (action.kind === "run") {
      runs += 1;
      polls = 0;
      wizard = {
        ...rest,
        phase: "running",
        steps: wizard.steps.map((s) =>
          s.state === "blocked" ? { ...s, state: "running" } : s,
        ),
      };
    } else
      wizard = {
        ...wizard,
        preview: preview([
          { field: "project_binding", change: "add" },
          { field: "allow_remote_launch", change: "false → true" },
        ]),
      };
    return { wizard };
  },
};
