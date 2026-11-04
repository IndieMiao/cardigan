export const errorCodes = [
  "unauthorized",
  "forbidden_tool",
  "not_found",
  "illegal_transition",
  "invariant_violation",
  "validation_failed",
  "idempotency_conflict",
  "stale_target",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export interface DomainError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainError };

export function validationFailed(message: string): Result<never> {
  return { ok: false, error: { code: "validation_failed", message } };
}
