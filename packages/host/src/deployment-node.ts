import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
} from "node:fs/promises";
import { connect } from "node:net";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  DeploymentBuild,
  DeploymentDriver,
  DeploymentRecord,
} from "@cardigan/domain";
import { gitSafetyArguments } from "@cardigan/git-transport";
import type { Store } from "@cardigan/store";
import {
  deploymentMergeSegments,
  writeDeploymentRecord,
  writeDeploymentStop,
  writeServerLogAudit,
} from "./deployment-audit.js";
import { acquireDeploymentCapacity } from "./deployment-capacity.js";
import {
  DEFAULT_EVIDENCE_WAIT_TIMEOUT_MS,
  type DeploymentConfig,
  deploymentDirectory,
  requireHostDirectory,
} from "./deployment-config.js";
import { DeploymentBuildLog, DeploymentServerReady } from "./deployment-log.js";
import { DeploymentServerLog } from "./deployment-server-log.js";
import { type ExecutionOwner, executionOwner } from "./process-identity.js";
import { acquireRepositoryFlock } from "./repository-lock.js";

const PROJECT = "cardigan";
class DeploymentCommandUnavailable extends Error {}
interface State {
  current: DeploymentBuild;
  previous?: DeploymentBuild;
  running?: DeploymentBuild;
  process?: ExecutionOwner;
  ready?: boolean;
  fence?: 1;
  backup_file?: string;
}

/** Own child handles plus boot/start identity; never search cmdline or signal by name. */
export class NodeDeploymentDriver implements DeploymentDriver {
  readonly enabled: boolean;
  private state!: State;
  private readyMessage = false;
  private serverLog = new DeploymentBuildLog();
  private spawnFailed = false;
  private child: ChildProcess | undefined;
  private serverFailureRecorded = false;
  private serverLogFinished: Promise<void> = Promise.resolve();
  private readonly directory: string;
  private readonly central: string;
  private readonly ports: readonly number[];
  private readonly buildEnv: NodeJS.ProcessEnv;
  constructor(
    private readonly options: {
      store: Store;
      dataDir: string;
      config: DeploymentConfig;
      env: NodeJS.ProcessEnv;
    },
  ) {
    this.enabled = options.config.enabled;
    this.directory = deploymentDirectory(options.dataDir);
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
      if (this.state.process && this.live()) {
        await this.verifyProcess();
        if (
          !this.state.ready ||
          this.state.fence !== 1 ||
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
        } else this.readyMessage = true;
      } else {
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
      if (interrupted)
        await this.record({
          ...interrupted,
          status: "rolled_back",
          build: "passed",
          ready: true,
          downtime_ms: Date.now() - recoveringAt,
          summary: "监督器恢复时终止未完成候选，已恢复上一构建",
        });
      return unlock;
    } catch (error) {
      const log = startupStage
        ? this.serverDiagnostics(startupStage)
        : undefined;
      if (this.child?.pid && this.child.pid === this.state?.process?.pid)
        await this.stop().catch(() => {});
      if (interrupted || startupStage)
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
        }).catch(() => {});
      await this.finishServerLogs();
      await unlock();
      throw error;
    } finally {
      releaseCapacity?.();
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
  async checkServer() {
    if (this.live()) return;
    this.readyMessage = false;
    this.state = {
      current: this.state.current,
      ...(this.state.previous ? { previous: this.state.previous } : {}),
      ...(this.state.backup_file
        ? { backup_file: this.state.backup_file }
        : {}),
      ready: false,
    };
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
  async beforeStop(record: DeploymentRecord) {
    return writeDeploymentStop(this.options.store, PROJECT, record);
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
    return sha;
  }
  async isFastForward(from: string, to: string) {
    return (
      (await this.git(["merge-base", "--is-ancestor", from, to])).code === 0
    );
  }
  async passedMergeGate(from: string, to: string) {
    const segments = deploymentMergeSegments(
      this.options.store,
      PROJECT,
      from,
      to,
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
    const release = join(this.directory, `release-${sha}-${randomUUID()}`);
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
  private live() {
    return (
      this.state.process &&
      executionOwner(this.state.process.pid)?.start === this.state.process.start
    );
  }
  private async verifyProcess() {
    const identity = this.state.process;
    if (!identity || !this.state.running || !this.live())
      throw new Error("Server identity unavailable");
    const [stat, cwd, exe] = await Promise.all([
      lstat(`/proc/${identity.pid}`),
      readlink(`/proc/${identity.pid}/cwd`),
      readlink(`/proc/${identity.pid}/exe`),
    ]);
    if (
      stat.uid !== process.getuid?.() ||
      cwd !== this.state.running.release ||
      exe !== (await realpath(process.execPath)) ||
      !this.live()
    )
      throw new Error("Server process identity mismatch");
  }
  private signalServer(signal: NodeJS.Signals) {
    if (!this.state.process) throw new Error("Server identity unavailable");
    try {
      process.kill(this.state.process.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH" || this.live())
        throw error;
    }
  }
  async stop() {
    if (!this.state.process || !this.live()) {
      this.state = {
        current: this.state.current,
        ...(this.state.previous ? { previous: this.state.previous } : {}),
        ...(this.state.backup_file
          ? { backup_file: this.state.backup_file }
          : {}),
      };
      await this.saveState();
      return;
    }
    await this.verifyProcess();
    this.signalServer("SIGTERM");
    const deadline = Date.now() + this.options.config.stop_timeout_ms;
    while (this.live() && Date.now() < deadline) await delay(50);
    if (this.live()) {
      await this.verifyProcess();
      this.signalServer("SIGKILL");
      const killed = Date.now() + this.options.config.stop_timeout_ms;
      while (this.live() && Date.now() < killed) await delay(50);
    }
    if (this.live()) throw new Error("Server exit unconfirmed");
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
    if (this.state?.process && this.live()) return;
    await this.serverLogFinished;
  }

  async start(build: DeploymentBuild) {
    if (this.live()) throw new Error("A server is already running");
    this.readyMessage = false;
    this.serverLog = new DeploymentBuildLog();
    const diagnostics = this.serverLog;
    this.spawnFailed = false;
    this.serverFailureRecorded = false;
    const { server_log_max_bytes: maxBytes, server_log_max_files: maxFiles } =
      this.options.config;
    const log =
      maxBytes !== undefined && maxFiles !== undefined
        ? new DeploymentServerLog(
            this.directory,
            build.sha,
            { maxBytes, maxFiles },
            (entry) => writeServerLogAudit(this.options.store, entry),
            this.serverLogFinished,
          )
        : undefined;
    if (log) this.serverLogFinished = log.finished;
    const child = spawn(
      process.execPath,
      [join(build.release, "apps/server/dist/bin.js")],
      {
        cwd: build.release,
        env: { ...this.options.env, CARDIGAN_DATA_DIR: this.options.dataDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.on("error", () => {
      if (this.child === child) this.spawnFailed = true;
    });
    child.once("exit", () => {
      if (this.child === child) this.readyMessage = false;
    });
    // Close only after both pipes drain, including the old generation's final output.
    child.once("close", () => {
      void log?.close();
    });
    child.stderr?.on("data", (data: Buffer) => {
      log?.append(data);
      diagnostics.append(data.toString("utf8"));
    });
    const readyOutput = new DeploymentServerReady(this.ports);
    child.stdout?.on("data", (data: Buffer) => {
      log?.append(data);
      diagnostics.append(data.toString("utf8"));
      if (
        this.child !== child ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        return;
      if (readyOutput.append(data)) this.readyMessage = true;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("Server spawn failed")));
    });
    const owner = child.pid && executionOwner(child.pid);
    if (!owner) throw new Error("Server incarnation unavailable");
    this.state = {
      current: this.state.current,
      ...(this.state.previous ? { previous: this.state.previous } : {}),
      ...(this.state.backup_file
        ? { backup_file: this.state.backup_file }
        : {}),
      running: build,
      process: owner,
      ready: false,
    };
    await this.saveState();
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
        this.state.ready = true;
        this.state.fence = 1;
        await this.saveState();
        return true;
      }
      await delay(50);
    }
    return false;
  }
  serverDiagnostics(stage: "start" | "ready") {
    return this.serverLog.finish(
      stage,
      this.spawnFailed
        ? "spawn_failed"
        : (this.child?.exitCode ??
            (this.child?.signalCode ? null : "not_exited")),
    );
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
      const script = `import { pathToFileURL } from 'node:url';
        import { createHash } from 'node:crypto';
        const m = await import(pathToFileURL(process.argv[1]).href);
        const values = Object.fromEntries(Object.keys(m.DEFAULT_ROLE_KINDS).map(id => {
          const r = m.defaultRoleDefinition(id, { harness: 'codex', launch_profile_ref: 'deployment' });
          const p = { instructions: r.instructions, allowed_tools: [...r.allowed_tools].sort(),
            capabilities: [...r.capabilities].sort(), kind: r.kind, worktree: r.worktree };
          return [id, createHash('sha256').update(JSON.stringify(p)).digest('hex')];
        }));
        process.stdout.write(JSON.stringify(values));`;
      const result = await this.command(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
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
