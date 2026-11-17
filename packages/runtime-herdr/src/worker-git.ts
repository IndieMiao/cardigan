import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import { agentProcessCommand } from "./agent-ssh.js";
import { type ExecutionConfig, shellQuote } from "./execution.js";

type Worker = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
export type WorkerGitOperation =
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
  return agentProcessCommand(config, [
    config.gitHelper.python,
    "-I",
    "-B",
    config.gitHelper.path,
    header,
  ]);
}

export async function workerGit<T>(
  config: Worker,
  request: WorkerGitRequest,
): Promise<T> {
  const command = await workerGitCommand(config, request);
  try {
    const { stdout } = await promisify(execFile)(command.file, command.args, {
      timeout: request.timeout_ms,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout) as T;
  } catch {
    // SSH/helper errors are failures even when a mutation may already have happened.
    throw new Error("Worker Git operation failed");
  }
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
