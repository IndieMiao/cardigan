import { setTimeout as delay } from "node:timers/promises";

/** What a bell failure event and the server log may show about a Git error. */
export interface PreparationFailure {
  readonly category:
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
  /\.lock'?:? File exists|cannot lock ref|Unable to create '[^']*\.lock'|could not lock|another git process seems to be running/iu;
const NETWORK =
  /Could not resolve host|Connection (?:refused|reset|timed out|closed)|early EOF|remote end hung up|unable to access|RPC failed|Network is unreachable|ssh: connect to host|Broken pipe|Temporary failure in name resolution/iu;

/** Redact credentials and keep one bounded line; paths stay for diagnosis. */
export function redactFailureLine(text: string): string {
  const line =
    text
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1***@")
    .replace(/\b(Bearer|Basic)\s+\S+/giu, "$1 ***")
    .replace(
      /\b(token|password|passwd|secret|api[_-]?key|authorization)(\s*[=:]\s*)\S+/giu,
      "$1$2***",
    )
    .replace(
      /\b(?:gh[pousr]_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{8,}/gu,
      "***",
    )
    .slice(0, 300);
}

/** Classify a worktree preparation error from its Git exit code and output. */
export function describePreparationFailure(error: unknown): PreparationFailure {
  if (error instanceof PreparationError) return error.failure;
  const e = (error ?? {}) as {
    code?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const message =
    typeof e.message === "string" ? e.message : String(error ?? "");
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  // execFile puts the whole argv on the first message line; stderr says why.
  const text = [stderr, message].join("\n");
  const exit_code = typeof e.code === "number" ? e.code : undefined;
  const line = redactFailureLine(
    stderr.trim() ? stderr : message.replace(/^Command failed: [^\n]*\n?/u, ""),
  );
  const shape = (
    category: PreparationFailure["category"],
    retryable: boolean,
  ): PreparationFailure => ({
    category,
    ...(exit_code === undefined ? {} : { exit_code }),
    message: line || redactFailureLine(message),
    retryable,
  });
  if (e.code === "repository_lock_timeout")
    return shape("repository_lock_timeout", true);
  if (LOCK_CONFLICT.test(text)) return shape("git_lock_conflict", true);
  if (NETWORK.test(text)) return shape("git_network", true);
  if (/Git \S+ timed out after \d+ms/u.test(message))
    return shape("git_timeout", false);
  if (exit_code !== undefined || /^Command failed: \S*git\b/u.test(message))
    return shape("git_failed", false);
  if (typeof e.code === "string" && e.code.startsWith("runtime_"))
    return shape("runtime_failed", false);
  return shape("prepare_failed", false);
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
