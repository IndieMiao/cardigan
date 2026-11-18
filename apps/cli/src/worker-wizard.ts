import { dirname, join } from "node:path";
import {
  onboardWorker,
  parseWorkerOnboarding,
  readOnboardingYaml,
  refreshMachineObservations,
  runtimeWorkersPath,
  WORKER_STEPS,
  WorkerOnboardingError,
  type WorkerProbeRunner,
  workerJournalId,
  workerOnboardingStatus,
} from "@cardigan/host";
import { openStore } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import { hasToken, resolveDataDir } from "./host.js";
import type { CliIo } from "./io.js";
import { runWorkflowCommand } from "./workflow.js";

const USAGE = `用法：cardigan worker add|resume|check|status --project <项目> --machine <机器>
  add|resume|check [--host <SSH 主机>] [--config <私有 YAML>] [--dry-run]
  通用：[--data-dir <目录>]；配置目录由 CARDIGAN_CONFIG_DIR 指定。
  默认配置：worker-<机器>-<项目>.yaml；详见 docs/linux-worker.md、docs/macos-worker.md。
  dry-run 只显示步骤，不读配置、不建子进程、不写文件、不联网。`;

export async function runWorkerCommand(
  argv: readonly string[],
  io: CliIo,
  probe?: WorkerProbeRunner,
): Promise<number> {
  if (hasToken(io) || io.env.MCP_TOKEN !== undefined)
    throw new CliError(
      "worker 命令仅限人类操作，Token 模式不可用。",
      EXIT.usage,
    );
  if (argv.includes("--help")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const [mode, ...args] = argv;
  if (
    mode !== "add" &&
    mode !== "resume" &&
    mode !== "check" &&
    mode !== "status"
  )
    throw new CliError(USAGE, EXIT.usage);
  const flags: Record<string, string> = {};
  let dry = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--dry-run" && !dry) {
      dry = true;
      continue;
    }
    const match = /^--(project|machine|host|config|data-dir)(?:=(.*))?$/u.exec(
      arg,
    );
    const name = match?.[1],
      value = match?.[2] ?? args[++i];
    if (!name || !value || value.startsWith("--") || flags[name] !== undefined)
      throw new CliError("worker 参数无效。", EXIT.usage);
    flags[name] = value;
  }
  const project = flags.project,
    machine = flags.machine;
  if (!project || !machine) throw new CliError(USAGE, EXIT.usage);
  try {
    workerJournalId(project, machine);
    if (dry) {
      io.stdout(
        `dry-run: ${WORKER_STEPS.join(" → ")}\n需要私有配置：SSH 固定主机密钥、项目账号/目录、hc/helper、HTTPS MCP。`,
      );
      return EXIT.ok;
    }
    const configRoot = dirname(runtimeWorkersPath(io.env));
    if (mode === "status") {
      const journal = workerOnboardingStatus(configRoot, project, machine);
      io.stdout(
        journal
          ? JSON.stringify({
              recorded_at: journal.updated_at,
              steps: journal.steps,
            })
          : "没有接入记录",
      );
      return EXIT.ok;
    }
    if (io.platform !== "linux")
      throw new WorkerOnboardingError("worker_controller_linux_required");
    const dataDir = resolveDataDir(io, flags["data-dir"]);
    const config = parseWorkerOnboarding(
      readOnboardingYaml(
        flags.config ?? join(configRoot, `worker-${machine}-${project}.yaml`),
      ),
      dataDir,
    );
    if (
      config.worker.project_id !== project ||
      config.worker.machine_id !== machine ||
      (flags.host !== undefined && flags.host !== config.worker.execution.host)
    )
      throw new WorkerOnboardingError("worker_identity_conflict");
    const registration = async (create: boolean) => {
      const store = openStore({ dataDir });
      let exists = false;
      let label = machine;
      try {
        if (!store.getProject(project)) return false;
        const machines = store.uow.read((tx) =>
          store.listProjects().flatMap((p) =>
            tx.machines
              .list(p.id)
              .filter((m) => m.id === machine)
              .map((m) => ({ project: p.id, machine: m })),
          ),
        );
        if (
          machines.some(
            (m) =>
              m.machine.os !== config.worker.os ||
              m.machine.arch !== config.worker.arch ||
              m.machine.herdr_machine !== machine,
          )
        )
          return false;
        exists = machines.some((m) => m.project === project);
        label = machines[0]?.machine.label ?? machine;
      } finally {
        store.close();
      }
      if (exists) return true; // Preserve online/draining and all existing capacity/tags.
      if (!create) return false;
      const silent = { ...io, stdout: () => {}, stderr: () => {} };
      return (
        (await runWorkflowCommand(
          [
            "machine",
            "register",
            machine,
            "--project",
            project,
            "--data-dir",
            dataDir,
            "--label",
            label,
            "--os",
            config.worker.os,
            "--arch",
            config.worker.arch,
            "--status",
            "offline",
          ],
          silent,
        )) === EXIT.ok
      );
    };
    const passed = await onboardWorker({
      config,
      configRoot,
      dataDir,
      mode,
      registration,
      ...(probe ? { probe } : {}),
      report: (step, state, reason, next) =>
        io.stdout(`${step}: ${state} (${reason})${next ? `\n${next}` : ""}`),
    });
    const store = openStore({ dataDir });
    try {
      const registered = store.uow.read((tx) =>
        tx.machines.get(project, machine),
      );
      if (registered) {
        const observations = await refreshMachineObservations({
          store,
          project,
          machine,
          env: io.env,
          target: () => ({
            execution: config.worker.execution,
            machine: registered,
          }),
          check: async () => ({
            blockers: passed ? [] : ["worker_check_failed"],
            launch_enabled: false,
          }),
        });
        if (passed && !observations.health?.available)
          throw new WorkerOnboardingError("worker_capability_check_failed");
      }
    } finally {
      store.close();
    }
    if (passed)
      io.stdout(
        "接入检查通过；未启用远程派发。MCP 已验证 HTTPS 可达和未鉴权拒绝，启动鉴权由运行目标检查负责。",
      );
    return passed ? EXIT.ok : EXIT.failure;
  } catch (error) {
    throw new CliError(
      error instanceof WorkerOnboardingError
        ? error.code
        : "worker_operation_failed",
      EXIT.failure,
      [
        "参见 docs/linux-worker.md 或 docs/macos-worker.md；核对私有配置和权限后重试。",
      ],
    );
  }
}
