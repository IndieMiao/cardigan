import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  AGENT_PATH,
  agentProcessCommand,
  type ExecutionConfig,
  LOCAL_RUNTIME_WARNING,
  prepareAgentCheckout,
  prepareCheckLock,
  prepareCheckoutAlias,
  secureDataDirectory,
} from "@cardigan/runtime-herdr";
import { checkEnvironment } from "./check-environment.js";
import { CHECKOUT_WORKER } from "./checkout-worker.js";
import { type ExecutionOwner, executionOwner } from "./merge-check-capacity.js";

export interface CheckoutCheck {
  readonly name: string;
  readonly run: string;
  readonly timeoutMs?: number;
}
export type CheckoutStatus = "passed" | "failed" | "timed_out" | "interrupted";
export interface CheckoutResult {
  readonly status: CheckoutStatus | "executor_unreachable";
  readonly checks: readonly {
    readonly name: string;
    readonly status: CheckoutStatus | "not_run";
    readonly exit_code?: number | null;
    readonly duration_ms?: number;
  }[];
  readonly cleanup_errors: readonly string[];
  readonly reason?: string;
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
  /** Private stream: the log consumer must redact configured env values before persistence. */
  readonly onOutput?: (name: string, text: string) => void;
}
const duration = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw new Error("Invalid checkout timeout");
  return value;
};

/** P2a-1/P2a-3: detached checkout, sequential commands, integrity check and unconditional cleanup. */
export async function runInTemporaryCheckout(
  input: CheckoutInput,
  start: (
    file: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams = (file, args, env) =>
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
  const lock = input.serialize
    ? await prepareCheckLock(execution, input.lockSlot ?? 0)
    : undefined;
  const worker = [
    execution.mode === "agent-ssh" ? "node" : process.execPath,
    "-e",
    CHECKOUT_WORKER,
  ];
  const argv = lock
    ? ["flock", "--exclusive", "--no-fork", "--", lock, ...worker]
    : worker;
  const command =
    execution.mode === "agent-ssh"
      ? await agentProcessCommand(execution, argv)
      : { file: argv[0] as string, args: argv.slice(1) };
  const root =
    execution.mode === "agent-ssh"
      ? execution.agentRoot
      : join(execution.dataDir, "agent");
  const repository = join(root, "repos", project);
  let container: string;
  if (execution.mode === "agent-ssh") {
    container = await prepareAgentCheckout(execution, project, attempt);
  } else {
    await secureDataDirectory(execution);
    const parent = join(root, "checks", project);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    container = join(parent, attempt);
    await mkdir(container, { mode: 0o700 });
  }
  // Agent can remove this child, but cannot rename/replace the host-owned attempt namespace.
  const directory = join(container, "worktree");
  let completed: CheckoutResult;
  const cleanupErrors: string[] = [];
  const nonce = randomBytes(32).toString("hex");
  const authKey = randomBytes(32).toString("hex");
  let aliasContainer: string | undefined;
  try {
    aliasContainer = await prepareCheckoutAlias(
      execution,
      `a${randomBytes(7).toString("base64url")}`,
    );
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
      const cancel = () => {
        if (input.serialize && !ready) {
          child.kill("SIGTERM");
          return;
        }
        if (!child.stdin.destroyed) child.stdin.write("cancel\n");
      };
      signal?.addEventListener("abort", cancel, { once: true });
      child.stdin.on("error", () => {});
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
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
            input.onReady?.(owner);
          }
          if (event.type === "output") input.onOutput?.(event.name, event.text);
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
      child.once("error", () =>
        reject(new Error("Checkout execution entry failed")),
      );
      child.once("close", (code) => {
        signal?.removeEventListener("abort", cancel);
        lines.close();
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
          execution.mode === "agent-ssh" &&
          code === 255 &&
          !protocolFailed
        )
          resolve({
            status: "executor_unreachable",
            checks: [],
            cleanup_errors: [],
            reason: "远程检查机 SSH 连接失败，合并检查排队等待重试",
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
        })}\n`,
      );
      if (signal?.aborted) cancel();
    });
  } finally {
    // Host removes only an empty protected leaf, never Agent-controlled contents.
    for (const path of [aliasContainer, container])
      if (path)
        await rmdir(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            cleanupErrors.push("Could not remove temporary checkout container");
            input.onOutput?.("cleanup", `${cleanupErrors[0]}\n`);
          }
        });
  }
  return {
    ...completed,
    cleanup_errors: [...completed.cleanup_errors, ...cleanupErrors],
  };
}
