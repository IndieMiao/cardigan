import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import { agentProcessCommand } from "./agent-ssh.js";
import { type ExecutionConfig, shellQuote } from "./execution.js";
import { WorkerPreparationFailure } from "./worker-preparation-failure.js";
import type { WorkerProcessIdentity } from "./worker-primitives.js";

type Worker = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
export type WorkerGitOperation =
  | "verify-sealed-snapshot"
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
  | "usage"
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
  readonly expected?: string;
  readonly process?: WorkerProcessIdentity;
  readonly args?: readonly string[];
}

/** C-666: one kind of the project's own directories on a worker. */
export interface WorkerUsageKind {
  readonly bytes: number;
  readonly directories: number;
}
/**
 * C-666: the `usage` reply of a release helper (publication protocol 3):
 * allocated bytes under the project's worktrees, builds and runs leaves and
 * the free space of the volume holding them. `complete` is false when the
 * walk hit its time or entry budget or an unreadable entry.
 */
export interface WorkerUsageReport {
  readonly free_bytes: number;
  readonly total_bytes: number;
  readonly worktrees: WorkerUsageKind;
  readonly builds: WorkerUsageKind;
  readonly runs: WorkerUsageKind;
  readonly complete: boolean;
}
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function validUsage(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const v = value as Record<string, unknown>;
  const kind = (k: unknown) =>
    typeof k === "object" &&
    k !== null &&
    count((k as Record<string, unknown>).bytes) &&
    count((k as Record<string, unknown>).directories);
  return (
    count(v.free_bytes) &&
    count(v.total_bytes) &&
    Number(v.free_bytes) <= Number(v.total_bytes) &&
    kind(v.worktrees) &&
    kind(v.builds) &&
    kind(v.runs) &&
    typeof v.complete === "boolean"
  );
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
    case "usage":
      return validUsage(value);
    case "verify-sealed-snapshot":
      return value === null || validReply("snapshot", value);
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
