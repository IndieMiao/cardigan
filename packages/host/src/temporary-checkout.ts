import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  AGENT_PATH,
  type AgentCheckPaths,
  type AgentExecution,
  agentCleanupCheckCommand,
  agentPrepareCheckCommand,
  agentProcessCommand,
  type CheckRecoveryBinding,
  type ExecutionConfig,
  LOCAL_RUNTIME_WARNING,
  prepareAgentCheckout,
  prepareCheckLock,
  prepareCheckoutAlias,
  secureDataDirectory,
  validCheckRecoveryBinding,
} from "@cardigan/runtime-herdr";
import { AFFECTED_PACKAGE_DIR } from "./change-scope.js";
import { checkEnvironment } from "./check-environment.js";
import { CHECKOUT_LIMITS } from "./checkout-limits.js";
import { CHECKOUT_WORKER } from "./checkout-worker.js";
import { type ExecutionOwner, executionOwner } from "./merge-check-capacity.js";
import {
  type VerifiedCheckoutContext,
  verifiedCheckoutContext,
} from "./worker-failure-context.js";

export interface CheckoutCheck {
  readonly name: string;
  readonly run: string;
  readonly timeoutMs?: number;
  /** Host-selected execution metadata, never read from the checkout. */
  readonly skipReason?: "docs_only" | "card_tier";
  readonly affectedPaths?: readonly string[];
}
export type CheckoutStatus = "passed" | "failed" | "timed_out" | "interrupted";
export interface CheckoutResult {
  readonly status: CheckoutStatus | "executor_unreachable";
  readonly checks: readonly {
    readonly name: string;
    readonly status: CheckoutStatus | "not_run" | "skipped";
    readonly reason?: "docs_only" | "card_tier";
    readonly exit_code?: number | null;
    readonly duration_ms?: number;
  }[];
  readonly cleanup_errors: readonly string[];
  readonly reason?: string;
  readonly manual_attention?: boolean;
  /** Trusted GitHub binding, independent of candidate output and signed storage URLs. */
  readonly logSource?: { readonly url: string; readonly jobId?: number };
  /** Non-business failure from the validated baseline workflow step list. */
  readonly failedGithubStep?: string;
  readonly logAttributionIncomplete?: boolean;
  readonly logFailure?:
    | "not_found"
    | "api"
    | "auth"
    | "security"
    | "rate_limited"
    | "job_unavailable"
    | "timeout_or_cancel";
}
export interface CheckoutInput {
  readonly execution: ExecutionConfig;
  readonly project: string;
  /** The caller synchronizes this commit to the project's base clone first. */
  readonly sha: string;
  readonly tree: string;
  readonly attempt?: string;
  readonly checks: readonly CheckoutCheck[];
  readonly env?: Readonly<Record<string, string>>;
  readonly totalTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Merge checks share one OS lock across projects and controller processes. */
  readonly serialize?: boolean;
  /** P2a-12 D: which of the target's `max_concurrent` slot locks to hold (default 0). */
  readonly lockSlot?: number;
  /** Called only after the execution account acquired the slot and authenticated itself. */
  readonly onReady?: (owner?: ExecutionOwner) => void;
  /** Authenticated supervisor verified this exact checkout before candidate commands. */
  readonly onVerifiedCheckout?: (context: VerifiedCheckoutContext) => void;
  /** Persist the authenticated directory instances before enabling later recovery. */
  readonly onRegistered?: (binding: CheckRecoveryBinding) => void;
  /** Private stream: the log consumer must redact configured env values before persistence. */
  readonly onOutput?: (name: string, text: string) => void;
}
const duration = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw new Error("Invalid checkout timeout");
  return value;
};

type Start = (
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => ChildProcessWithoutNullStreams;
/**
 * C-130: an agent-ssh execution with an explicit host is a merge-gate
 * executor (`executorExecution`), which shares no disk with the host. The
 * server's default agent-ssh account (no host) keeps the host-side path.
 */
export function remoteExecution(
  execution: ExecutionConfig,
): AgentExecution | undefined {
  return execution.mode === "agent-ssh" && execution.host !== undefined
    ? execution
    : undefined;
}
/** Fixed preparation diagnostics; never persist a remote command's output. */
export class ExecutorPreparationError extends Error {
  constructor(readonly exitCode: number | null) {
    super("Executor checkout preparation failed");
  }

  get summary(): string {
    // PREPARE_SCRIPT's private protocol. 255 belongs to SSH, never the script.
    const reasons: Readonly<Record<number, string>> = {
      0: "完成标记缺失或无效",
      3: "根目录缺失、为链接或无法进入",
      4: "槽位锁的父目录可被执行账号替换",
      5: "检查容器或短别名无法独占创建",
      7: "槽位锁缺失或属性不安全",
      8: "创建后的容器路径已改变",
      9: "准备目录为链接或无法进入",
      10: "准备目录的真实路径、属主或身份不符",
      255: "SSH 通道失败",
    };
    const reason =
      this.exitCode === null
        ? "命令未正常结束"
        : (reasons[this.exitCode] ?? "命令返回未知错误");
    return `远程检查准备失败：${reason}，请检查执行环境后重新检查`;
  }
}

/** A command succeeds only with exit 0 and the exact completion trailer. */
function runOnExecutor(
  start: Start,
  command: { file: string; args: readonly string[]; expect: string },
  path: string,
  timeoutMs = CHECKOUT_LIMITS.remoteCommandMs,
): Promise<{ code: number | null; complete: boolean }> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = start(command.file, command.args, { PATH: path });
    } catch {
      resolve({ code: null, complete: false });
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code: null, complete: false });
    }, timeoutMs);
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      stdout = (stdout + data).slice(-4096);
    });
    child.stderr.on("data", () => {}); // Never expose SSH diagnostics.
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: null, complete: false });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, complete: code === 0 && stdout === command.expect });
    });
  });
}
async function prepareOnExecutor(
  execution: AgentExecution,
  start: Start,
  path: string,
  input: Parameters<typeof agentPrepareCheckCommand>[1],
): Promise<AgentCheckPaths> {
  // Host-side state stays on the host: the private data directory.
  await secureDataDirectory(execution);
  const command = await agentPrepareCheckCommand(execution, input);
  const result = await runOnExecutor(start, command, path);
  if (!result.complete) throw new ExecutorPreparationError(result.code);
  return command.paths;
}
async function cleanupOnExecutor(
  execution: AgentExecution,
  start: Start,
  path: string,
  paths: AgentCheckPaths,
): Promise<boolean> {
  const result = await runOnExecutor(
    start,
    await agentCleanupCheckCommand(execution, paths),
    path,
  );
  return result.complete;
}

/** P2a-1/P2a-3: detached checkout, sequential commands, integrity check and unconditional cleanup. */
export async function runInTemporaryCheckout(
  input: CheckoutInput,
  start: Start = (file, args, env) =>
    spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] }),
): Promise<CheckoutResult> {
  const { execution, project, sha, tree, signal } = input;
  const attempt = input.attempt ?? randomUUID();
  if (
    !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(attempt) ||
    ![sha, tree].every((v) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(v))
  )
    throw new Error("Invalid temporary checkout identity");
  const env = checkEnvironment(input.env);
  const checks = input.checks.map((check) => {
    if (!check.name.trim() || !check.run.trim() || check.run.includes("\0"))
      throw new Error("Check name and command must be nonempty");
    if (
      (check.skipReason !== undefined && check.skipReason !== "docs_only") ||
      (check.affectedPaths !== undefined &&
        (!Array.isArray(check.affectedPaths) ||
          !check.affectedPaths.every(
            (path) =>
              typeof path === "string" && AFFECTED_PACKAGE_DIR.test(path),
          )))
    )
      throw new Error("Invalid checkout scope metadata");
    return { ...check, timeoutMs: duration(check.timeoutMs ?? 30 * 60_000) };
  });
  const totalTimeoutMs = duration(input.totalTimeoutMs ?? 60 * 60_000);
  if (!checks.length) throw new Error("At least one check is required");
  if (signal?.aborted)
    return { status: "interrupted", checks: [], cleanup_errors: [] };
  const path =
    execution.mode === "agent-ssh"
      ? AGENT_PATH
      : "/usr/local/bin:/usr/bin:/bin";
  const alias = `a${randomBytes(7).toString("base64url")}`;
  // C-130: a remote executor shares no disk with the host. Its lock, container
  // and alias are prepared (and later removed) over the executor's own SSH
  // entry; a failure is a start failure, never a fallback to the host.
  const remote = remoteExecution(execution);
  const prepared = remote
    ? await prepareOnExecutor(remote, start, path, {
        project,
        attempt,
        alias,
        ...(input.serialize ? { slot: input.lockSlot ?? 0 } : {}),
      })
    : undefined;
  const lock = prepared
    ? prepared.lock
    : input.serialize
      ? await prepareCheckLock(execution, input.lockSlot ?? 0)
      : undefined;
  const root =
    execution.mode === "agent-ssh"
      ? execution.agentRoot
      : join(execution.dataDir, "agent");
  const worker = [
    execution.mode === "agent-ssh" ? "node" : process.execPath,
    "-e",
    CHECKOUT_WORKER,
    "--",
    join(root, "checks", project, attempt),
  ];
  const argv = lock
    ? [
        "flock",
        "--exclusive",
        "--no-fork",
        "--wait",
        String(CHECKOUT_LIMITS.lockWaitMs / 1000),
        "--conflict-exit-code",
        "75",
        "--",
        lock,
        ...worker,
      ]
    : worker;
  const repository = join(root, "repos", project);
  let command: { file: string; args: string[] };
  let container: string;
  try {
    command =
      execution.mode === "agent-ssh"
        ? await agentProcessCommand(execution, argv)
        : { file: argv[0] as string, args: argv.slice(1) };
    if (prepared) container = prepared.container;
    else if (execution.mode === "agent-ssh") {
      container = await prepareAgentCheckout(execution, project, attempt);
    } else {
      await secureDataDirectory(execution);
      const parent = join(root, "checks", project);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      container = join(parent, attempt);
      await mkdir(container, { mode: 0o700 });
    }
  } catch (error) {
    if (remote && prepared)
      await cleanupOnExecutor(remote, start, path, prepared).catch(() => {});
    throw error;
  }
  // Agent can remove this child, but cannot rename/replace the host-owned attempt namespace.
  const directory = join(container, "worktree");
  let completed: CheckoutResult;
  const cleanupErrors: string[] = [];
  const nonce = randomBytes(32).toString("hex");
  const authKey = randomBytes(32).toString("hex");
  let aliasContainer: string | undefined;
  try {
    aliasContainer = prepared
      ? prepared.alias
      : await prepareCheckoutAlias(execution, alias);
    if (execution.mode === "local")
      input.onOutput?.("system", `${LOCAL_RUNTIME_WARNING}\n`);
    completed = await new Promise<CheckoutResult>((resolve, reject) => {
      // No ambient environment, even for the SSH client or local supervisor.
      const child = start(command.file, command.args, { PATH: path });
      let owner: ExecutionOwner | undefined;
      let ownerError: unknown;
      try {
        owner = child.pid ? executionOwner(child.pid) : undefined;
      } catch (error) {
        // Keep the child under the normal protocol/cancellation lifecycle even
        // when its process identity cannot be read.
        ownerError = error;
      }
      let result: CheckoutResult | undefined;
      let resultCount = 0,
        protocolFailed = false;
      let ready = false;
      let registered = false;
      let closed = false;
      let timer: ReturnType<typeof setTimeout>;
      const dispose = () => {
        closed = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        lines.close();
      };
      const expire = () => {
        dispose();
        child.kill("SIGKILL");
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (protocolFailed) reject(new Error("Invalid checkout protocol"));
        else
          resolve({
            status: signal?.aborted
              ? "interrupted"
              : ready
                ? "timed_out"
                : "executor_unreachable",
            checks: [],
            cleanup_errors: ready
              ? ["检查执行器未按时结束，远端清理未确认"]
              : [],
            reason: ready
              ? "检查超过总时限及宽限时间"
              : "检查槽位或握手等待超时，等待重试",
          });
      };
      const cancel = () => {
        if (closed) return;
        // Repeated invalid messages must not extend the hard deadline.
        if (!cancelling) {
          cancelling = true;
          clearTimeout(timer);
          timer = setTimeout(expire, CHECKOUT_LIMITS.graceMs);
        }
        if (input.serialize && !ready) {
          child.kill("SIGTERM");
          return;
        }
        if (!child.stdin.destroyed) child.stdin.write("cancel\n");
      };
      let cancelling = false;
      signal?.addEventListener("abort", cancel, { once: true });
      child.stdin.on("error", () => {});
      const lines = createInterface({ input: child.stdout });
      timer = setTimeout(expire, CHECKOUT_LIMITS.entryMs);
      let checkoutVerified = false;
      lines.on("line", (line) => {
        if (closed) return;
        try {
          const { auth, ...event } = JSON.parse(line);
          if (event.type === "result") resultCount++;
          if (
            protocolFailed ||
            auth !==
              createHmac("sha256", authKey)
                .update(JSON.stringify(event))
                .digest("hex") ||
            resultCount > 1
          )
            throw new Error("Invalid checkout message");
          if (event.type === "ready") {
            if (ready) throw new Error("Duplicate checkout readiness");
            if (ownerError) throw ownerError;
            ready = true;
            clearTimeout(timer);
            timer = setTimeout(
              expire,
              Math.min(2147483647, totalTimeoutMs + CHECKOUT_LIMITS.graceMs),
            );
            input.onReady?.(owner);
          }
          if (event.type === "checkout_verified") {
            if (!ready || checkoutVerified)
              throw new Error("Duplicate or premature checkout context");
            checkoutVerified = true;
            input.onVerifiedCheckout?.(
              verifiedCheckoutContext({
                project_id: project,
                attempt_id: attempt,
                candidate_sha: sha,
                tree_sha: tree,
                root: directory,
              }),
            );
          }
          if (event.type === "output") input.onOutput?.(event.name, event.text);
          if (event.type === "registered") {
            if (
              !ready ||
              registered ||
              !validCheckRecoveryBinding(event.binding)
            )
              throw new Error("Invalid checkout registration");
            registered = true;
            input.onRegistered?.(event.binding);
          }
          if (event.type === "result") {
            if (event.nonce !== nonce)
              throw new Error("Invalid checkout nonce");
            const { nonce: _nonce, type: _type, ...value } = event;
            result = value as CheckoutResult;
          }
        } catch {
          protocolFailed = true;
          cancel();
        }
      });
      child.stderr.on("data", () => {}); // Never expose arbitrary SSH diagnostics or credential paths.
      child.once("error", () => {
        if (closed) return;
        dispose();
        reject(new Error("Checkout execution entry failed"));
      });
      child.once("close", (code) => {
        if (closed) return;
        dispose();
        if (
          code === 0 &&
          ready &&
          !protocolFailed &&
          resultCount === 1 &&
          result
        )
          resolve(result);
        else if (signal?.aborted && !protocolFailed)
          resolve({ status: "interrupted", checks: [], cleanup_errors: [] });
        else if (
          ((execution.mode === "agent-ssh" && code === 255) ||
            (!ready && input.serialize && code === 75) ||
            (!ready && code === 124)) &&
          !protocolFailed
        )
          resolve({
            status: "executor_unreachable",
            checks: [],
            cleanup_errors: [],
            reason:
              code === 255
                ? "远程检查机 SSH 连接失败，合并检查排队等待重试"
                : "检查槽位或握手等待超时，合并检查排队等待重试",
          });
        else
          reject(
            new Error(
              "Checkout execution ended without a result; verify cleanup",
            ),
          );
      });
      child.stdin.write(
        `${JSON.stringify({
          nonce,
          auth_key: authKey,
          container,
          alias_container: aliasContainer,
          repository,
          directory,
          sha,
          tree,
          checks,
          env,
          path,
          totalTimeoutMs,
          worker_context: input.onVerifiedCheckout !== undefined,
          recovery:
            remote !== undefined &&
            input.serialize === true &&
            input.onRegistered !== undefined,
        })}\n`,
      );
      if (signal?.aborted) cancel();
    });
  } finally {
    const failed = () => {
      cleanupErrors.push("Could not remove temporary checkout container");
      input.onOutput?.("cleanup", `${cleanupErrors[0]}\n`);
    };
    if (remote && prepared) {
      if (
        !(await cleanupOnExecutor(remote, start, path, prepared).catch(
          () => false,
        ))
      )
        failed();
    }
    // Host removes only an empty protected leaf, never Agent-controlled contents.
    else
      for (const path of [aliasContainer, container])
        if (path)
          await rmdir(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") failed();
          });
  }
  return {
    ...completed,
    cleanup_errors: [...completed.cleanup_errors, ...cleanupErrors],
  };
}
