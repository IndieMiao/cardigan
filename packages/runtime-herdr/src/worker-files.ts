import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { RuntimeTargetBinding } from "@cardigan/domain";
import type { LaunchFile } from "./agent-files.js";
import { agentProcessCommand } from "./agent-ssh.js";
import type { ExecutionConfig, WorkerPublishLimits } from "./execution.js";
import {
  WorkerPreparationFailure,
  WorkerTransportUnavailable,
} from "./worker-preparation-failure.js";
import type { WorkerProcessIdentity } from "./worker-primitives.js";

export type { WorkerPublishLimits } from "./execution.js";

/** Q-535: trusted deployment input; intentionally no protocol defaults. */

export function workerPublishLimits(value: unknown): WorkerPublishLimits {
  const invalid = (): never => {
    throw new Error("Worker publication limits invalid");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const fields = [
    "header_max_bytes",
    "file_max_bytes",
    "batch_max_bytes",
    "timeout_ms",
  ] as const;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== fields.length ||
    !fields.every(
      (field) => Number.isSafeInteger(input[field]) && Number(input[field]) > 0,
    )
  )
    return invalid();
  const limits = Object.fromEntries(
    fields.map((field) => [field, input[field]]),
  ) as unknown as WorkerPublishLimits;
  // The timer bound is the platform's representable timeout, not a deployment default.
  if (
    limits.file_max_bytes > limits.batch_max_bytes ||
    limits.timeout_ms > 2147483647
  )
    return invalid();
  return limits;
}

export interface WorkerFileIdentity {
  readonly project: string;
  readonly assignment: string;
  readonly run: string;
  readonly generation: string;
  readonly target: string;
}
export interface WorkerRemotePath {
  readonly kind: "worker-remote";
  readonly value: string;
  readonly target: RuntimeTargetBinding;
}
export interface WorkerFileReply extends WorkerFileIdentity {
  readonly version: 1;
  readonly phase:
    | "empty"
    | "receiving"
    | "published"
    | "start"
    | "running"
    | "revoked";
  readonly process: WorkerProcessIdentity | null;
  readonly observed: "alive" | "exited" | "unknown";
  readonly worktree?: string;
}
type Operation = "publish" | "commit" | "clear" | "status" | "inspect";
type WorkerExecution = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
const trailer = Buffer.from("\nCARDIGAN-PUBLISH-1\n");
const allowedFile =
  /^(?:core\.md|first\.md|run-command\.py|launch\.sh|launch\.json|token|secrets\.env|codex\/config\.toml|pi\/(?:models\.json|mcp\.json|trust\.json|extensions\/cardigan-context-usage\.js)|mcp\.json|cardigan-assignment\.[A-Za-z0-9_.-]+\.claude-settings\.json)$/u;
class PublicationError extends Error {}
const rejected = (summary = "invalid publication"): never => {
  throw new PublicationError(`Worker publication rejected: ${summary}`);
};

export function workerSessionPath(
  config: WorkerExecution,
  identity: WorkerFileIdentity,
) {
  return generationPath(config, identity, "sessions").value;
}
export function workerLaunchPath(
  config: WorkerExecution,
  identity: WorkerFileIdentity,
) {
  return generationPath(config, identity, "generations");
}
function generationPath(
  config: WorkerExecution,
  identity: WorkerFileIdentity,
  parent: "sessions" | "generations",
): WorkerRemotePath {
  if (
    !config.target ||
    config.target.project_id !== identity.project ||
    config.target.fingerprint !== identity.target ||
    !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(identity.project) ||
    !/^A-[1-9][0-9]*$/u.test(identity.assignment) ||
    !/^R-[1-9][0-9]*$/u.test(identity.run) ||
    !/^[a-f0-9]{32}$/u.test(identity.generation)
  )
    return rejected();
  return {
    kind: "worker-remote",
    target: config.target,
    value: posix.join(
      config.agentRoot,
      "runs",
      identity.project,
      identity.assignment,
      parent,
      identity.generation,
    ),
  };
}

/** Pure encoder. Secret files carry lengths only; no secret digest is generated. */
export function workerFileRequest(
  config: WorkerExecution,
  identity: WorkerFileIdentity,
  operation: Operation,
  files: readonly LaunchFile[] = [],
  worktree?: string,
): Buffer {
  const policy = workerPublishLimits(config.publication);
  const root = workerLaunchPath(config, identity).value;
  let total = 0;
  const names = new Set<string>();
  const entries = files
    .map((file) => {
      const name = posix.relative(root, file.path),
        secret = ["token", "secrets.env"].includes(name);
      const data = Buffer.from(file.content);
      total += data.byteLength;
      if (!allowedFile.test(name)) return rejected("filename_rejected");
      if (
        names.has(name) ||
        file.path !== posix.join(root, name) ||
        file.mode !== (name === "launch.sh" ? 0o700 : 0o600) ||
        data.byteLength > policy.file_max_bytes ||
        !Number.isSafeInteger(total) ||
        total > policy.batch_max_bytes
      )
        return rejected();
      names.add(name);
      return {
        secret,
        data,
        entry: {
          name,
          size: data.byteLength,
          mode: file.mode,
          ...(secret
            ? {}
            : { sha256: createHash("sha256").update(data).digest("hex") }),
        },
      };
    })
    .sort((a, b) => Number(a.secret) - Number(b.secret));
  if (
    operation === "publish"
      ? !names.has("token") || !names.has("launch.sh")
      : files.length > 0
  )
    return rejected();
  const header = Buffer.from(
    `${JSON.stringify({
      version: 1,
      ...identity,
      operation,
      root: posix.join(config.agentRoot, "runs", identity.project),
      files: entries.map((e) => e.entry),
      ...(operation === "inspect" ? { worktree } : {}),
    })}\n`,
  );
  if (header.byteLength > policy.header_max_bytes) return rejected();
  return Buffer.concat([header, ...entries.map((e) => e.data), trailer]);
}

/** Fixed SSH stdin transport. No payload, native diagnostic or command enters errors. */
export async function workerFiles(
  config: WorkerExecution,
  identity: WorkerFileIdentity,
  operation: Operation,
  files: readonly LaunchFile[] = [],
  worktree?: string,
): Promise<WorkerFileReply> {
  const started = Date.now(),
    policy = workerPublishLimits(config.publication);
  const payload = workerFileRequest(
    config,
    identity,
    operation,
    files,
    worktree,
  );
  if (
    !config.fileHelper ||
    ![config.fileHelper.python, config.fileHelper.path].every(
      (path) =>
        /^\/[A-Za-z0-9._/-]+$/u.test(path) &&
        posix.normalize(path) === path &&
        !path.endsWith("/"),
    )
  )
    return rejected();
  let output: Buffer;
  try {
    const command = await agentProcessCommand(config, [
      config.fileHelper.python,
      "-I",
      "-B",
      config.fileHelper.path,
      JSON.stringify(policy),
    ]);
    const remaining = policy.timeout_ms - (Date.now() - started);
    if (remaining <= 0) return rejected();
    output = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(command.file, command.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      // Drain stderr; only a complete fixed diagnostic can cross the SSH boundary.
      let stderr = Buffer.alloc(0);
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 256)
          stderr = Buffer.concat([
            stderr,
            chunk.subarray(0, 256 - stderr.length),
          ]);
      });
      let size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), remaining);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > policy.header_max_bytes) child.kill("SIGKILL");
        else chunks.push(chunk);
      });
      child.on("error", reject);
      child.stdin.on("error", () => {
        /* EPIPE: wait for the remote exit and its diagnostic. */
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (
          code !== 0 ||
          size > policy.header_max_bytes ||
          Date.now() - started >= policy.timeout_ms
        ) {
          const text = stderr.toString().trim();
          const summary =
            stderr.length < 256 &&
            /^worker_(?:filename_rejected|permission_denied|disk_error|timeout|publication_rejected)$/u.test(
              text,
            )
              ? text
              : Date.now() - started >= policy.timeout_ms
                ? "timeout"
                : size > policy.header_max_bytes
                  ? "reply_too_large"
                  : "unknown (stderr omitted)";
          const Failure =
            (code === 255 &&
              /(?:connection refused|connection timed out|no route to host|network is unreachable)/iu.test(
                text,
              )) ||
            summary === "timeout"
              ? WorkerTransportUnavailable
              : WorkerPreparationFailure;
          reject(
            new Failure(
              `Worker publication rejected: ${operation}; exit=${code ?? "signal"}; ${summary}`,
            ),
          );
        } else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(payload);
    });
  } catch (error) {
    if (
      error instanceof WorkerPreparationFailure ||
      error instanceof PublicationError
    )
      throw error;
    // Credential inspection or spawning the local SSH executable failed. Never
    // propagate the local path or count this against the intended machine.
    return rejected(`${operation}; SSH entry unavailable`);
  }
  try {
    const reply = JSON.parse(output.toString()) as WorkerFileReply;
    if (
      reply.version !== 1 ||
      Object.entries(identity).some(
        ([key, value]) => reply[key as keyof WorkerFileIdentity] !== value,
      ) ||
      ![
        "empty",
        "receiving",
        "published",
        "start",
        "running",
        "revoked",
      ].includes(reply.phase) ||
      (operation !== "status" &&
        operation !== "inspect" &&
        reply.phase !==
          (
            { publish: "published", commit: "start", clear: "revoked" } as const
          )[operation])
    )
      return rejected();
    if (
      !["alive", "exited", "unknown"].includes(reply.observed) ||
      (reply.process !== null &&
        (!reply.process ||
          reply.process.machine !== identity.target ||
          reply.process.terminal !== identity.generation ||
          ![
            reply.process.uid,
            reply.process.pid,
            reply.process.process_group,
          ].every((n) => Number.isSafeInteger(n) && n > 0) ||
          ![reply.process.boot, reply.process.start].every(
            (v) => typeof v === "string" && /^[A-Za-z0-9:-]+$/u.test(v),
          ))) ||
      (operation === "inspect" && reply.worktree !== worktree)
    )
      return rejected();
    return {
      version: 1,
      ...identity,
      phase: reply.phase,
      process: reply.process
        ? {
            machine: identity.target,
            terminal: identity.generation,
            boot: reply.process.boot,
            uid: reply.process.uid,
            pid: reply.process.pid,
            start: reply.process.start,
            process_group: reply.process.process_group,
          }
        : null,
      observed: reply.observed,
      ...(operation === "inspect" ? { worktree } : {}),
    } as WorkerFileReply;
  } catch {
    // An SSH process completed but its reply failed parsing or validation.
    throw new WorkerPreparationFailure(
      `Worker publication rejected: ${operation}; invalid reply`,
    );
  }
}
