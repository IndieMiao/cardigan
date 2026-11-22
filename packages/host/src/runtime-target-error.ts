import type { RuntimeError } from "@cardigan/domain";

export class RuntimeTargetError extends Error {
  readonly code = "invalid_launch" as const;
  get transient(): boolean {
    return [
      "mcp_timeout",
      "mcp_protocol_error",
      "mcp_gateway_error",
      "mcp_unreachable",
      "worker_unreachable",
      "worker_binding_draining",
      "machine_check_runtime_timeout",
      "machine_check_runtime_queue_timeout",
      "machine_check_runtime_unavailable",
    ].includes(this.reason);
  }
  constructor(readonly reason: string) {
    super(`Runtime target rejected: ${reason}`);
  }
}

// Never persist exception text, SSH parameters or an adapter-provided diagnostic.
const reasons = new Set([
  "target_mismatch",
  "target_changed",
  "target_invalid",
  "machine_unregistered",
  "worker_unconfigured",
  "worker_configuration_incomplete",
  "mcp_config_missing",
  "mcp_config_invalid",
  "machine_not_ready",
  "remote_launch_disabled",
  "worker_binding_draining",
]);
const safe = (value: unknown) =>
  typeof value === "string" && reasons.has(value) ? value : "target_invalid";
export const safeTargetReason = (error: unknown) =>
  error instanceof RuntimeTargetError ? safe(error.reason) : "target_invalid";
export const machineCheckBlockers = (
  error: RuntimeError & { reason?: string },
) =>
  error.code === "invalid_launch"
    ? [error.code, safe(error.reason)]
    : [error.code];

export function targetFailure(
  error: unknown,
): RuntimeError & { reason: string } {
  return {
    code: "invalid_launch",
    reason: safeTargetReason(error),
    message:
      error instanceof RuntimeTargetError
        ? error.message
        : "Runtime target rejected: target_invalid",
  };
}
