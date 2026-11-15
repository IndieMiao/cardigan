import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { RuntimeErrorCode, RuntimeResult } from "@cardigan/domain";

/** What an Agent command (`hc exec`) printed and returned when it failed. */
export interface AgentCommandFailure {
  /** The program's exit status, when hc propagated one. */
  readonly exit_code?: number;
  /** Last 8 KiB of stderr; callers must redact before logging or storing. */
  readonly stderr: string;
}
export class RuntimeFailure extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly detail?: AgentCommandFailure,
  ) {
    super(message);
  }
}
/**
 * Turn a failed Agent command into an execFile-shaped error (`code` is the
 * exit status when known, `stderr` the program output), so Git failure
 * classification works the same for local and agent-ssh Git.
 */
export function agentCommandError(error: {
  readonly code: RuntimeErrorCode;
  readonly message: string;
  readonly detail?: AgentCommandFailure;
}): Error & {
  code: number | RuntimeErrorCode;
  stderr: string;
  executionExited: false;
} {
  return Object.assign(new Error(`${error.code}: ${error.message}`), {
    code: error.detail?.exit_code ?? error.code,
    stderr: error.detail?.stderr ?? "",
    // hc's exit belongs to the local client. Neither a numeric code nor its
    // stderr is a verified exit acknowledgement from the remote Git process.
    executionExited: false as const,
  });
}
export function fail(code: RuntimeErrorCode, message: string): never {
  throw new RuntimeFailure(code, message);
}
/** Keep programming-error context without dumping child output, stacks or credentials. */
function unexpectedMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Runtime operation failed";
  let message = error.message;
  for (const [, value] of Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /token|secret|password|(?:api|private)_?key|auth/i.test(key) && value,
    )
    .sort((a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0))) {
    if (value) message = message.replaceAll(value, "[redacted]");
  }
  message = message
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[redacted]",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]")
    .replace(
      /([\w.-]*(?:token|secret|password|api[_-]?key|private[_-]?key|authorization)[\w.-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi,
      "$1[redacted]",
    )
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
  return message
    ? `Runtime operation failed: ${message.slice(0, 1000)}`
    : "Runtime operation failed";
}
export async function result<T>(
  operation: () => Promise<T>,
): Promise<RuntimeResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code:
          error instanceof RuntimeFailure ? error.code : "runtime_unavailable",
        message:
          error instanceof RuntimeFailure
            ? error.message
            : unexpectedMessage(error),
      },
    };
  }
}
function hcError(stderr: string, exit?: unknown): RuntimeFailure {
  let kind = "unavailable",
    structured = true;
  try {
    kind = JSON.parse(stderr).error.kind;
  } catch {
    // Non-JSON output is the executed program's own failure (hc exec
    // propagates its exit status); keep it for the caller to classify.
    structured = false;
  }
  const code: RuntimeErrorCode =
    kind === "not_found"
      ? "runtime_not_found"
      : [
            "finished",
            "blocked",
            "status_mismatch",
            "name_taken",
            "live",
          ].includes(kind)
        ? "runtime_conflict"
        : ["invalid_params", "invalid_template", "usage"].includes(kind)
          ? "invalid_launch"
          : "runtime_unavailable";
  return new RuntimeFailure(
    code,
    `hc refused the operation (${kind})`,
    structured
      ? undefined
      : {
          ...(typeof exit === "number" ? { exit_code: exit } : {}),
          stderr: stderr.slice(-8192),
        },
  );
}
export interface HcClient {
  exec(args: readonly string[], timeoutMs?: number): Promise<string>;
  lines(args: readonly string[], signal?: AbortSignal): AsyncIterable<string>;
  available(): Promise<boolean>;
}
export function processClient(
  binary: string,
  env: NodeJS.ProcessEnv,
  socket: string,
  timeoutMs: number,
): HcClient {
  return {
    available: async () => {
      try {
        return (await stat(socket)).isSocket();
      } catch {
        return false;
      }
    },
    exec: (args, commandTimeoutMs = timeoutMs) =>
      new Promise((resolve, reject) => {
        execFile(
          binary,
          [...args],
          {
            env,
            timeout: commandTimeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error)
              reject(
                error.killed
                  ? new RuntimeFailure(
                      "runtime_timeout",
                      "hc command timed out",
                    )
                  : hcError(stderr, error.code),
              );
            else resolve(stdout);
          },
        );
      }),
    async *lines(args, signal) {
      const child = spawn(binary, [...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let failure: Error | undefined,
        stderr = "",
        timedOut = false;
      const closed = new Promise<void>((resolve) => {
        child.once("error", (error) => {
          failure = error;
        });
        child.once("close", (code) => {
          if (code && !failure) failure = hcError(stderr);
          resolve();
        });
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-8192);
      });
      const stop = () => {
        child.kill("SIGKILL");
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          stop();
        },
        Math.max(timeoutMs, 20000),
      );
      const input = createInterface({ input: child.stdout });
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      try {
        for await (const line of input) {
          timer.refresh();
          yield line;
        }
        await closed;
        if (signal?.aborted) return;
        if (timedOut)
          fail("runtime_timeout", "hc event stream stopped responding");
        if (failure) throw failure;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        input.close();
        stop();
        await closed;
      }
    },
  };
}
