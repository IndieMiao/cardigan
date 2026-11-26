import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { connect } from "node:net";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  DeploymentBuild,
  DeploymentConfigTrial,
  DeploymentDriver,
  DeploymentOperation,
  DeploymentRecord,
} from "@cardigan/domain";
import { currentDeploymentPin } from "@cardigan/domain";
import { gitSafetyArguments } from "@cardigan/git-transport";
import type { Store } from "@cardigan/store";
import {
  deploymentMergeSegments,
  readInterruptedDeployment,
  readReadyRetry,
  writeDeferredOperations,
  writeDeploymentRecord,
  writeDeploymentStop,
  writeInterruptedOperations,
  writeOperationWait,
  writeServerLogAudit,
  writeSupervisorComparison,
  writeSupervisorComparisonUnavailable,
} from "./deployment-audit.js";
import {
  acquireDeploymentCapacity,
  releaseDeploymentWait,
} from "./deployment-capacity.js";
import {
  DEFAULT_CAPACITY_WAIT_TIMEOUT_MS,
  DEFAULT_EVIDENCE_WAIT_TIMEOUT_MS,
  type DeploymentConfig,
  deploymentDirectory,
  requireHostDirectory,
} from "./deployment-config.js";
import { DeploymentBuildLog, DeploymentServerReady } from "./deployment-log.js";
import { maintenanceActive } from "./deployment-maintenance.js";
import { DeploymentRetention } from "./deployment-retention.js";
import {
  DeploymentServerLog,
  taggedServerOutput,
} from "./deployment-server-log.js";
import { supervisorChanges } from "./deployment-supervisor-scope.js";
import {
  nodeSystemdCommand,
  SharedCapacityWait,
  type SupervisorUpgradeConfig,
  SupervisorUpgrader,
  type SupervisorUpgradeStep,
} from "./deployment-supervisor-upgrade.js";
import {
  type HostConfigCheck,
  hostConfigFingerprint,
  snapshotHostConfig,
} from "./host-config-check.js";
import {
  fenceLongOperations,
  liveLongOperations,
  releaseLongOperationFence,
} from "./long-operations.js";
import { type ExecutionOwner, executionOwner } from "./process-identity.js";
import { acquireRepositoryFlock } from "./repository-lock.js";

const exec = promisify(execFile);
const CONFIG_TRIAL_MARKER = "CARDIGAN_HOST_CONFIG_CHECK";
const PROJECT = "cardigan";
/** Backoff for a failing supervisor comparison of one unchanged main. */
const SUPERVISOR_RETRY_MS = 10 * 60_000;
/** Must hash exactly like deploymentRolePolicyHash, or every default looks hand-edited. */
export const ROLE_PACK_SNAPSHOT_SCRIPT = `import { pathToFileURL } from 'node:url';
  import { createHash } from 'node:crypto';
  const m = await import(pathToFileURL(process.argv[1]).href);
  const values = Object.fromEntries(Object.keys(m.DEFAULT_ROLE_KINDS).map(id => {
    const r = m.defaultRoleDefinition(id, { harness: 'codex', launch_profile_ref: 'deployment' });
    const p = { instructions: r.instructions, allowed_tools: [...r.allowed_tools].sort(),
      capabilities: [...r.capabilities].sort(), kind: r.kind, worktree: r.worktree,
      ...(r.required_capabilities?.length
        ? { required_capabilities: [...r.required_capabilities].sort() } : {}) };
    return [id, createHash('sha256').update(JSON.stringify(p)).digest('hex')];
  }));
  process.stdout.write(JSON.stringify(values));`;
/** C-767: the new checkout must read the host configuration it will run with. */
export const SUPERVISOR_CONFIG_CHECK_SCRIPT = `import { pathToFileURL } from 'node:url';
  const m = await import(pathToFileURL(process.argv[1]).href);
  await m.loadDeploymentConfig(process.argv[2]);
  if (typeof m.loadSupervisorUpgradeConfig !== 'function') process.exit(3);
  await m.loadSupervisorUpgradeConfig(process.argv[2]);`;
/**
 * C-792: the new checkout loads the private copy of the host configuration.
 * Releases without the checker (an older human pin) exit 3 and are not held.
 */
export const HOST_CONFIG_TRIAL_SCRIPT = `import { pathToFileURL } from 'node:url';
  const m = await import(pathToFileURL(process.argv[1]).href);
  if (typeof m.checkHostConfig !== 'function') process.exit(3);
  const result = await m.checkHostConfig({ configDir: process.argv[2],
    dataDir: process.argv[3], projects: JSON.parse(process.argv[4]) });
  process.stdout.write('\\n${CONFIG_TRIAL_MARKER} ' + JSON.stringify(result) + '\\n');`;
class DeploymentCommandUnavailable extends Error {}
interface State {
  current: DeploymentBuild;
  previous?: DeploymentBuild;
  running?: DeploymentBuild;
  process?: ExecutionOwner;
  background?: ExecutionOwner;
  dual?: boolean;
  ready?: boolean;
  fence?: 1 | 2;
  backup_file?: string;
}

/** Own child handles plus boot/start identity; never search cmdline or signal by name. */
export class NodeDeploymentDriver implements DeploymentDriver {
  readonly enabled: boolean;
  readonly batchWindowMs: number;
  readonly operationWaitMs: number;
  readonly readyRetryMax: number | undefined;
  readonly readyRetryIntervalMs: number | undefined;
  private state!: State;
  private readonly retention?: DeploymentRetention;
  private readyMessage = false;
  private backgroundReady = false;
  private launchBackground: (() => Promise<void>) | undefined;
  private backgroundChild: ChildProcess | undefined;
  private serverLog = new DeploymentBuildLog();
  private spawnFailed = false;
  private child: ChildProcess | undefined;
  private readonly childCloses = new WeakMap<ChildProcess, Promise<void>>();
  private serverFailureRecorded = false;
  private serverLogFinished: Promise<void> = Promise.resolve();
  private readonly directory: string;
  private readonly central: string;
  private readonly ports: readonly number[];
  private readonly buildEnv: NodeJS.ProcessEnv;
  private supervisorSha: string | null | undefined;
  private checkedSupervisorMain: string | undefined;
  private failedSupervisorMain?: string;
  private supervisorRetry?: { sha: string; at: number };
  private lastOperationWait: string | undefined;
  private notedOperations = new Set<string>();
  private upgrader: SupervisorUpgrader | undefined;
  private readonly capacityWait = new SharedCapacityWait(() =>
    releaseDeploymentWait(this.options.store),
  );
  constructor(
    private readonly options: {
      store: Store;
      dataDir: string;
      config: DeploymentConfig;
      env: NodeJS.ProcessEnv;
      /** C-767: absent (the default) keeps the human upgrade reminder only. */
      upgrade?: { config: SupervisorUpgradeConfig; configDir: string };
      /** C-792: host configuration the new build must load before a switch. */
      configDir?: string;
    },
  ) {
    this.enabled = options.config.enabled;
    // Defaults are applied by parseDeploymentConfig; a hand-built config opts out.
    this.batchWindowMs = options.config.batch_window_ms ?? 0;
    this.operationWaitMs = options.config.operation_wait_timeout_ms ?? 0;
    // C-650: likewise, a hand-built config keeps the legacy in-memory failure.
    this.readyRetryMax = options.config.ready_retry_max;
    this.readyRetryIntervalMs = options.config.ready_retry_interval_ms;
    this.directory = deploymentDirectory(options.dataDir);
    if (options.config.retention)
      this.retention = new DeploymentRetention(
        options.store,
        this.directory,
        options.config.retention,
      );
    this.central = join(options.dataDir, "central", `${PROJECT}.git`);
    this.ports = [
      Number(options.env.CARDIGAN_MCP_PORT ?? 3004),
      Number(options.env.CARDIGAN_WEB_PORT ?? 7781),
    ];
    if (
      this.ports.some((p) => !Number.isSafeInteger(p) || p < 1 || p > 65535) ||
      this.ports[0] === this.ports[1]
    )
      throw new Error("部署必须配置两个不同的固定端口");
    this.buildEnv = {
      PATH: options.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
    };
  }

  /** Keep this lock for the whole supervisor lifetime, including idle ticks. */
  async initialize(): Promise<() => Promise<void>> {
    await this.preflight();
    await requireHostDirectory(this.options.dataDir);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new Error("Unsafe deployment directory");
    const unlock = await acquireRepositoryFlock(
      join(this.directory, "supervisor.lock"),
      1,
    );
    let releaseCapacity: (() => void) | undefined;
    const release = () => {
      const held = releaseCapacity;
      releaseCapacity = undefined;
      held?.();
      releaseDeploymentWait(this.options.store);
    };
    let interrupted: DeploymentRecord | undefined;
    let startupStage: "start" | "ready" | undefined;
    let recoveringAt = Date.now();
    try {
      releaseCapacity = acquireDeploymentCapacity(this.options.store);
      if (!releaseCapacity)
        throw new Error("Merge checks are active; server retained");
      const saved = await this.readState();
      this.state = saved ?? {
        current: {
          sha: this.options.config.initial_sha,
          release: await realpath(this.options.config.initial_release),
        },
      };
      if (
        !saved &&
        !(await this.isFastForward(this.state.current.sha, await this.main()))
      )
        throw new Error("Initial deployment must belong to central main");
      await requireHostDirectory(this.state.current.release);
      const initial = await lstat(this.state.current.release);
      if (
        !initial.isDirectory() ||
        ![0, process.getuid?.()].includes(initial.uid) ||
        initial.mode & 0o022
      )
        throw new Error("Unsafe initial deployment");
      if (
        (
          await this.git([
            "cat-file",
            "-e",
            `${this.state.current.sha}^{commit}`,
          ])
        ).code !== 0
      )
        throw new Error(
          "Initial release is absent from the central repository",
        );
      const head = await this.command(
        "git",
        [
          ...gitSafetyArguments,
          "-C",
          this.state.current.release,
          "rev-parse",
          "--verify",
          "HEAD",
        ],
        this.directory,
        this.gitEnv(),
      );
      if (head.code !== 0 || head.text.trim() !== this.state.current.sha)
        throw new Error("Initial checkout does not match the deployed SHA");
      if (
        (
          await this.command(
            "git",
            [
              ...gitSafetyArguments,
              "-C",
              this.state.current.release,
              "diff",
              "--quiet",
              "HEAD",
              "--",
            ],
            this.directory,
            this.gitEnv(),
          )
        ).code !== 0
      )
        throw new Error(
          "Deployed checkout contains uncommitted source changes",
        );
      if (this.anyLive()) {
        for (const role of ["web", "background"] as const)
          if (this.live(role)) await this.verifyProcess(role);
        if (
          !this.state.ready ||
          this.state.fence !== (this.state.dual ? 2 : 1) ||
          !this.live() ||
          (this.state.dual && !this.live("background")) ||
          this.state.running?.sha !== this.state.current.sha
        ) {
          // Persist a new recovery snapshot before stopping an unconfirmed candidate.
          interrupted = await this.beforeStop({
            attempt: randomUUID(),
            from: this.state.current.sha,
            to: this.state.running?.sha ?? this.state.current.sha,
            status: "started",
            build: "passed",
            ready: false,
            downtime_ms: 0,
            summary: "监督器恢复未完成的切换",
            ...(this.state.backup_file
              ? { backup_file: this.state.backup_file }
              : {}),
          });
          recoveringAt = Date.now();
          await this.stop();
          startupStage = "start";
          await this.start(this.state.current);
        } else {
          this.readyMessage = true;
          this.backgroundReady = Boolean(this.state.dual);
        }
      } else {
        // stop() clears the old process before backup/start. The stop audit
        // still identifies that candidate even if no candidate was spawned.
        const pending =
          saved &&
          readInterruptedDeployment(
            this.options.store,
            PROJECT,
            this.state.current.sha,
          );
        if (
          pending ||
          (saved?.running && saved.running.sha !== saved.current.sha)
        ) {
          interrupted = {
            ...(pending ?? {
              attempt: randomUUID(),
              from: this.state.current.sha,
              to: saved.running?.sha ?? this.state.current.sha,
              status: "started",
              build: "passed",
              ready: false,
              downtime_ms: 0,
              summary: "监督器恢复未完成的切换",
            }),
            ...(this.state.backup_file
              ? { backup_file: this.state.backup_file }
              : {}),
          };
          recoveringAt = Date.now();
        }
        this.state = {
          current: this.state.current,
          ...(this.state.previous ? { previous: this.state.previous } : {}),
          ...(this.state.backup_file
            ? { backup_file: this.state.backup_file }
            : {}),
        };
        startupStage = "start";
        await this.start(this.state.current);
      }
      startupStage = "ready";
      if (!(await this.ready()))
        throw new Error(
          `Initial server did not become ready；${this.serverDiagnostics("ready")}`,
        );
      startupStage = undefined;
      if (interrupted) {
        await this.record({
          ...interrupted,
          status: "rolled_back",
          build: "passed",
          ready: true,
          downtime_ms: Date.now() - recoveringAt,
          summary: "监督器恢复未完成切换，已恢复上一构建",
        });
        // Keep the link until the recovery audit is durable, then prevent an
        // older backup from being attributed to a later interrupted candidate.
        delete this.state.backup_file;
        await this.saveState();
      }
      try {
        release();
      } catch {
        throw new Error("deployment_capacity_release_failed");
      }
      return unlock;
    } catch (error) {
      const log = startupStage
        ? this.serverDiagnostics(startupStage)
        : undefined;
      const safeFailure = startupStage
        ? `startup_${startupStage}_failed；${log}`
        : "recovery_failed";
      const cleanupFailures: string[] = [];
      if (this.child?.pid || this.backgroundChild?.pid) {
        try {
          await this.stop();
        } catch {
          cleanupFailures.push("deployment_stop_unconfirmed");
        }
      }
      if (interrupted || startupStage) {
        try {
          await this.record({
            ...(interrupted ?? {
              attempt: randomUUID(),
              from: this.state.current.sha,
              to: this.state.current.sha,
              ...(this.state.backup_file
                ? { backup_file: this.state.backup_file }
                : {}),
            }),
            status: "failed",
            build: "passed",
            ready: false,
            downtime_ms: Date.now() - recoveringAt,
            summary: "监督器恢复未完成，需主机核对进程与数据库备份",
            ...(startupStage && log !== undefined
              ? { failure_stage: startupStage, log_tail: log }
              : {}),
          });
        } catch {
          // Preserve the safe startup outcome, never the raw IO/audit errors.
          cleanupFailures.push("deployment_audit_failed：部署失败审计未保存");
        }
      }
      try {
        await this.finishServerLogs();
      } catch {
        cleanupFailures.push("deployment_log_cleanup_failed");
      }
      try {
        await unlock();
      } catch {
        cleanupFailures.push("deployment_unlock_failed");
      }
      try {
        release();
      } catch {
        cleanupFailures.push("deployment_capacity_release_failed");
      }
      if (cleanupFailures.length) {
        throw new Error(`${safeFailure}；${cleanupFailures.join("；")}`);
      }
      throw error;
    }
  }

  now() {
    return Date.now();
  }
  /** Inspect executable availability without invoking hc or connecting to any session. */
  private async preflight() {
    if (!this.options.env.CARDIGAN_HC_SESSION?.trim())
      throw new Error(
        "自动部署未启动：必须显式设置 CARDIGAN_HC_SESSION，避免误连默认会话",
      );
    for (const command of ["hc", "pnpm", "git"]) {
      let found = false;
      for (const directory of (this.options.env.PATH ?? "").split(delimiter)) {
        if (!directory) continue;
        try {
          const path = join(directory, command);
          await access(path, constants.X_OK);
          // Follow normal PATH symlinks, but never count a directory as a command.
          const target = await lstat(await realpath(path));
          if (target.isFile()) {
            found = true;
            break;
          }
        } catch {
          /* Only the fixed command name may appear in the error. */
        }
      }
      if (!found)
        throw new Error(
          `自动部署未启动：PATH 中缺少可执行命令 ${command}，请在主机单元中显式配置 PATH`,
        );
    }
  }
  async maintenanceActive() {
    return this.options.store.uow.read(() =>
      maintenanceActive(this.options.store),
    );
  }
  async checkServer() {
    if (this.live() && (!this.state.dual || this.live("background"))) {
      await this.verifyProcess();
      if (this.state.dual) await this.verifyProcess("background");
      return;
    }
    this.readyMessage = false;
    this.state.ready = false;
    if (!this.live()) delete this.state.process;
    if (!this.live("background")) delete this.state.background;
    await this.saveState();
    if (!this.serverFailureRecorded) {
      await this.record({
        attempt: randomUUID(),
        from: this.state.current.sha,
        to: this.state.current.sha,
        status: "failed",
        build: "not_run",
        ready: false,
        downtime_ms: 0,
        summary: "server_exited；监督器退出，由主机服务管理器恢复已部署构建",
      });
      this.serverFailureRecorded = true;
    }
    throw new Error("Server exited");
  }
  async beforeStop(
    record: DeploymentRecord,
    interrupted: readonly DeploymentOperation[] = [],
  ) {
    const stopping = writeDeploymentStop(this.options.store, PROJECT, record);
    if (interrupted.length)
      try {
        writeInterruptedOperations(
          this.options.store,
          record.attempt,
          interrupted,
        );
      } catch {
        // Card notes are informational; the project audit keeps the counts.
      }
    return stopping;
  }
  async operations() {
    return liveLongOperations(this.options.store);
  }
  async fenceOperations() {
    return fenceLongOperations(this.options.store);
  }
  async releaseOperationFence() {
    releaseLongOperationFence(this.options.store);
  }
  async waitForOperations(
    record: DeploymentRecord,
    operations: readonly DeploymentOperation[] = [],
  ) {
    // Each source card hears once per operation that a deployment waits for it.
    const fresh = operations.filter((op) => !this.notedOperations.has(op.id));
    this.notedOperations = new Set(operations.map((op) => op.id));
    if (fresh.length)
      try {
        writeDeferredOperations(this.options.store, record.attempt, fresh);
      } catch {
        /* Card notes are informational; the wait stays bounded. */
      }
    // Ticks repeat the same observation; skip the state load when unchanged.
    const key = JSON.stringify([
      record.status,
      record.from,
      record.to,
      record.deferred_operations ?? [],
    ]);
    if (this.lastOperationWait === key) return;
    writeOperationWait(this.options.store, PROJECT, record);
    this.lastOperationWait = key;
  }
  async current() {
    return this.state.current;
  }
  async main() {
    const result = await this.git([
      "rev-parse",
      "--verify",
      "refs/heads/main^{commit}",
    ]);
    const sha = result.text.trim();
    if (result.code !== 0 || !/^[a-f0-9]{40}$/u.test(sha))
      throw new Error("Central main unavailable");
    if (this.supervisorSha === undefined) {
      const root = fileURLToPath(new URL("../../../", import.meta.url));
      const version = await this.command(
        "git",
        [...gitSafetyArguments, "-C", root, "rev-parse", "--verify", "HEAD"],
        this.central,
        this.gitEnv(),
      );
      this.supervisorSha =
        version.code === 0 && /^[a-f0-9]{40}$/u.test(version.text.trim())
          ? version.text.trim()
          : null;
      if (this.supervisorSha && this.options.upgrade?.config.enabled)
        this.upgrader = new SupervisorUpgrader(
          this.upgradeHost(await realpath(resolve(root)), this.supervisorSha),
          this.options.upgrade.config,
        );
    }
    const supervisor = this.supervisorSha;
    if (
      supervisor &&
      this.checkedSupervisorMain !== sha &&
      // C-670: a failing comparison of the same main retries at most every
      // SUPERVISOR_RETRY_MS instead of re-reading Git and lockfiles each tick.
      !(
        this.supervisorRetry?.sha === sha &&
        performance.now() < this.supervisorRetry.at
      ) &&
      (supervisor === sha || (await this.isFastForward(supervisor, sha)))
    ) {
      try {
        const affected = await supervisorChanges(supervisor, sha, (args) =>
          this.readSupervisorGit(args),
        );
        // C-767: with the switch on, the supervisor upgrades itself instead.
        writeSupervisorComparison(
          this.options.store,
          supervisor,
          sha,
          affected,
          this.upgrader?.automatic(supervisor, sha, affected) ?? false,
        );
        this.checkedSupervisorMain = sha;
      } catch {
        this.supervisorRetry = {
          sha,
          at: performance.now() + SUPERVISOR_RETRY_MS,
        };
        // An unavailable comparison is neither upgrade evidence nor proof that an open notice is obsolete.
        if (this.failedSupervisorMain !== sha) {
          console.warn("未能核对部署监督器差异；保留现有提醒，下轮重试");
          try {
            writeSupervisorComparisonUnavailable(
              this.options.store,
              supervisor,
              sha,
            );
            this.failedSupervisorMain = sha;
          } catch {
            // Retry a failed audit too; notice bookkeeping must not block deployment.
          }
        }
      }
    }
    return sha;
  }
  async target() {
    const main = await this.main();
    const pin = this.options.store.uow.read((tx) =>
      currentDeploymentPin(tx.events.listAfter(PROJECT, undefined, 0)),
    );
    if (!pin) return { sha: main };
    if (
      !(await this.isFastForward(pin.sha, main)) ||
      (await this.git(["rev-parse", `${pin.sha}^{tree}`])).text.trim() !==
        pin.tree
    )
      throw new Error("人工固定版本的中心 Git 证据已失效");
    return { sha: pin.sha, control_event_id: pin.event_id };
  }
  async isFastForward(from: string, to: string) {
    return (
      (await this.git(["merge-base", "--is-ancestor", from, to])).code === 0
    );
  }
  async passedMergeGate(from: string, to: string) {
    const segments = await deploymentMergeSegments(
      this.options.store,
      PROJECT,
      from,
      to,
      async (start, end) =>
        (await this.isFastForward(start, from)) &&
        (await this.isFastForward(from, end)),
    );
    if (!segments) return false;
    for (const s of segments) {
      if (
        !(await this.isFastForward(s.previous, s.sha)) ||
        (await this.git(["rev-parse", `${s.sha}^{tree}`])).text.trim() !==
          s.tree
      )
        return false;
    }
    return true;
  }
  async waitForEvidence(record: DeploymentRecord) {
    writeDeploymentRecord(this.options.store, PROJECT, record, {
      timeout_ms:
        this.options.config.evidence_wait_timeout_ms ??
        DEFAULT_EVIDENCE_WAIT_TIMEOUT_MS,
      now: this.now(),
    });
  }
  async releaseCapacityWait() {
    this.capacityWait.set("deploy", false);
  }
  async waitForCapacity(record: DeploymentRecord) {
    this.capacityWait.set("deploy", true);
    const blocking_checks = this.options.store.database
      .prepare(
        "SELECT project_id AS project, attempt_id AS attempt FROM merge_check_capacity ORDER BY project_id, attempt_id",
      )
      .all() as { project: string; attempt: string }[];
    writeDeploymentRecord(
      this.options.store,
      PROJECT,
      {
        ...record,
        blocking_checks,
        summary: `${record.summary}；阻塞检查：${blocking_checks.map((check) => `${check.project}/${check.attempt}`).join("、") || "另一个部署持有者"}`,
      },
      {
        timeout_ms:
          this.options.config.capacity_wait_timeout_ms ??
          DEFAULT_CAPACITY_WAIT_TIMEOUT_MS,
        now: this.now(),
      },
    );
  }
  async acquire() {
    const release = acquireDeploymentCapacity(this.options.store);
    return release
      ? async () => {
          release();
        }
      : undefined;
  }
  async migrationsChanged(from: string, to: string) {
    const result = await this.git([
      "diff",
      "--name-only",
      from,
      to,
      "--",
      "packages/store",
    ]);
    if (result.code !== 0) throw new Error("Cannot compare migrations");
    // Store migration helpers can change outside migrations/*.sql as well.
    return result.text.trim().length > 0;
  }
  async build(sha: string) {
    if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Invalid deployment SHA");
    return this.checkout(
      sha,
      join(this.directory, `release-${sha}-${randomUUID()}`),
    );
  }
  private async checkout(sha: string, release: string) {
    let stage: "checkout" | "install" | "build" = "checkout";
    let log = new DeploymentBuildLog();
    try {
      const clone = await this.command(
        "git",
        [
          ...gitSafetyArguments,
          "clone",
          "--no-hardlinks",
          "--no-checkout",
          "--",
          this.central,
          release,
        ],
        this.directory,
        this.gitEnv(),
      );
      if (clone.code !== 0)
        return { log_tail: `checkout: exit ${clone.code ?? "unknown"}` };
      await chmod(release, 0o700);
      const checkout = await this.command(
        "git",
        [...gitSafetyArguments, "-C", release, "checkout", "--detach", sha],
        this.directory,
        this.gitEnv(),
      );
      if (checkout.code !== 0)
        return { log_tail: `checkout: exit ${checkout.code ?? "unknown"}` };
      for (const nextStage of ["install", "build"] as const) {
        stage = nextStage;
        log = new DeploymentBuildLog();
        const args =
          stage === "install" ? ["install", "--frozen-lockfile"] : ["build"];
        const result = await this.command(
          "pnpm",
          args,
          release,
          this.buildEnv,
          (chunk) => log.append(chunk),
        );
        const log_tail = log.finish(stage, result.code);
        if (result.code !== 0) return { log_tail };
      }
      return {
        build: { sha, release },
        log_tail: "install: exit 0\nbuild: exit 0",
      };
    } catch (error) {
      if (!(error instanceof DeploymentCommandUnavailable)) throw error;
      return {
        log_tail:
          stage === "checkout"
            ? "checkout: spawn_failed"
            : log.finish(stage, "spawn_failed"),
      };
    }
  }

  /** C-792: never the real directory; the trial copy is removed afterwards. */
  async checkConfig(build: DeploymentBuild): Promise<DeploymentConfigTrial> {
    const configDir = this.options.configDir;
    if (!configDir) return { ok: true, errors: [] };
    const trial = join(this.directory, `config-trial-${randomUUID()}`);
    await mkdir(trial, { mode: 0o700 });
    try {
      await chmod(trial, 0o700);
      const snapshot = await snapshotHostConfig(configDir, trial);
      const { fingerprint } = snapshot;
      if (snapshot.errors.length)
        return { ok: false, errors: snapshot.errors, fingerprint };
      const projects = this.options.store
        .listProjects()
        .map((p) => ({ id: p.id, base_branch: p.base_branch ?? "main" }));
      const result = await this.command(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          HOST_CONFIG_TRIAL_SCRIPT,
          join(build.release, "packages/host/dist/index.js"),
          trial,
          this.options.dataDir,
          JSON.stringify(projects),
        ],
        build.release,
        this.buildEnv,
      );
      if (result.code === 3) return { ok: true, errors: [], fingerprint };
      const line = result.text
        .split("\n")
        .findLast((l) => l.startsWith(`${CONFIG_TRIAL_MARKER} `));
      if (result.code !== 0 || !line)
        return { ok: false, errors: ["主机配置试加载未能运行"] };
      const check = JSON.parse(
        line.slice(CONFIG_TRIAL_MARKER.length + 1),
      ) as HostConfigCheck;
      return {
        ok: check.ok === true,
        errors: check.files.flatMap((f) =>
          f.errors.map((error) => `${f.file}：${error}`),
        ),
        fingerprint,
      };
    } finally {
      await rm(trial, { recursive: true, force: true });
    }
  }
  async configFingerprint(): Promise<string | undefined> {
    const configDir = this.options.configDir;
    if (!configDir) return undefined;
    try {
      return await hostConfigFingerprint(configDir);
    } catch {
      return undefined;
    }
  }

  /** C-767: one step of the optional automatic supervisor upgrade. */
  async upgradeSupervisor(): Promise<SupervisorUpgradeStep> {
    return this.upgrader ? this.upgrader.step() : "idle";
  }
  /** C-767: deployment ticks pause while the restart helper takes over. */
  get supervisorRestarting(): boolean {
    return this.upgrader?.restarting ?? false;
  }
  private portTargets() {
    const mcp = this.options.env.CARDIGAN_MCP_HOST ?? "";
    return [
      {
        host: ["::1", "localhost"].includes(mcp) ? mcp : "127.0.0.1",
        port: this.ports[0] as number,
      },
      { host: "127.0.0.1", port: this.ports[1] as number },
    ];
  }
  private upgradeHost(root: string, supervisor: string) {
    const upgrade = this.options.upgrade;
    if (!upgrade) throw new Error("Supervisor upgrade is not configured");
    const systemctl = nodeSystemdCommand("systemctl", this.options.env);
    const systemdRun = nodeSystemdCommand("systemd-run", this.options.env);
    return {
      store: this.options.store,
      directory: this.directory,
      configDir: upgrade.configDir,
      root,
      supervisor,
      idleDeployment: async () => {
        const s = this.state;
        if (
          !s.ready ||
          s.running?.sha !== s.current.sha ||
          s.fence !== (s.dual ? 2 : 1) ||
          !this.live() ||
          (s.dual && !this.live("background")) ||
          (await this.maintenanceActive())
        )
          return undefined;
        return s.current.sha;
      },
      checkout: async (sha: string, release: string) => {
        const result = await this.checkout(sha, release);
        return { ok: Boolean(result.build), log_tail: result.log_tail };
      },
      validate: async (release: string) => {
        try {
          await access(join(release, "apps/cli/dist/bin.js"), constants.R_OK);
          const result = await this.command(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              SUPERVISOR_CONFIG_CHECK_SCRIPT,
              join(release, "packages/host/dist/index.js"),
              upgrade.configDir,
            ],
            release,
            this.buildEnv,
          );
          return result.code === 0;
        } catch {
          return false;
        }
      },
      systemctl,
      launchHelper: async (attempt: string, from: string) =>
        (
          await systemdRun([
            "--user",
            "--collect",
            "--quiet",
            `--unit=cardigan-supervisor-upgrade-${attempt.slice(0, 8)}`,
            `--setenv=CARDIGAN_DATA_DIR=${this.options.dataDir}`,
            `--setenv=PATH=${this.buildEnv.PATH}`,
            ...(this.options.env.XDG_RUNTIME_DIR
              ? [`--setenv=XDG_RUNTIME_DIR=${this.options.env.XDG_RUNTIME_DIR}`]
              : []),
            "--",
            process.execPath,
            join(from, "apps/cli/dist/bin.js"),
            "self-deploy",
            "finish-upgrade",
          ])
        ).code === 0,
      ports: () => this.portTargets(),
      server: () => this.state.process,
      recheck: () => {
        this.checkedSupervisorMain = undefined;
      },
      capacityWaiting: (waiting: boolean) =>
        this.capacityWait.set("upgrade", waiting),
      now: () => this.now(),
    };
  }

  async backup() {
    const name = `database-${randomUUID()}.bak`;
    const path = join(this.directory, name);
    // SQLite-consistent backup, including WAL contents; no shell copy.
    this.options.store.database.prepare("VACUUM INTO ?").run(path);
    await chmod(path, 0o600);
    this.state.backup_file = name;
    await this.saveState();
    return name;
  }
  private identity(role: "web" | "background") {
    return role === "web" ? this.state.process : this.state.background;
  }
  private live(role: "web" | "background" = "web") {
    const owner = this.identity(role);
    return Boolean(owner && executionOwner(owner.pid)?.start === owner.start);
  }
  private anyLive() {
    return this.live() || this.live("background");
  }
  private async verifyProcess(role: "web" | "background" = "web") {
    const identity = this.identity(role);
    if (!identity || !this.state.running || !this.live(role))
      throw new Error("Server identity unavailable");
    const [stat, cwd, exe, argv] = await Promise.all([
      lstat(`/proc/${identity.pid}`),
      readlink(`/proc/${identity.pid}/cwd`),
      readlink(`/proc/${identity.pid}/exe`),
      readFile(`/proc/${identity.pid}/cmdline`, "utf8"),
    ]);
    if (
      stat.uid !== process.getuid?.() ||
      cwd !== this.state.running.release ||
      exe !== (await realpath(process.execPath)) ||
      argv.split("\0")[1] !==
        join(
          this.state.running.release,
          `apps/server/dist/${role === "web" ? "bin" : "background-bin"}.js`,
        ) ||
      !this.live(role)
    )
      throw new Error("Server process identity mismatch");
  }
  private signalServer(signal: NodeJS.Signals, role: "web" | "background") {
    const identity = this.identity(role);
    if (!identity) throw new Error("Server identity unavailable");
    try {
      process.kill(identity.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH" || this.live(role))
        throw error;
    }
  }
  async stop() {
    this.launchBackground = undefined;
    // Keep every identity until BOTH exits are proven. Partial stop/recovery must
    // never forget a surviving background owner and start a second dispatcher.
    for (const role of ["background", "web"] as const)
      if (this.live(role)) await this.verifyProcess(role);
    for (const role of ["background", "web"] as const) {
      if (!this.live(role)) continue;
      await this.verifyProcess(role);
      this.signalServer("SIGTERM", role);
    }
    const deadline = Date.now() + this.options.config.stop_timeout_ms;
    while (this.anyLive() && Date.now() < deadline) await delay(50);
    for (const role of ["background", "web"] as const) {
      if (!this.live(role)) continue;
      await this.verifyProcess(role);
      this.signalServer("SIGKILL", role);
    }
    const killed = Date.now() + this.options.config.stop_timeout_ms;
    while (this.anyLive() && Date.now() < killed) await delay(50);
    if (this.anyLive()) throw new Error("Server exit unconfirmed");
    this.state = {
      current: this.state.current,
      ...(this.state.previous ? { previous: this.state.previous } : {}),
      ...(this.state.backup_file
        ? { backup_file: this.state.backup_file }
        : {}),
    };
    await this.saveState();
  }

  /** Supervisor teardown only: keep audit/lock resources until stopped output drains. */
  async finishServerLogs(): Promise<void> {
    // Failed shutdown may leave a live server. Preserve that failure path rather
    // than waiting indefinitely for its pipes to close. stop()/rollback never
    // wait for logging IO; normal supervisor teardown calls this after stop().
    if (this.state && this.anyLive()) return;
    await this.serverLogFinished;
  }

  async start(build: DeploymentBuild) {
    if (this.anyLive()) throw new Error("A server is already running");
    let dual = false;
    try {
      await access(join(build.release, "apps/server/dist/background-bin.js"));
      dual = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.state = {
      current: this.state.current,
      ...(this.state.previous ? { previous: this.state.previous } : {}),
      ...(this.state.backup_file
        ? { backup_file: this.state.backup_file }
        : {}),
      running: build,
      dual,
      ready: false,
    };
    this.backgroundReady = false;
    this.launchBackground = undefined;
    this.backgroundChild = undefined;
    this.readyMessage = false;
    this.serverLog = new DeploymentBuildLog();
    this.spawnFailed = false;
    this.serverFailureRecorded = false;
    const {
      server_log_max_bytes: maxBytes,
      server_log_max_files: maxFiles,
      server_log_retention_hours: hours,
    } = this.options.config;
    const log =
      maxBytes !== undefined && maxFiles !== undefined
        ? new DeploymentServerLog(
            this.directory,
            build.sha,
            {
              maxBytes,
              maxFiles,
              ...(hours === undefined
                ? {}
                : { retentionMs: hours * 3_600_000 }),
            },
            (entry) => writeServerLogAudit(this.options.store, entry),
            this.serverLogFinished,
          )
        : undefined;
    if (log) this.serverLogFinished = log.finished;
    let children = 0;
    let starting = true;
    const closed = () => {
      if (!starting && children === 0) void log?.close();
    };
    await this.saveState();
    const spawn = async (role: "web" | "background") => {
      children++;
      await this.spawnRole(
        build,
        role,
        dual
          ? taggedServerOutput((data) => log?.append(data), role)
          : (data) => log?.append(data),
        () => {
          children--;
          closed();
        },
      );
    };
    try {
      await spawn("web");
      if (dual) this.launchBackground = () => spawn("background");
    } finally {
      starting = false;
      closed();
    }
  }

  private async spawnRole(
    build: DeploymentBuild,
    role: "web" | "background",
    output: (data: Buffer, stream: "stdout" | "stderr") => void,
    closed: () => void,
  ) {
    if (role === "web") this.readyMessage = false;
    const diagnostics = this.serverLog;
    const child = spawn(
      process.execPath,
      [
        join(
          build.release,
          `apps/server/dist/${role === "web" ? "bin" : "background-bin"}.js`,
        ),
      ],
      {
        cwd: build.release,
        env: {
          ...this.options.env,
          CARDIGAN_DATA_DIR: this.options.dataDir,
          ...(this.state.dual ? { CARDIGAN_SUPERVISED: "1" } : {}),
        },
        stdio: this.state.dual
          ? ["ignore", "pipe", "pipe", "ipc"]
          : ["ignore", "pipe", "pipe"],
      },
    );
    if (role === "web") this.child = child;
    else this.backgroundChild = child;
    child.on("error", () => {
      if (this.child === child || this.backgroundChild === child)
        this.spawnFailed = true;
    });
    child.once("exit", () => {
      if (this.child === child) this.readyMessage = false;
      if (this.backgroundChild === child) this.backgroundReady = false;
    });
    // Close only after both pipes drain, including the old generation's final output.
    this.childCloses.set(
      child,
      new Promise<void>((resolve) => {
        child.once("close", () => {
          closed();
          resolve();
        });
      }),
    );
    child.stderr?.on("data", (data: Buffer) => {
      output(data, "stderr");
      diagnostics.append(data.toString("utf8"));
    });
    const readyOutput = new DeploymentServerReady(
      this.ports,
      this.state.dual ? role : undefined,
    );
    child.stdout?.on("data", (data: Buffer) => {
      output(data, "stdout");
      diagnostics.append(data.toString("utf8"));
      if (
        (this.child !== child && this.backgroundChild !== child) ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        return;
      if (readyOutput.append(data)) {
        if (role === "web") this.readyMessage = true;
        else this.backgroundReady = true;
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("Server spawn failed")));
    });
    const owner = child.pid && executionOwner(child.pid);
    if (!owner) throw new Error("Server incarnation unavailable");
    if (role === "web") this.state.process = owner;
    else this.state.background = owner;
    await this.saveState();
    if (this.state.dual)
      await new Promise<void>((resolve, reject) => {
        child.send("start", (error) =>
          error
            ? reject(new Error("Server launch handshake failed"))
            : resolve(),
        );
      });
  }
  async ready() {
    const deadline = Date.now() + this.options.config.ready_timeout_ms;
    while (this.live() && Date.now() < deadline) {
      if (
        this.readyMessage &&
        (
          await Promise.all(this.ports.map((port) => this.portReady(port)))
        ).every(Boolean)
      ) {
        await this.verifyProcess();
        // Both listeners of this exact Web incarnation are ready before a
        // background process can migrate/start loops. Share this ready budget.
        if (this.launchBackground) {
          const launch = this.launchBackground;
          this.launchBackground = undefined;
          await launch();
        }
        if (this.state.dual) {
          if (!this.live("background")) break;
          if (!this.backgroundReady) {
            await delay(50);
            continue;
          }
          await this.verifyProcess("background");
        }
        this.state.ready = true;
        this.state.fence = this.state.dual ? 2 : 1;
        await this.saveState();
        return true;
      }
      await delay(50);
    }
    // /proc can report a zombie before Node delivers exit/close. Give only
    // our already-exited children the remaining ready budget to drain output
    // and publish their exit codes; this never authorizes stop or releases capacity.
    const closing: Promise<void>[] = [];
    for (const [role, child] of [
      ["web", this.child],
      ["background", this.backgroundChild],
    ] as const) {
      if (!child || this.live(role)) continue;
      const close = this.childCloses.get(child);
      if (close) closing.push(close);
    }
    if (closing.length && Date.now() < deadline) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(closing),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, deadline - Date.now());
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
    return false;
  }
  serverDiagnostics(stage: "start" | "ready") {
    if (this.state.dual)
      return [
        this.serverLog.finish(
          stage,
          this.spawnFailed ? "spawn_failed" : "not_exited",
        ),
        ...(
          [
            ["web", this.child],
            ["background", this.backgroundChild],
          ] as const
        ).map(
          ([role, child]) =>
            `${role}: ${child?.exitCode ?? (child?.signalCode ? "exit unknown" : "not_exited")}`,
        ),
      ].join("\n");
    return this.serverLog.finish(
      stage,
      this.spawnFailed
        ? "spawn_failed"
        : (this.child?.exitCode ??
            (this.child?.signalCode ? null : "not_exited")),
    );
  }
  serverFailureCause() {
    const causes = this.serverLog.causes();
    return causes.length ? causes.join("、") : undefined;
  }
  async readyRetryState(to: string, controlEventId?: string) {
    return readReadyRetry(this.options.store, PROJECT, to, controlEventId);
  }
  private portReady(port: number) {
    return new Promise<boolean>((resolve) => {
      const socket = connect({
        host:
          port === this.ports[0] &&
          ["::1", "localhost"].includes(
            this.options.env.CARDIGAN_MCP_HOST ?? "",
          )
            ? this.options.env.CARDIGAN_MCP_HOST
            : "127.0.0.1",
        port,
      });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(
        Math.min(1000, this.options.config.ready_timeout_ms),
        () => done(false),
      );
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  }
  async promote(build: DeploymentBuild) {
    if (this.state.current.sha !== build.sha)
      this.state.previous = this.state.current;
    this.state.current = build;
    delete this.state.backup_file;
    await this.saveState();
  }
  async refreshRoles() {
    const previous = this.state.previous;
    if (!previous) throw new Error("Previous role pack unavailable");
    const snapshot = async (release: string) => {
      const result = await this.command(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          ROLE_PACK_SNAPSHOT_SCRIPT,
          join(release, "packages/roles/dist/index.js"),
        ],
        release,
        this.buildEnv,
      );
      if (result.code !== 0) throw new Error("Role pack snapshot failed");
      return JSON.parse(result.text) as Record<string, string>;
    };
    const before = await snapshot(previous.release);
    const after = await snapshot(this.state.current.release);
    const changed = Object.keys(after).filter((id) => after[id] !== before[id]);
    const result = await this.command(
      process.execPath,
      [
        join(this.state.current.release, "apps/cli/dist/bin.js"),
        "self-deploy",
        "roles",
      ],
      this.state.current.release,
      {
        ...this.options.env,
        CARDIGAN_DATA_DIR: this.options.dataDir,
        CARDIGAN_DEPLOYMENT_CHANGED_ROLES: JSON.stringify(changed),
        CARDIGAN_DEPLOYMENT_PREVIOUS_ROLES: JSON.stringify(before),
      },
    );
    if (result.code !== 0) throw new Error("部署后角色同步未完成，请主机检查");
  }
  /** Called between deploy ticks, still under the exclusive supervisor flock. Rollbacks are not success. */
  async maintainDisk() {
    if (!this.enabled || !this.retention) return;
    const state = await this.readState();
    if (
      !state?.ready ||
      !state.running ||
      state.running.release !== state.current.release ||
      state.running.sha !== state.current.sha ||
      state.current.release !== this.state.current.release ||
      state.fence !== (state.dual ? 2 : 1) ||
      !this.live() ||
      (state.dual && !this.live("background"))
    )
      return;
    const row = this.options.store.database
      .prepare(
        `SELECT doc FROM events WHERE project_id=? AND card_id IS NULL AND type='host_deployment_recorded' ORDER BY seq DESC LIMIT 1`,
      )
      .get(PROJECT);
    if (!row) return;
    const e = JSON.parse(String(row.doc));
    const r = e.payload as DeploymentRecord;
    if (
      e.actor.kind !== "system" ||
      !r.ready ||
      r.status !== "deployed" ||
      r.to !== state.current.sha ||
      r.post_deploy_failed
    )
      return;
    const keep = [
      state.current.release,
      state.running.release,
      this.options.config.initial_release,
      fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/u, ""),
    ];
    if (state.previous !== undefined) keep.push(state.previous.release);
    await this.retention.poll({
      stillReady: async () =>
        this.live() &&
        (!state.dual || this.live("background")) &&
        JSON.stringify(await this.readState()) === JSON.stringify(state),
      keep: [...keep, ...(await Promise.all(keep.map((p) => realpath(p))))],
      ...(state.backup_file ? { backup: state.backup_file } : {}),
      attempt: r.attempt,
      deployed_at: e.created_at,
    });
  }
  async record(record: DeploymentRecord) {
    writeDeploymentRecord(this.options.store, PROJECT, record);
  }
  private gitEnv() {
    return {
      ...this.buildEnv,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
    };
  }
  // A tree comparison must not silently truncate stdout or mix in stderr as a build log can.
  private async readSupervisorGit(args: string[]) {
    const { stdout } = await exec(
      "git",
      [...gitSafetyArguments, "--git-dir", this.central, ...args],
      {
        env: this.gitEnv(),
        cwd: this.directory,
        maxBuffer: 2 * 1024 * 1024,
        timeout: this.options.config.build_timeout_ms,
        encoding: "utf8",
      },
    );
    return stdout;
  }
  private git(args: string[]) {
    return this.command(
      "git",
      [...gitSafetyArguments, "--git-dir", this.central, ...args],
      this.directory,
      this.gitEnv(),
    );
  }
  private command(
    file: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    output?: (chunk: string) => void,
  ) {
    return new Promise<{ code: number | null; text: string }>(
      (resolve, reject) => {
        const child = spawn(file, args, {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        const onData = (data: Buffer) => {
          const chunk = data.toString("utf8");
          output?.(chunk);
          if (!output) text = (text + chunk).slice(-2 * 1024 * 1024);
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        const timeout = setTimeout(() => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }
        }, this.options.config.build_timeout_ms);
        child.once("error", () => {
          clearTimeout(timeout);
          reject(new DeploymentCommandUnavailable("Host command failed"));
        });
        child.once("close", (code) => {
          clearTimeout(timeout);
          resolve({ code, text });
        });
      },
    );
  }
  private async readState(): Promise<State | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(
        join(this.directory, "state.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.size > 65536
      )
        throw new Error("Unsafe deployment state");
      const state = JSON.parse(await handle.readFile("utf8")) as State;
      if (
        !/^[a-f0-9]{40}$/u.test(state.current.sha) ||
        typeof state.current.release !== "string"
      )
        throw new Error("Invalid deployment state");
      return state;
    } finally {
      await handle.close();
    }
  }
  private async saveState() {
    const path = join(this.directory, `state-${randomUUID()}.tmp`);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(path, join(this.directory, "state.json"));
  }
}
