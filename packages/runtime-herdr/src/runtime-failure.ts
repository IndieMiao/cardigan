import type { RuntimeErrorCode } from "@cardigan/domain";

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
    readonly hcKind?: string,
  ) {
    super(message);
  }
}

export function hcError(stderr: string, exit?: unknown): RuntimeFailure {
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
    // Preserve only the enumerated hc statuses classified above, never remote text.
    structured && (code !== "runtime_unavailable" || kind === "unavailable")
      ? kind
      : undefined,
  );
}
