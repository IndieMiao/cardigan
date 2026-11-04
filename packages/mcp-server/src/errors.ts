import type { DomainError, ErrorCode } from "@cardigan/domain";

export const ERROR_CODES = [
  "unauthorized",
  "forbidden_tool",
  "not_found",
  "illegal_transition",
  "invariant_violation",
  "validation_failed",
  "idempotency_conflict",
  "stale_target",
] as const;

/** A tool refused the call with one of the domain error codes (§4.3). */
export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }

  static notFound(message: string): ToolError {
    return new ToolError("not_found", message);
  }

  static validation(
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): ToolError {
    return new ToolError("validation_failed", message, details);
  }

  static forbiddenTool(tool: string): ToolError {
    return new ToolError(
      "forbidden_tool",
      `tool ${tool} is not allowed for this role`,
      {
        tool,
      },
    );
  }

  toDomainError(): DomainError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/** Convert anything thrown by a handler into a domain error. */
export function toDomainError(error: unknown): DomainError {
  if (error instanceof ToolError) {
    return error.toDomainError();
  }
  if (isDomainError(error)) {
    return error;
  }
  return {
    code: "validation_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isDomainError(value: unknown): value is DomainError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof (value as { code?: unknown }).code === "string" &&
    (ERROR_CODES as readonly string[]).includes(
      (value as { code: string }).code,
    )
  );
}
