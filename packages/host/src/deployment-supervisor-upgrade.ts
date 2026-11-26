import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Store } from "@cardigan/store";
import { parseDocument } from "yaml";
import {
  readSupervisorUpgradeState,
  writeDeploymentNotice,
  writeSupervisorUpgrade,
} from "./deployment-audit.js";
import { acquireDeploymentCapacity } from "./deployment-capacity.js";
import {
  requireHostDirectory,
  UnsafeHostDirectory,
} from "./deployment-config.js";
import {
  fenceLongOperations,
  liveLongOperations,
  releaseLongOperationFence,
} from "./long-operations.js";
import { type ExecutionOwner, executionOwner } from "./process-identity.js";

/**
 * C-767: the self-upgrade switch lives in its own host file. `self-deploy.yaml`
 * rejects unknown keys, so a new key there would stop every older supervisor,
 * including the one a rollback restores. This file is read only by
 * supervisors that know it; unknown keys are ignored so a rollback target can
 * still read a file written for a newer version. A missing file is "off".
 */
export const SUPERVISOR_UPGRADE_FILE = "supervisor-upgrade.yaml";
export const DEFAULT_SUPERVISOR_HEALTH_TIMEOUT_MS = 60_000;
const MIN_HEALTH_TIMEOUT_MS = 10_000;
const MAX_HEALTH_TIMEOUT_MS = 10 * 60_000;
/** systemd user unit name of the supervisor service. */
const UNIT = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,200}\.service$/u;
const SHA = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const PLAN_FILE = "supervisor-upgrade.json";
const MAX_LAUNCH_BYTES = 65536;

export interface SupervisorUpgradeConfig {
  readonly enabled: boolean;
  /** systemd user unit, e.g. `cardigan-selfdeploy.service`. */
  readonly unit: string;
  /** Host launch configuration naming the running supervisor checkout. */
  readonly launch_file: string;
  readonly health_timeout_ms: number;
}

export function parseSupervisorUpgradeConfig(
  raw: unknown,
): SupervisorUpgradeConfig | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid supervisor upgrade configuration");
  const value = raw as Record<string, unknown>;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    throw new Error("Invalid supervisor upgrade configuration");
  if (value.enabled !== true) return undefined;
  const timeout =
    value.health_timeout_ms ?? DEFAULT_SUPERVISOR_HEALTH_TIMEOUT_MS;
  if (
    typeof value.unit !== "string" ||
    !UNIT.test(value.unit) ||
    typeof value.launch_file !== "string" ||
    !isAbsolute(value.launch_file) ||
    value.launch_file !== resolve(value.launch_file) ||
    value.launch_file === "/" ||
    !Number.isSafeInteger(timeout) ||
    Number(timeout) < MIN_HEALTH_TIMEOUT_MS ||
    Number(timeout) > MAX_HEALTH_TIMEOUT_MS
  )
    throw new Error("Invalid supervisor upgrade configuration");
  return {
    enabled: true,
    unit: value.unit,
    launch_file: value.launch_file,
    health_timeout_ms: Number(timeout),
  };
}

/** Same host-file rules as self-deploy.yaml; undefined when absent or off. */
export async function loadSupervisorUpgradeConfig(
  configDir: string,
): Promise<SupervisorUpgradeConfig | undefined> {
  const file = resolve(configDir, SUPERVISOR_UPGRADE_FILE);
  let source: string;
  try {
    source = await readHostFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("无法安全读取主机 supervisor-upgrade.yaml", {
      cause: error,
    });
  }
  try {
    const doc = parseDocument(source, { uniqueKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length) throw new Error();
    return parseSupervisorUpgradeConfig(doc.toJS({ maxAliasCount: 0 }));
  } catch {
    throw new Error("无法安全读取主机 supervisor-upgrade.yaml");
  }
}

/** C-772: which host-file rule refused the file; the verdict is unchanged. */
class UnsafeHostFile extends Error {
  constructor(
    readonly reason: "not_file" | "owner" | "mode" | "too_large",
    readonly mode: number,
  ) {
    super("Unsafe host file");
  }
}

/** Regular, owner-only, bounded file below a host-owned directory. */
async function readHostFile(file: string, ownerOnly = true): Promise<string> {
  await requireHostDirectory(dirname(file));
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    const reason = !stat.isFile()
      ? "not_file"
      : ![0, process.getuid?.()].includes(stat.uid)
        ? "owner"
        : stat.mode & (ownerOnly ? 0o077 : 0o022)
          ? "mode"
          : stat.size > MAX_LAUNCH_BYTES
            ? "too_large"
            : undefined;
    if (reason) throw new UnsafeHostFile(reason, stat.mode & 0o7777);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

const octal = (mode: number) => `0${(mode & 0o777).toString(8)}`;

/**
 * C-772: why a host file could not be read safely, and how to fix it. Never
 * names host paths or file content, so it can go into events and Needs You;
 * `path` (the unsafe ancestor directory) is only for the local self-check.
 */
function hostFileProblem(
  error: unknown,
  subject: string,
  ownerOnly: boolean,
): { readonly reason: string; readonly path?: string } {
  const owner = "运行监督器的用户或 root";
  if (error instanceof UnsafeHostDirectory) {
    const where = `${subject}所在目录或其上级目录`;
    const reason = {
      symlink: `${where}是符号链接，不会跟随：请改写为不经过符号链接的真实路径`,
      not_directory: `${where}不是目录：请核对路径`,
      owner: `${where}的属主不是${owner}：请改为由${owner}所有`,
      writable: `${where}组或其他人可写（权限 ${octal(error.mode)}）：请执行 chmod go-w 去掉写权限，或移到只有本用户可写的目录`,
    }[error.reason];
    return { reason, path: error.path };
  }
  if (error instanceof UnsafeHostFile)
    return {
      reason: {
        not_file: `${subject}不是普通文件：请指向一个普通文件`,
        owner: `${subject}的属主不是${owner}：请用 chown 改为由${owner}所有`,
        mode: ownerOnly
          ? `${subject}组或其他人有权限（权限 ${octal(error.mode)}）：请执行 chmod 600`
          : `${subject}组或其他人可写（权限 ${octal(error.mode)}）：请执行 chmod go-w 去掉组和其他人的写权限`,
        too_large: `${subject}超过 ${MAX_LAUNCH_BYTES / 1024} KiB：请指向 systemd 单元或包装脚本这类小文件`,
      }[error.reason],
    };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return { reason: `${subject}不存在：请核对路径` };
  if (code === "ENOTDIR")
    return { reason: `${subject}的上级路径不是目录：请核对路径` };
  if (code === "ELOOP" || code === "EMLINK")
    return {
      reason: `${subject}是符号链接，不会跟随读取：请直接写链接指向的真实文件路径`,
    };
  if (code === "EACCES" || code === "EPERM")
    return { reason: `运行监督器的用户无权读取${subject}：请给该用户读权限` };
  return { reason: `${subject}无法安全读取：请核对文件和所在目录` };
}

/** The checkout this code runs from: the supervisor the driver upgrades. */
export async function supervisorCheckoutRoot() {
  return realpath(fileURLToPath(new URL("../../../", import.meta.url)));
}

export type LaunchFileCheck =
  | { readonly ok: true; readonly text: string; readonly mode: number }
  | { readonly ok: false; readonly reason: string; readonly path?: string };

/**
 * The launch file as the upgrade reads it: a safe host file (group and others
 * may read it) that names the running checkout `root` as a whole path
 * component. C-772: the self-check runs exactly this, never a looser copy.
 */
export async function inspectLaunchFile(
  file: string,
  root: string,
): Promise<LaunchFileCheck> {
  let text: string;
  let mode: number;
  try {
    mode = (await lstat(file)).mode;
    text = await readHostFile(file, false);
  } catch (error) {
    return {
      ok: false,
      ...hostFileProblem(error, "启动配置（launch_file）", false),
    };
  }
  if (!text.match(rootPattern(root))?.length)
    return {
      ok: false,
      reason: `启动配置没有引用当前监督器目录 ${basename(root)}：launch_file 要指向实际决定启动哪个版本、含该目录完整路径的文件（例如包装脚本里的 RELEASE=），不一定是 systemd 单元`,
    };
  return { ok: true, text, mode };
}

/** New releases are prepared next to the running checkout. */
async function inspectReleaseParent(root: string) {
  try {
    await requireHostDirectory(dirname(root));
    return undefined;
  } catch (error) {
    return hostFileProblem(error, "监督器目录", false);
  }
}

export interface SupervisorUpgradeSelfCheck {
  readonly ok: boolean;
  readonly config?: SupervisorUpgradeConfig;
  readonly problems: readonly {
    readonly reason: string;
    readonly path?: string;
  }[];
}

/**
 * C-772: read-only check before enabling the upgrade. Reads the switch file
 * and runs the release-directory and launch-file checks of a real attempt
 * against `root`; it writes nothing, restarts nothing and opens no store.
 */
export async function checkSupervisorUpgrade(
  configDir: string,
  root: string,
): Promise<SupervisorUpgradeSelfCheck> {
  let config: SupervisorUpgradeConfig | undefined;
  try {
    config = await loadSupervisorUpgradeConfig(configDir);
  } catch (error) {
    const cause = (error as Error).cause;
    return {
      ok: false,
      problems: [
        cause === undefined
          ? {
              reason: `${SUPERVISOR_UPGRADE_FILE} 不是合法 YAML 或字段无效：请核对 enabled、unit、launch_file（绝对路径）与 health_timeout_ms（10000 到 600000）`,
            }
          : hostFileProblem(cause, SUPERVISOR_UPGRADE_FILE, true),
      ],
    };
  }
  if (!config)
    return {
      ok: false,
      problems: [
        {
          reason: `${SUPERVISOR_UPGRADE_FILE} 不存在或 enabled 不是 true：自动升级保持关闭，请先写好开关文件再自检`,
        },
      ],
    };
  const problems = [
    await inspectReleaseParent(root),
    await inspectLaunchFile(config.launch_file, root).then((check) =>
      check.ok ? undefined : check,
    ),
  ].flatMap((problem) =>
    problem
      ? [
          {
            reason: problem.reason,
            ...(problem.path ? { path: problem.path } : {}),
          },
        ]
      : [],
  );
  return { ok: !problems.length, config, problems };
}

/** Atomic replace in the same directory, keeping the original mode. */
async function replaceFile(file: string, text: string, mode: number) {
  const tmp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(tmp, "wx", mode & 0o777);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** The checkout path as a whole path component, never a longer sibling name. */
const rootPattern = (root: string) =>
  new RegExp(`${escapeRegExp(root)}(?=[/\\s"':=]|$)`, "gu");

export interface SupervisorUpgradePlan {
  readonly version: 1;
  readonly attempt: string;
  readonly from: string;
  readonly to: string;
  readonly unit: string;
  readonly launch_file: string;
  /** Mode of the original launch file, restored with its bytes. */
  readonly launch_mode: number;
  /** SHA-256 of the rewritten launch file; rollback never clobbers other edits. */
  readonly launch_sha256: string;
  readonly backup_file: string;
  readonly old_root: string;
  readonly new_root: string;
  readonly health_timeout_ms: number;
  readonly ports: readonly { readonly host: string; readonly port: number }[];
  /** The supervisor and server incarnations that the restart replaces. */
  readonly supervisor: ExecutionOwner;
  readonly server?: ExecutionOwner;
  readonly requested_at: string;
  /**
   * C-770: written by the helper right before it restarts the unit, so a
   * recovery after the helper died knows whether the old supervisor was
   * already asked to stop.
   */
  readonly restart_requested_at?: string;
  /** C-770: an outcome whose audit write failed; recovery replays it. */
  readonly result?: {
    readonly status: "completed" | "rolled_back" | "failed";
    readonly summary: string;
  };
  /**
   * C-787: the deployment this restart finishes. The old server is already
   * stopped; the new supervisor starts `release` at startup, or restores
   * `from` when it does not become ready.
   */
  readonly deploy?: SupervisorHandoffPlan;
}

/** C-787: what the new supervisor needs to start the handed-over build. */
export interface SupervisorHandoffPlan {
  /** Attempt of the deployment's durable stop record. */
  readonly attempt: string;
  readonly sha: string;
  /** Built release of `sha` in the deployment directory. */
  readonly release: string;
  /** The deployed SHA whose server was stopped. */
  readonly from: string;
  /** Epoch ms when the old server was stopped. */
  readonly stopped_at: number;
  /** Database backup taken after the stop, when migrations changed. */
  readonly backup_file?: string;
}

function validHandoffPlan(d: unknown): d is SupervisorHandoffPlan {
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  const v = d as SupervisorHandoffPlan;
  return (
    UUID.test(v.attempt) &&
    SHA.test(v.sha) &&
    SHA.test(v.from) &&
    typeof v.release === "string" &&
    isAbsolute(v.release) &&
    v.release === resolve(v.release) &&
    v.release !== "/" &&
    Number.isSafeInteger(v.stopped_at) &&
    v.stopped_at > 0 &&
    (v.backup_file === undefined ||
      (typeof v.backup_file === "string" &&
        /^database-[a-f0-9-]{36}\.bak$/u.test(v.backup_file)))
  );
}

const planPath = (directory: string) => join(directory, PLAN_FILE);

async function writePlan(directory: string, plan: SupervisorUpgradePlan) {
  await replaceFile(planPath(directory), JSON.stringify(plan), 0o600);
}

export async function readSupervisorUpgradePlan(
  directory: string,
): Promise<SupervisorUpgradePlan | undefined> {
  let text: string;
  try {
    text = await readHostFile(planPath(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unsafe supervisor upgrade plan");
  }
  const p = JSON.parse(text) as SupervisorUpgradePlan;
  const owner = (o: unknown) =>
    !!o &&
    typeof o === "object" &&
    Number.isSafeInteger((o as ExecutionOwner).pid) &&
    typeof (o as ExecutionOwner).start === "string";
  const path = (v: unknown) =>
    typeof v === "string" && isAbsolute(v) && v === resolve(v) && v !== "/";
  if (
    p.version !== 1 ||
    !UUID.test(p.attempt) ||
    !SHA.test(p.from) ||
    !SHA.test(p.to) ||
    !UNIT.test(p.unit) ||
    ![p.launch_file, p.backup_file, p.old_root, p.new_root].every(path) ||
    dirname(p.backup_file) !== directory ||
    dirname(p.old_root) !== dirname(p.new_root) ||
    !Number.isSafeInteger(p.launch_mode) ||
    !/^[a-f0-9]{64}$/u.test(p.launch_sha256) ||
    !Number.isSafeInteger(p.health_timeout_ms) ||
    p.health_timeout_ms < MIN_HEALTH_TIMEOUT_MS ||
    p.health_timeout_ms > MAX_HEALTH_TIMEOUT_MS ||
    !Array.isArray(p.ports) ||
    p.ports.length < 1 ||
    !p.ports.every(
      (t) =>
        ["127.0.0.1", "::1", "localhost"].includes(t.host) &&
        Number.isSafeInteger(t.port) &&
        t.port > 0 &&
        t.port < 65536,
    ) ||
    !owner(p.supervisor) ||
    (p.server !== undefined && !owner(p.server)) ||
    typeof p.requested_at !== "string" ||
    (p.restart_requested_at !== undefined &&
      !Number.isFinite(Date.parse(p.restart_requested_at))) ||
    (p.result !== undefined &&
      (!["completed", "rolled_back", "failed"].includes(p.result?.status) ||
        typeof p.result.summary !== "string" ||
        !p.result.summary.trim())) ||
    (p.deploy !== undefined &&
      (!validHandoffPlan(p.deploy) || p.deploy.sha !== p.to))
  )
    throw new Error("Invalid supervisor upgrade plan");
  return p;
}

async function removePlan(directory: string) {
  try {
    await unlink(planPath(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Ports the restart helper needs; tests replace systemd, /proc and sockets. */
export interface SupervisorRestartPorts {
  systemctl(args: string[]): Promise<{ code: number | null; text: string }>;
  /** The deployment state.json, or undefined while unreadable. */
  readState(): Promise<DeployedState | undefined>;
  portOpen(host: string, port: number): Promise<boolean>;
  cmdline(pid: number): Promise<readonly string[] | undefined>;
  alive(owner: ExecutionOwner): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface DeployedState {
  readonly ready?: boolean;
  readonly current: { readonly sha: string };
  readonly running?: { readonly sha: string };
  readonly process?: ExecutionOwner;
}

type Health = "healthy" | "failed" | "pending";

function unitStatus(text: string) {
  const fields = new Map(
    text
      .split("\n")
      .map((line) => line.split("=", 2) as [string, string | undefined])
      .filter(([, v]) => v !== undefined),
  );
  return {
    active: fields.get("ActiveState") ?? "",
    sub: fields.get("SubState") ?? "",
    pid: Number(fields.get("MainPID") ?? 0),
  };
}

/**
 * One observation of the restarted service: the unit's main process runs
 * from `root`, state.json shows a ready server incarnation newer than the one
 * the restart replaced, and every fixed port accepts a connection.
 * `strict` (the upgrade) treats a crashed unit or a process from another
 * checkout as an explicit failure; a rollback only waits.
 */
async function observe(
  plan: SupervisorUpgradePlan,
  root: string,
  strict: boolean,
  ports: SupervisorRestartPorts,
): Promise<Health> {
  const show = await ports.systemctl([
    "--user",
    "show",
    "--property=ActiveState",
    "--property=SubState",
    "--property=MainPID",
    plan.unit,
  ]);
  if (show.code !== 0) return "pending";
  const unit = unitStatus(show.text);
  if (strict && (unit.active === "failed" || unit.sub === "auto-restart"))
    return "failed";
  if (
    unit.active !== "active" ||
    !Number.isSafeInteger(unit.pid) ||
    unit.pid < 1
  )
    return "pending";
  if (unit.pid === plan.supervisor.pid && ports.alive(plan.supervisor))
    return "pending"; // The old supervisor is still shutting down.
  const argv = await ports.cmdline(unit.pid);
  if (!argv) return "pending";
  if (!argv.some((arg) => arg.startsWith(`${root}/`)))
    return strict ? "failed" : "pending";
  const state = await ports.readState().catch(() => undefined);
  if (
    !state?.ready ||
    !state.process ||
    state.running?.sha !== state.current.sha ||
    state.process.start === plan.server?.start ||
    !ports.alive(state.process)
  )
    return "pending";
  for (const target of plan.ports)
    if (!(await ports.portOpen(target.host, target.port))) return "pending";
  return "healthy";
}

async function waitHealthy(
  plan: SupervisorUpgradePlan,
  root: string,
  strict: boolean,
  ports: SupervisorRestartPorts,
  deadline = ports.now() + plan.health_timeout_ms,
): Promise<"healthy" | "failed" | "timeout"> {
  let failures = 0;
  for (;;) {
    let health: Health = "pending";
    try {
      health = await observe(plan, root, strict, ports);
    } catch {
      /* An unreadable observation is not health; keep waiting to the deadline. */
    }
    if (health === "healthy") return health;
    // Two observations in a row: never a transient state of the restart job.
    failures = health === "failed" ? failures + 1 : 0;
    if (failures >= 2) return "failed";
    if (ports.now() >= deadline) return "timeout";
    await ports.sleep(Math.min(1000, Math.max(0, deadline - ports.now())));
  }
}

/**
 * Put back the original launch file, unless someone else changed it since.
 * C-770: idempotent, so the supervisor, the helper and its recovery may each
 * try: a launch file already equal to the backup counts as restored.
 */
async function restoreLaunch(
  plan: SupervisorUpgradePlan,
): Promise<"restored" | "already" | "changed"> {
  try {
    const current = await readHostFile(plan.launch_file, false);
    const backup = await readHostFile(plan.backup_file);
    if (current === backup) return "already";
    if (digest(current) !== plan.launch_sha256) return "changed";
    await replaceFile(plan.launch_file, backup, plan.launch_mode);
    return "restored";
  } catch {
    return "changed";
  }
}

const seconds = (ms: number) => Math.ceil(ms / 1000);
const RECORD_ATTEMPTS = 3;

type Outcome = "completed" | "rolled_back" | "failed";

/**
 * Write the terminal audit (which opens Needs You on failure) and clear the
 * plan. C-770: a write that keeps failing leaves the plan with the outcome so
 * the recovery can replay it, instead of only logging to the console.
 */
async function settle(
  store: Store,
  directory: string,
  plan: SupervisorUpgradePlan,
  ports: SupervisorRestartPorts,
  status: Outcome,
  summary: string,
): Promise<boolean> {
  for (let i = 0; i < RECORD_ATTEMPTS; i++) {
    try {
      writeSupervisorUpgrade(store, {
        attempt: plan.attempt,
        from: plan.from,
        to: plan.to,
        status,
        summary,
      });
      await removePlan(directory);
      return true;
    } catch {
      if (i + 1 < RECORD_ATTEMPTS) await ports.sleep(1000);
    }
  }
  console.error("监督器自动升级结果未能写入审计，结果保留在升级计划中待恢复");
  try {
    await writePlan(directory, { ...plan, result: { status, summary } });
  } catch {
    console.error("监督器自动升级结果也未能写入升级计划，请核对主机日志");
  }
  return false;
}

/**
 * C-767 restart helper. Runs from the OLD supervisor checkout in its own
 * transient systemd unit, so restarting the supervisor never stops it: it
 * restarts the unit, waits for health, and on an explicit failure or timeout
 * restores the backed-up launch file and restarts the old version.
 *
 * C-770 `resume`: the recovery that the helper unit's `ExecStopPost=` runs
 * once the helper has exited for any reason (including SIGKILL). With no
 * plan left it does nothing. Otherwise it continues where the helper
 * stopped: replays an unwritten outcome; rolls the launch file back without
 * a restart when the helper never asked for one; else waits out the rest of
 * the health window and rolls back if the new supervisor is not healthy.
 */
export async function finishSupervisorUpgrade(options: {
  store: Store;
  directory: string;
  ports: SupervisorRestartPorts;
  resume?: boolean;
}): Promise<Outcome | "none"> {
  const { store, directory, ports } = options;
  const resume = options.resume === true;
  const loaded = await readSupervisorUpgradePlan(directory);
  if (!loaded) {
    if (resume) return "none";
    throw new Error("No supervisor upgrade is pending");
  }
  let plan = loaded;
  if (plan.result) {
    if (!resume) throw new Error("No supervisor upgrade is pending");
    const { status, summary } = plan.result;
    await settle(store, directory, plan, ports, status, summary);
    return status;
  }
  const started = ports.now();
  let result: "healthy" | "failed" | "timeout" | "not_restarted" =
    "not_restarted";
  if (!resume) {
    plan = {
      ...plan,
      restart_requested_at: new Date(ports.now()).toISOString(),
    };
    let marked = false;
    try {
      await writePlan(directory, plan);
      marked = true;
    } catch {
      /* Not restarted: the recovery must never assume the old one stopped. */
    }
    const restart = marked
      ? await ports
          .systemctl(["--user", "restart", "--no-block", plan.unit])
          .catch(() => ({ code: null, text: "" }))
      : { code: null };
    if (restart.code === 0)
      result = await waitHealthy(plan, plan.new_root, true, ports);
  } else if (plan.restart_requested_at) {
    // The rest of the helper's window; at least one observation.
    result = await waitHealthy(
      plan,
      plan.new_root,
      true,
      ports,
      Date.parse(plan.restart_requested_at) + plan.health_timeout_ms,
    );
  }
  if (result === "healthy") {
    await settle(
      store,
      directory,
      plan,
      ports,
      "completed",
      `新监督器已接管，ready、state.json 与 ${plan.ports.length} 个端口核对通过，用时约 ${seconds(ports.now() - started)} 秒${resume ? "（由重启助手的兜底核对）" : ""}`,
    );
    return "completed";
  }
  const cause =
    result === "not_restarted"
      ? resume
        ? "重启助手在发出重启前退出"
        : "重启命令未执行"
      : result === "failed"
        ? "新监督器启动失败或运行的不是新目录"
        : `${seconds(plan.health_timeout_ms)} 秒内健康检查未通过`;
  const prefix =
    resume && result !== "not_restarted" ? "重启助手异常退出，" : "";
  const restored = await restoreLaunch(plan);
  let back: "healthy" | "failed" | "timeout" | "not_restored" = "not_restored";
  if (restored !== "changed") {
    const reload = await ports
      .systemctl(["--user", "daemon-reload"])
      .catch(() => ({ code: null, text: "" }));
    // The old supervisor was never stopped when the restart itself failed.
    if (result === "not_restarted")
      back = reload.code === 0 ? "healthy" : "failed";
    else if (
      // A helper that died mid-rollback may already have restarted it.
      restored === "already" &&
      reload.code === 0 &&
      (await observe(plan, plan.old_root, false, ports).catch(
        () => "pending" as const,
      )) === "healthy"
    )
      back = "healthy";
    else {
      // C-787: a new supervisor that crash-looped may have tripped the
      // unit's start limit, which refuses this restart; clear it first.
      if (reload.code === 0)
        await ports
          .systemctl(["--user", "reset-failed", plan.unit])
          .catch(() => undefined);
      const again =
        reload.code === 0
          ? await ports
              .systemctl(["--user", "restart", "--no-block", plan.unit])
              .catch(() => ({ code: null, text: "" }))
          : { code: null };
      back =
        again.code === 0
          ? await waitHealthy(plan, plan.old_root, false, ports)
          : "failed";
    }
  }
  const outcome: Outcome =
    back === "healthy"
      ? result === "not_restarted"
        ? "failed"
        : "rolled_back"
      : "failed";
  await settle(
    store,
    directory,
    plan,
    ports,
    outcome,
    `${prefix}${cause}；${
      back === "healthy"
        ? result === "not_restarted"
          ? "启动配置已恢复，旧监督器继续运行"
          : "已用备份恢复启动配置并重启旧监督器，旧版本健康检查通过"
        : back === "not_restored"
          ? "启动配置已被改动或备份不可读，未自动回滚，请人工核对"
          : "已恢复启动配置，但旧监督器健康检查未通过，请立即人工核对"
    }`,
  );
  return outcome;
}

/** What the upgrader needs from the running supervisor (the driver). */
export interface SupervisorUpgradeHost {
  readonly store: Store;
  /** Deployment state directory (plan and backups live here). */
  readonly directory: string;
  readonly configDir: string;
  /** The running supervisor checkout and its SHA. */
  readonly root: string;
  readonly supervisor: string;
  /** Deployed SHA when the owned server is ready and no switch is pending. */
  idleDeployment(): Promise<string | undefined>;
  /** Clone the central repository at `sha` into `release`, install and build. */
  checkout(
    sha: string,
    release: string,
  ): Promise<{ ok: boolean; log_tail: string }>;
  /** Run the new code against the host configuration it will read. */
  validate(release: string): Promise<boolean>;
  systemctl(args: string[]): Promise<{ code: number | null; text: string }>;
  /** Start the restart helper from `root` outside the supervisor unit. */
  launchHelper(attempt: string, root: string): Promise<boolean>;
  ports(): readonly { host: string; port: number }[];
  server(): ExecutionOwner | undefined;
  /** Compare again next tick, so a blocked upgrade raises the human reminder. */
  recheck(): void;
  /**
   * C-787: extra health window (ms) for a restart that also starts the
   * handed-over build: its start and ready, and a rollback to the old build.
   */
  switchWindowMs?(): number;
  /**
   * The waiter row closing check admission is one per process and shared
   * with deployments: report this upgrade's wait, never delete it directly.
   */
  capacityWaiting(waiting: boolean): void;
  now(): number;
}

type Pending = { readonly from: string; readonly to: string };
type Prepared = Pending & {
  readonly attempt: string;
  readonly release: string;
};

export type SupervisorUpgradeStep =
  | "idle"
  | "waiting"
  | "restarting"
  | "failed";

/**
 * C-767 automatic supervisor upgrade, default off. The watch loop calls
 * `step()` between deployment ticks, so no deployment of this supervisor is in
 * flight. The restart happens only while this supervisor holds the deployment
 * capacity: that requires no live card or batch merge check or author
 * precheck of any project, and closes their admission until the new
 * supervisor starts. Managed long operations are fenced the same way.
 */
export class SupervisorUpgrader {
  private pending: Pending | undefined;
  private prepared: Prepared | undefined;
  private restartingSince: number | undefined;
  private release: (() => void) | undefined;
  private noticed = new Set<string>();
  private capacityWait = false;
  private waiter = false;
  /** C-787: the main whose preparation this incarnation already tried. */
  private attempted: string | undefined;
  /** C-787: an earlier helper's plan file was present at the last step. */
  private planPresent = false;
  constructor(
    private readonly host: SupervisorUpgradeHost,
    private readonly config: SupervisorUpgradeConfig,
  ) {}

  get restarting() {
    return this.restartingSince !== undefined;
  }

  /** The helper's own bound: an upgrade window, a rollback window and slack. */
  private limit() {
    return 2 * this.config.health_timeout_ms + 120_000;
  }

  /**
   * Whether a verified change from the running supervisor to `main` is
   * handled here instead of as a human reminder.
   */
  automatic(supervisor: string, main: string, affected: readonly string[]) {
    if (supervisor !== this.host.supervisor) return false;
    let state: ReturnType<typeof readSupervisorUpgradeState>;
    try {
      state = readSupervisorUpgradeState(this.host.store, supervisor);
    } catch {
      return false;
    }
    if (state.blocked) return false;
    if (affected.length && supervisor !== main)
      this.pending = { from: supervisor, to: main };
    else this.pending = undefined;
    return true;
  }

  /**
   * C-787: how the deployment of `target` (central main) joins this upgrade.
   * "prepare": defer that deployment for one upgrade step, which prepares
   * the new supervisor. "join": prepared; the deployment stops the server
   * and hands its start to the restarted supervisor (`handOff`). Undefined:
   * deploy as before; the upgrade follows separately, if at all.
   */
  join(target: string): "prepare" | "join" | undefined {
    if (
      this.restartingSince !== undefined ||
      this.planPresent ||
      this.pending?.to !== target
    )
      return undefined;
    if (this.prepared?.to === target) return "join";
    return this.attempted === target ? undefined : "prepare";
  }

  /**
   * C-787: restart now as the final step of a deployment of the prepared
   * main. The deployment has stopped the server and holds the capacity and
   * the operation fence; they stay held until this supervisor is replaced.
   * False (with the upgrade recorded failed, launch file restored) means the
   * deployment starts the new build itself.
   */
  async handOff(deploy: SupervisorHandoffPlan): Promise<boolean> {
    const target = this.prepared;
    if (
      this.restartingSince !== undefined ||
      !target ||
      target.to !== deploy.sha ||
      this.pending?.to !== deploy.sha ||
      !validHandoffPlan(deploy)
    )
      return false;
    return (await this.restart(target, deploy)) === "restarting";
  }

  private notice(key: string, text: string) {
    if (this.noticed.has(key)) return;
    try {
      writeDeploymentNotice(this.host.store, key, text);
      this.noticed.add(key);
    } catch {
      /* Retried on the next step. */
    }
  }

  private record(
    target: Prepared,
    status: "started" | "restarting" | "failed",
    summary: string,
  ) {
    writeSupervisorUpgrade(this.host.store, {
      attempt: target.attempt,
      from: target.from,
      to: target.to,
      status,
      summary,
    });
  }

  private fail(target: Prepared, summary: string): SupervisorUpgradeStep {
    this.prepared = undefined;
    this.pending = undefined;
    try {
      this.record(target, "failed", summary);
    } catch {
      console.error("监督器自动升级失败审计未能写入，请核对主机日志");
    }
    this.host.recheck();
    return "failed";
  }

  private releaseHold() {
    const release = this.release;
    this.release = undefined;
    try {
      release?.();
    } catch {
      /* Rows of this incarnation are reclaimed once it exits. */
    }
    releaseLongOperationFence(this.host.store);
  }

  /**
   * Bounded wait for the helper; resume deployments if no restart came.
   * C-770: this process was never restarted, yet the launch file already
   * names the new checkout. Put the backup back while it is still exactly
   * the rewritten file, so the next restart of any kind runs the old
   * checkout; a file someone edited is left alone. Either way the attempt
   * ends with one Needs You item.
   */
  private async awaitRestart(): Promise<SupervisorUpgradeStep> {
    const since = this.restartingSince ?? this.host.now();
    const limit = this.limit();
    const plan = await readSupervisorUpgradePlan(this.host.directory).catch(
      () => undefined,
    );
    if (plan && this.host.now() - since < limit) return "restarting";
    if (plan) await this.abandon(plan, limit);
    this.restartingSince = undefined;
    this.prepared = undefined;
    this.pending = undefined;
    this.releaseHold();
    this.host.recheck();
    return "idle";
  }

  private async abandon(plan: SupervisorUpgradePlan, limit: number) {
    const restored = await restoreLaunch(plan);
    let reloaded = false;
    if (restored !== "changed")
      reloaded = await this.host
        .systemctl(["--user", "daemon-reload"])
        .then((r) => r.code === 0)
        .catch(() => false);
    const summary = `重启助手超过 ${seconds(limit)} 秒没有结束，监督器没有被重启，已恢复正常部署；${
      restored === "changed"
        ? `启动配置 ${plan.launch_file} 已被改动或备份不可读，未覆盖，请人工核对（备份 ${plan.backup_file}）`
        : reloaded
          ? "启动配置已恢复为备份并重新加载 systemd，之后重启运行的仍是旧目录"
          : `启动配置已恢复为备份，但 systemd 重新加载失败，请人工执行 systemctl --user daemon-reload 并核对单元 ${plan.unit}`
    }`;
    try {
      writeSupervisorUpgrade(this.host.store, {
        attempt: plan.attempt,
        from: plan.from,
        to: plan.to,
        status: "failed",
        summary,
      });
    } catch {
      // Keep the plan: a later incarnation still reports it as stalled.
      this.notice(
        `supervisor-upgrade-stalled:${plan.attempt}`,
        `部署监督器自动升级（${plan.from} → ${plan.to}）：${summary}`,
      );
      return;
    }
    await removePlan(this.host.directory).catch(() => {});
  }

  async step(): Promise<SupervisorUpgradeStep> {
    this.capacityWait = false;
    try {
      return await this.advance();
    } finally {
      // A capacity wait closes check admission; never leave it behind once
      // this upgrade stops waiting for capacity (held, abandoned or failed).
      if (this.capacityWait !== this.waiter) {
        this.waiter = this.capacityWait;
        try {
          this.host.capacityWaiting(this.capacityWait);
        } catch {
          /* Reclaimed with this incarnation. */
        }
      }
    }
  }

  private async advance(): Promise<SupervisorUpgradeStep> {
    if (this.restartingSince !== undefined) return this.awaitRestart();
    const pending = this.pending;
    if (!pending) return "idle";
    // An earlier helper is still finishing (for example after a rollback).
    const existing = await readSupervisorUpgradePlan(this.host.directory).catch(
      () => "unsafe" as const,
    );
    this.planPresent = Boolean(existing);
    if (existing) {
      if (existing === "unsafe")
        this.notice(
          "supervisor-upgrade-plan-invalid",
          "部署监督器自动升级的计划文件无法安全读取，自动升级已暂停。请主机管理员核对部署目录。",
        );
      else if (
        !(this.host.now() - Date.parse(existing.requested_at) < this.limit())
      )
        this.notice(
          `supervisor-upgrade-stalled:${existing.attempt}`,
          `部署监督器自动升级（${existing.from} → ${existing.to}）的重启助手超过 ${seconds(this.limit())} 秒没有结束，自动升级已暂停。请核对 systemd 单元 ${existing.unit}、启动配置与部署目录中的升级计划。`,
        );
      return "waiting";
    }
    // C-787: a deployment of this main defers at most this one step for it.
    this.attempted = pending.to;
    // Prepare while the server runs any build, so that the deployment of the
    // same main joins the restart; never during a switch or maintenance.
    if ((await this.host.idleDeployment()) === undefined) return "waiting";
    if (this.prepared?.to !== pending.to) {
      // Another incarnation (or a helper) may have ended an attempt since.
      if (readSupervisorUpgradeState(this.host.store, pending.from).blocked) {
        this.pending = undefined;
        this.host.recheck();
        return "idle";
      }
      const attempt = randomUUID();
      const release = join(
        dirname(this.host.root),
        `release-watch-${pending.to}`,
      );
      const target = { ...pending, attempt, release };
      this.record(
        target,
        "started",
        "监督器版本落后，开始在新目录准备新版本监督器",
      );
      try {
        await lstat(release);
        return this.fail(target, "目标目录已存在，未覆盖");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          return this.fail(target, "无法核对目标目录");
      }
      try {
        const parent = await inspectReleaseParent(this.host.root);
        if (parent) throw new UpgradeRejected(parent.reason);
        const built = await this.host.checkout(pending.to, release);
        if (!built.ok)
          return this.fail(target, `新版本构建未通过：${built.log_tail}`);
        if (!(await this.host.validate(release)))
          return this.fail(target, "新版本未能读取现有主机配置");
        await this.launchText();
      } catch (error) {
        return this.fail(
          target,
          error instanceof UpgradeRejected ? error.message : "新版本准备未完成",
        );
      }
      this.prepared = target;
    }
    const target = this.prepared;
    // Main not deployed yet: its deployment hands over the restart (C-787).
    // Otherwise (already deployed, e.g. by a pin) restart on its own.
    if (!target || (await this.host.idleDeployment()) !== target.to)
      return "waiting";
    if (liveLongOperations(this.host.store).length) return "waiting";
    const release = acquireDeploymentCapacity(this.host.store);
    if (!release) {
      // A merge check or another deployment holder; admission stays closed.
      this.capacityWait = true;
      return "waiting";
    }
    this.release = release;
    if (fenceLongOperations(this.host.store).length) {
      this.releaseHold();
      return "waiting";
    }
    // Re-read after taking the fence: nothing may have switched meanwhile.
    if ((await this.host.idleDeployment()) !== target.to) {
      this.releaseHold();
      return "waiting";
    }
    return this.restart(target);
  }

  /** The current launch file, proven to name the running checkout. */
  private async launchText() {
    const check = await inspectLaunchFile(
      this.config.launch_file,
      this.host.root,
    );
    if (!check.ok) throw new UpgradeRejected(check.reason);
    return { text: check.text, mode: check.mode };
  }

  private async restart(
    target: Prepared,
    deploy?: SupervisorHandoffPlan,
  ): Promise<SupervisorUpgradeStep> {
    // A handed-over deployment owns the capacity and the operation fence.
    const releaseHold = () => {
      if (!deploy) this.releaseHold();
    };
    const backup = join(
      this.host.directory,
      `supervisor-launch-${target.attempt}.bak`,
    );
    let launch: { text: string; mode: number };
    let rewritten: string;
    try {
      launch = await this.launchText();
      rewritten = launch.text.replace(
        rootPattern(this.host.root),
        () => target.release,
      );
      await replaceFile(backup, launch.text, 0o600);
    } catch (error) {
      releaseHold();
      return this.fail(
        target,
        error instanceof UpgradeRejected ? error.message : "启动配置备份未完成",
      );
    }
    const owner = executionOwner(process.pid);
    if (!owner) {
      releaseHold();
      return this.fail(target, "监督器进程身份不可用");
    }
    const server = this.host.server();
    const plan: SupervisorUpgradePlan = {
      version: 1,
      attempt: target.attempt,
      from: target.from,
      to: target.to,
      unit: this.config.unit,
      launch_file: this.config.launch_file,
      launch_mode: launch.mode & 0o777,
      launch_sha256: digest(rewritten),
      backup_file: backup,
      old_root: this.host.root,
      new_root: target.release,
      health_timeout_ms: deploy
        ? Math.min(
            MAX_HEALTH_TIMEOUT_MS,
            this.config.health_timeout_ms +
              Math.max(0, this.host.switchWindowMs?.() ?? 0),
          )
        : this.config.health_timeout_ms,
      ports: this.host.ports(),
      supervisor: owner,
      ...(server ? { server } : {}),
      requested_at: new Date(this.host.now()).toISOString(),
      ...(deploy ? { deploy } : {}),
    };
    let rewrote = false;
    try {
      await replaceFile(this.config.launch_file, rewritten, launch.mode);
      rewrote = true;
      if ((await this.host.systemctl(["--user", "daemon-reload"])).code !== 0)
        throw new Error("daemon-reload");
      await writePlan(this.host.directory, plan);
      this.record(
        target,
        "restarting",
        deploy
          ? `与服务部署合并为一次停起：旧服务已停，改写启动配置并通过 systemd 重启监督器，由新监督器启动 ${deploy.sha.slice(0, 12)}`
          : "单卡与批次合并检查均空闲、无进行中的部署，改写启动配置并通过 systemd 重启监督器",
      );
      if (!(await this.host.launchHelper(target.attempt, this.host.root)))
        throw new Error("helper");
    } catch {
      await removePlan(this.host.directory).catch(() => {});
      let restored = !rewrote;
      if (rewrote)
        try {
          await replaceFile(this.config.launch_file, launch.text, launch.mode);
          restored =
            (await this.host.systemctl(["--user", "daemon-reload"])).code === 0;
        } catch {
          restored = false;
        }
      releaseHold();
      return this.fail(
        target,
        restored
          ? "未能交给重启助手（重新加载 systemd 或启动助手失败），启动配置已恢复，监督器继续运行旧版本"
          : "未能交给重启助手，且启动配置未能恢复，请立即人工核对",
      );
    }
    this.restartingSince = this.host.now();
    return "restarting";
  }
}

class UpgradeRejected extends Error {}

/** Production ports of the restart helper. */
export function nodeRestartPorts(options: {
  directory: string;
  systemctl: SupervisorRestartPorts["systemctl"];
}): SupervisorRestartPorts {
  return {
    systemctl: options.systemctl,
    async readState() {
      const text = await readHostFile(join(options.directory, "state.json"));
      const state = JSON.parse(text) as DeployedState;
      if (!SHA.test(state.current?.sha ?? "")) return undefined;
      return state;
    },
    portOpen: (host, port) =>
      new Promise<boolean>((resolve) => {
        const socket = connect({ host, port });
        const done = (ok: boolean) => {
          socket.destroy();
          resolve(ok);
        };
        socket.setTimeout(1000, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
      }),
    async cmdline(pid) {
      try {
        return (await readFile(`/proc/${pid}/cmdline`, "utf8"))
          .split("\0")
          .filter(Boolean);
      } catch {
        return undefined;
      }
    },
    alive: (owner) => executionOwner(owner.pid)?.start === owner.start,
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
  };
}

/** systemctl / systemd-run of the user manager, bounded and without a shell. */
export function nodeSystemdCommand(
  file: "systemctl" | "systemd-run",
  env: NodeJS.ProcessEnv,
) {
  return (args: string[]) =>
    new Promise<{ code: number | null; text: string }>((resolve) => {
      execFile(
        file,
        args,
        {
          env: systemdEnv(env),
          timeout: 30_000,
          maxBuffer: 64 * 1024,
          encoding: "utf8",
        },
        (error, stdout) => {
          const code =
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === "number"
                ? Number((error as { code?: unknown }).code)
                : null;
          resolve({ code, text: String(stdout ?? "") });
        },
      );
    });
}

/** One argument of a systemd command line, never split or expanded. */
const systemdWord = (arg: string) =>
  `"${arg.replace(/[\\"]/gu, "\\$&").replace(/%/gu, "%%").replace(/\$/gu, "$$$$")}"`;

/**
 * `systemd-run` arguments of the C-767 restart helper. C-770: the helper unit
 * also runs `self-deploy recover-upgrade` as `ExecStopPost=`, which systemd
 * starts whenever the helper exits, even when it was killed or crashed after
 * restarting the supervisor; with the helper finished normally there is no
 * plan left and the recovery does nothing. Its stop timeout covers a full
 * upgrade window, a rollback window and slack.
 */
export function supervisorHelperArguments(options: {
  attempt: string;
  node: string;
  bin: string;
  dataDir: string;
  path: string | undefined;
  runtimeDir: string | undefined;
  healthTimeoutMs: number;
}): string[] {
  const recover = [options.node, options.bin, "self-deploy", "recover-upgrade"]
    .map(systemdWord)
    .join(" ");
  return [
    "--user",
    "--collect",
    "--quiet",
    `--unit=cardigan-supervisor-upgrade-${options.attempt.slice(0, 8)}`,
    `--setenv=CARDIGAN_DATA_DIR=${options.dataDir}`,
    `--setenv=PATH=${options.path}`,
    ...(options.runtimeDir
      ? [`--setenv=XDG_RUNTIME_DIR=${options.runtimeDir}`]
      : []),
    `--property=ExecStopPost=${recover}`,
    `--property=TimeoutStopSec=${Math.ceil((2 * options.healthTimeoutMs + 120_000) / 1000)}s`,
    "--",
    options.node,
    options.bin,
    "self-deploy",
    "finish-upgrade",
  ];
}

/** Only what the user manager connection needs, never Agent tokens. */
export function systemdEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
  for (const key of ["HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"])
    if (env[key]) out[key] = env[key];
  return out;
}

/**
 * C-767: deployments and the supervisor upgrade of one process share the
 * single capacity waiter row. It is released only when neither still waits,
 * so one never reopens check admission under the other.
 */
export class SharedCapacityWait {
  private readonly waiting = new Set<"deploy" | "upgrade">();
  constructor(private readonly release: () => void) {}
  set(who: "deploy" | "upgrade", waiting: boolean) {
    if (waiting) this.waiting.add(who);
    else {
      this.waiting.delete(who);
      if (!this.waiting.size) this.release();
    }
  }
}
