import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import { agentProcessCommand } from "./agent-ssh.js";
import { type ExecutionConfig, shellQuote } from "./execution.js";

import { WorkerPreparationFailure } from "./worker-preparation-failure.js";

type Worker = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
export type WorkerGitOperation =
  | "snapshot"
  | "check"
  | "stage"
  | "validate"
  | "publish"
  | "git"
  | "exists"
  | "prepare"
  | "remove-empty"
  | "directories"
  | "receive-pack"
  | "upload-pack";
export interface WorkerGitRequest {
  readonly operation: WorkerGitOperation;
  readonly project: string;
  readonly assignment: string;
  readonly timeout_ms: number;
  readonly repository?: string;
  readonly source?: string;
  readonly format?: "sha1" | "sha256";
  readonly branch?: string;
  readonly generation?: string;
  readonly args?: readonly string[];
}

/** Only trusted target configuration supplies the entry, root, PATH and account. */
export async function workerGitCommand(
  config: Worker,
  request: WorkerGitRequest,
) {
  if (
    !config.target ||
    config.target.project_id !== request.project ||
    !config.gitHelper ||
    !config.path ||
    !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(request.project) ||
    !/^A-[1-9][0-9]*$/u.test(request.assignment) ||
    ![config.gitHelper.python, config.gitHelper.path].every(
      (path) =>
        /^\/[A-Za-z0-9._/-]+$/u.test(path) &&
        posix.normalize(path) === path &&
        !path.endsWith("/"),
    ) ||
    !Number.isSafeInteger(request.timeout_ms) ||
    request.timeout_ms <= 0 ||
    request.timeout_ms > 2147483647
  )
    throw new Error("Worker Git target unavailable");
  const header = JSON.stringify({
    ...request,
    root: config.agentRoot,
    path: config.path,
  });
  if (Buffer.byteLength(header) > 65536)
    throw new Error("Worker Git request too large");
  try {
    return await agentProcessCommand(config, [
      config.gitHelper.python,
      "-I",
      "-B",
      config.gitHelper.path,
      header,
    ]);
  } catch {
    // Credential-file checks can throw a filesystem error containing its path.
    throw new Error(
      `Worker Git operation failed (${request.operation}: SSH entry unavailable)`,
    );
  }
}

/** Project both direct SSH exits and stderr forwarded by host Git to fixed labels. */
export function workerGitFailure(
  operation: WorkerGitOperation,
  error: unknown,
): Error {
  type Exit = {
    code?: unknown;
    stderr?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  const e = error as (Exit & { cause?: Exit }) | null;
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  const code = e?.code;
  // On a pack push, host Git normally exits 128 rather than forwarding SSH's 255.
  const pack = operation === "receive-pack" || operation === "upload-pack";
  // For a pack the direct process is host Git. Its exit or timer alone says
  // nothing about the worker: require a helper/SSH diagnostic in that case.
  const [reason, fromWorker] = ((): [string, boolean] => {
    if (
      (e?.killed && e.signal === "SIGKILL") ||
      (e?.cause?.killed && e.cause.signal === "SIGKILL")
    )
      return ["command timed out", !pack];
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      return ["output limit exceeded", !pack];
    if (
      (code === 75 || pack) &&
      /(?:^|\n)worker_git_rejected(?:\r?\n|$)/u.test(stderr)
    )
      return ["helper rejected request", true];
    if (code === 255 || pack) {
      if (/connection timed out|operation timed out/iu.test(stderr))
        return ["SSH connection timed out", true];
      if (
        /permission denied/iu.test(stderr) &&
        (!pack ||
          /permission denied \(publickey|ssh:.*permission denied/iu.test(
            stderr,
          ) ||
          code === 255)
      )
        return ["SSH permission denied", true];
      if (/host key verification failed/iu.test(stderr))
        return ["SSH host key verification failed", true];
      if (/connection refused/iu.test(stderr))
        return ["SSH connection refused", true];
      if (code === 255) return ["SSH transport failed", true];
    }
    if (code === "ENOENT") return ["SSH executable not found", false];
    if (code === "EACCES") return ["SSH executable permission denied", false];
    return pack
      ? ["pack transfer failed", false]
      : ["process failed", typeof code === "number" && code > 0 && code <= 255];
  })();
  const status =
    typeof code === "number" &&
    Number.isInteger(code) &&
    code >= 0 &&
    code <= 255
      ? `; exit ${code}`
      : "";
  // Neither child exit nor a killed local Git/SSH proves the remote mutation stopped.
  const Failure = fromWorker ? WorkerPreparationFailure : Error;
  return Object.assign(
    new Failure(
      `Worker Git operation failed (${operation}: ${reason}${status})`,
    ),
    { executionExited: false },
  );
}

function validReply(operation: WorkerGitOperation, value: unknown): boolean {
  switch (operation) {
    case "exists":
    case "check":
      return typeof value === "boolean";
    case "directories":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "snapshot":
      return (
        typeof value === "string" &&
        /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)
      );
    case "git":
    case "stage":
      return typeof value === "string";
    case "prepare":
    case "publish":
    case "validate":
    case "remove-empty":
      return value === null;
    default:
      return false; // Pack operations have a binary stream, not a JSON response.
  }
}

export async function workerGit<T>(
  config: Worker,
  request: WorkerGitRequest,
): Promise<T> {
  const command = await workerGitCommand(config, request);
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(command.file, command.args, {
      timeout: request.timeout_ms,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    throw workerGitFailure(request.operation, error);
  }
  try {
    const reply: unknown = JSON.parse(stdout);
    if (validReply(request.operation, reply)) return reply as T;
  } catch {
    // A parser error can quote the response; never propagate it.
  }
  throw new WorkerPreparationFailure(
    `Worker Git operation failed (${request.operation}: invalid helper response)`,
  );
}

/** Git owns the binary stream; never capture or encode a pack as text. */
export async function workerGitPack(
  config: Worker,
  request: WorkerGitRequest,
): Promise<string> {
  if (!["receive-pack", "upload-pack"].includes(request.operation))
    throw new Error("Invalid worker pack operation");
  const command = await workerGitCommand(config, request);
  return `sh -c ${shellQuote(`exec ${[command.file, ...command.args].map(shellQuote).join(" ")}`)} --`;
}
