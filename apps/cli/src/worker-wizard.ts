import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Machine } from "@cardigan/domain";
import {
  MachineCheckJournal,
  matchesWorkerPlatform,
  onboardWorker,
  parseWorkerOnboarding,
  RuntimeTargets,
  readOnboardingYaml,
  refreshWorkerObservations,
  runtimeTargetBinding,
  runtimeWorkersPath,
  WORKER_STEPS,
  WorkerOnboardingError,
  type WorkerProbeRunner,
  withWorkerEnvironment,
  workerJournalId,
  workerOnboardingStatus,
} from "@cardigan/host";
import { openStore } from "@cardigan/store";
import { loadOptionalConfigSync } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { hasToken, resolveDataDir } from "./host.js";
import type { CliIo } from "./io.js";
import { cliLaunchPaths } from "./paths.js";
import { terminalExecution } from "./runtime-check.js";
import { runWorkflowCommand } from "./workflow.js";

const USAGE = `用法：cardigan worker add|resume|check|status|apply-config --project <项目> --machine <机器>
  add|resume|check [--host <SSH 主机>] [--config <私有 YAML>] [--dry-run]
  resume [--confirm-config <配置摘要>]：确认新配置，留存旧记录并重新检查。
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
    mode !== "apply-config" &&
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
    const match =
      /^--(project|machine|host|config|data-dir|confirm-config)(?:=(.*))?$/u.exec(
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
  if (
    flags["confirm-config"] !== undefined &&
    (mode !== "resume" || !/^[a-f0-9]{64}$/u.test(flags["confirm-config"]))
  )
    throw new CliError(
      "--confirm-config 仅用于 resume，需填写完整配置摘要。",
      EXIT.usage,
    );
  if (mode === "apply-config" && (machine === "local" || flags.host))
    throw new CliError(USAGE, EXIT.usage);
  let digest: string | undefined;
  try {
    workerJournalId(project, machine);
    if (dry) {
      if (mode === "apply-config") {
        io.stdout("dry-run: 等待旧绑定排空 → 检查 worker → 检查机器");
        return EXIT.ok;
      }
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
    const store = openStore({ dataDir });
    try {
      let pinned: string | undefined;
      let checkCurrent: (() => void) | undefined;
      if (mode === "apply-config") {
        const connection = await terminalExecution(io, dataDir, null, machine);
        const created = await RuntimeTargets.create({
          ...connection,
          env: io.env,
          store,
          project,
        });
        if (!created.ok)
          throw new CliError("无法读取 worker 绑定", EXIT.failure);
        const state = () => created.value.bindingState(project, machine);
        const pin = state().fingerprint;
        if (state().pending) io.stdout("等待本项目在该机器上的旧绑定排空");
        const current = () => {
          const next = state();
          if (next.fingerprint !== pin)
            throw new CliError("绑定已再次变更，请重新检查", EXIT.failure);
          return next;
        };
        while (current().pending) await delay(1000);
        pinned = pin;
        checkCurrent = () => {
          if (current().pending)
            throw new CliError("绑定仍在排空", EXIT.failure);
        };
      }
      const journal = new MachineCheckJournal(store);
      const { job, joined } = journal.claim(project, machine, "worker", "cli");
      if (joined) throw new WorkerOnboardingError("worker_busy");
      let failed = "configuration";
      const passed = await journal.execute(
        job,
        async (progress) => {
          progress("configuration");
          const draft = parseWorkerOnboarding(
            readOnboardingYaml(
              flags.config ??
                join(configRoot, `worker-${machine}-${project}.yaml`),
            ),
            dataDir,
          );
          const config =
            mode === "apply-config"
              ? withWorkerEnvironment(
                  draft,
                  readOnboardingYaml(runtimeWorkersPath(io.env)),
                  dataDir,
                )
              : draft;
          if (
            pinned &&
            runtimeTargetBinding(config.worker).fingerprint !== pinned
          )
            throw new CliError("绑定已再次变更，请重新检查", EXIT.failure);
          checkCurrent?.();
          digest = config.digest;
          if (
            config.worker.project_id !== project ||
            config.worker.machine_id !== machine ||
            (flags.host !== undefined &&
              flags.host !== config.worker.execution.host)
          )
            throw new WorkerOnboardingError("worker_identity_conflict");
          const matchesCheckedWorker = (registered: Machine) =>
            registered.herdr_machine === machine &&
            matchesWorkerPlatform(registered, config.worker);
          const registration = async (create: boolean) => {
            if (!store.getProject(project)) return false;
            const machines = store.uow.read((tx) =>
              store.listProjects().flatMap((p) => {
                const m = tx.machines.get(p.id, machine);
                return m ? [{ project: p.id, machine: m }] : [];
              }),
            );
            if (machines.some((m) => !matchesCheckedWorker(m.machine)))
              return false;
            // Preserve online/draining and all existing capacity/tags.
            if (machines.some((m) => m.project === project)) return true;
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
                  machines[0]?.machine.label ?? machine,
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
            mode: mode === "apply-config" ? "check" : mode,
            ...(mode === "apply-config" ? { appliedEnvironment: true } : {}),
            ...(flags["confirm-config"]
              ? { confirmConfig: flags["confirm-config"] }
              : {}),
            registration,
            ...(probe ? { probe } : {}),
            beforeStep: progress,
            report: (step, state, reason, next) => {
              if (state === "blocked") failed = step;
              io.stdout(
                `${step}: ${state} (${reason})${next ? `\n${next}` : ""}`,
              );
            },
          });
          checkCurrent?.();
          if (passed) progress("capabilities");
          await refreshWorkerObservations(
            store,
            config.worker,
            passed,
            io.env,
            {
              ...(mode === "check" || mode === "apply-config"
                ? { fullWorkerCheckId: job.id }
                : {}),
              browsersPath: () =>
                loadOptionalConfigSync(cliLaunchPaths(io, dataDir))?.browser
                  ?.browsers_path,
            },
          );
          return passed;
        },
        (ok) => ({
          status: ok ? "passed" : "failed",
          failed_steps: ok ? [] : [failed],
        }),
      );
      if (passed && mode === "apply-config") {
        checkCurrent?.();
        const status = await runWorkflowCommand(
          [
            "machine",
            "check",
            machine,
            "--project",
            project,
            "--data-dir",
            dataDir,
          ],
          io,
        );
        checkCurrent?.();
        return status;
      }
      if (passed)
        io.stdout(
          "接入检查通过；未启用远程派发。MCP 已验证 HTTPS 可达和未鉴权拒绝，启动鉴权由运行目标检查负责。",
        );
      return passed ? EXIT.ok : EXIT.failure;
    } finally {
      store.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      error instanceof WorkerOnboardingError
        ? error.code
        : "worker_operation_failed",
      EXIT.failure,
      [
        error instanceof WorkerOnboardingError &&
        [
          "worker_config_changed",
          "worker_config_confirmation_invalid",
        ].includes(error.code) &&
        digest
          ? `核对私有配置与现有运行目标；确认后执行 cardigan worker resume --project ${project} --machine ${machine}${[
              "config",
              "data-dir",
            ]
              .filter((name) => flags[name])
              .map(
                (name) =>
                  ` --${name} '${flags[name]?.replaceAll("'", "'\\''")}'`,
              )
              .join(
                "",
              )} --confirm-config ${digest}。旧记录留档，所有步骤重新检查；运行配置不自动改写。`
          : "参见 docs/linux-worker.md 或 docs/macos-worker.md；核对私有配置和权限后重试。",
      ],
    );
  }
}
