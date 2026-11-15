import { setTimeout as delay } from "node:timers/promises";

/** What a bell failure event and the server log may show about a Git error. */
export interface PreparationFailure {
  readonly category:
    | "preparation_queue_timeout"
    | "repository_lock_timeout"
    | "git_lock_conflict"
    | "git_network"
    | "git_timeout"
    | "git_failed"
    | "runtime_failed"
    | "prepare_failed";
  readonly exit_code?: number;
  /** First line only, credentials redacted, bounded length. */
  readonly message: string;
  readonly retryable: boolean;
}

const LOCK_CONFLICT =
  /\.lock'?:? File exists|cannot lock ref|Unable to create '[^']*\.lock'|could not lock|failed to lock|another git process seems to be running|\.lock'?[:：]\s*文件已存在|无法锁定|另一个 git 进程/iu;
const NETWORK =
  /Could not resolve host|Connection (?:refused|reset|timed out|closed)|early EOF|remote end hung up|unable to access|RPC failed|Network is unreachable|ssh: connect to host|Broken pipe|Temporary failure in name resolution|远程意外挂断|无法访问/iu;

const SECRET_KEY =
  "[\\w.-]*(?:token|secret|password|passwd|pwd|api[_-]?key|private[_-]?key|authorization|auth|credential|cookie|header)[\\w.-]*";
const SECRET_VALUE = `("(?:\\\\.|[^"\\\\])*"?|'(?:\\\\.|[^'\\\\])*'?|[^\\s,;&"']+)`;
// key=value, key: value, "key":"value", key="quoted value", ?access_token=...
const SECRET_PAIR = new RegExp(
  `(${SECRET_KEY}["']?\\s*[:=]\\s*)${SECRET_VALUE}`,
  "giu",
);
const SECRET_ENV = /token|secret|password|(?:api|private)_?key|auth/iu;

/** Remove credentials from free text; used before anything is logged or stored. */
export function redactSecrets(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let out = text;
  // Exact values of secret-looking environment variables, longest first.
  for (const value of Object.entries(env)
    .filter(([key, value]) => SECRET_ENV.test(key) && (value?.length ?? 0) >= 6)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length))
    out = out.replaceAll(value, "***");
  return out
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu,
      "***",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1***@")
    .replace(/\b(Bearer|Basic|token)\s+[^\s"',;]+/giu, "$1 ***")
    .replace(SECRET_PAIR, "$1***")
    .replace(
      /\b(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[abprs]-)[A-Za-z0-9_-]{8,}/gu,
      "***",
    );
}

/** Redact credentials and keep one bounded line; paths stay for diagnosis. */
export function redactFailureLine(text: string): string {
  const line =
    redactSecrets(text)
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.slice(0, 300);
}

/** Classify a worktree preparation error from its Git exit code and output. */
export function describePreparationFailure(error: unknown): PreparationFailure {
  if (error instanceof PreparationError) return error.failure;
  const e = (error ?? {}) as {
    code?: unknown;
    stderr?: unknown;
    message?: unknown;
    executionExited?: unknown;
  };
  if (
    e.code === "preparation_queue_timeout" ||
    e.code === "runtime_queue_timeout"
  )
    return {
      category: "preparation_queue_timeout",
      retryable: true,
      message: "工作目录准备排队超时",
    };
  const message =
    typeof e.message === "string" ? e.message : String(error ?? "");
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  // execFile puts the whole argv on the first message line; stderr says why.
  const text = [stderr, message].join("\n");
  const exit_code = typeof e.code === "number" ? e.code : undefined;
  // Never fall back to the argv line: it can carry `-c` options with secrets.
  const withoutArgv = message.startsWith("Command failed:")
    ? message.split(/\r?\n/u).slice(1).join("\n")
    : message;
  const line =
    redactFailureLine(stderr.trim() ? stderr : withoutArgv) ||
    (exit_code === undefined
      ? "failed without diagnostic output"
      : `git exited with ${exit_code} without diagnostic output`);
  const shape = (
    category: PreparationFailure["category"],
    retryable: boolean,
  ): PreparationFailure => ({
    category,
    ...(exit_code === undefined ? {} : { exit_code }),
    message: line,
    retryable,
  });
  if (e.code === "repository_lock_timeout")
    return shape("repository_lock_timeout", true);
  if (
    ["EACCES", "EPERM"].includes(String(e.code)) ||
    /permission denied|authentication failed|host key verification failed|unsafe|dubious ownership|路径不安全|权限不足/iu.test(
      text,
    )
  )
    return shape("prepare_failed", false);
  if (LOCK_CONFLICT.test(text))
    return shape("git_lock_conflict", e.executionExited !== false);
  if (NETWORK.test(text))
    return shape("git_network", e.executionExited !== false);
  if (/Git \S+ timed out after \d+ms/u.test(message))
    return shape("git_timeout", false);
  if (exit_code !== undefined || /^Command failed: \S*git\b/u.test(message))
    return shape("git_failed", false);
  if (typeof e.code === "string" && e.code.startsWith("runtime_"))
    return shape("runtime_failed", false);
  return shape("prepare_failed", false);
}

/** Do not infer remote exit from a timeout message or a killed hc client. */
export function preparationExecutionExited(error: unknown): boolean {
  if (error instanceof PreparationError)
    return preparationExecutionExited(error.cause);
  const e = (error ?? {}) as { code?: unknown; executionExited?: unknown };
  return (
    e.code === "preparation_queue_timeout" ||
    e.code === "runtime_queue_timeout" ||
    e.code === "repository_lock_timeout" ||
    e.executionExited === true
  );
}

/** A preparation failure that already carries its sanitized description. */
export class PreparationError extends Error {
  readonly code: string;
  constructor(
    readonly failure: PreparationFailure,
    readonly attempts: number,
    options?: { cause?: unknown },
  ) {
    super(
      `${failure.category}${failure.exit_code === undefined ? "" : ` (exit ${failure.exit_code})`}: ${failure.message}`,
      options,
    );
    this.name = "PreparationError";
    this.code = failure.category;
  }
}

export interface PreparationRetryOptions {
  /** Waits between attempts; default 1, 2 and 4 seconds (three retries). */
  readonly delaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (failure: PreparationFailure, attempt: number) => void;
}

/**
 * Short retry inside one delivery for lock contention and transient network
 * errors. Longer recovery belongs to the Dispatcher's bell retry and the
 * dispatched-timeout recovery; this never loops beyond `delaysMs`.
 */
export async function withPreparationRetry<T>(
  prepare: () => Promise<T>,
  options: PreparationRetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? [1_000, 2_000, 4_000],
    sleep = options.sleep ?? ((ms: number) => delay(ms));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prepare();
    } catch (error) {
      const failure = describePreparationFailure(error);
      const wait = delays[attempt - 1];
      if (!failure.retryable || wait === undefined)
        throw new PreparationError(failure, attempt, { cause: error });
      options.onRetry?.(failure, attempt);
      await sleep(wait);
    }
  }
}
