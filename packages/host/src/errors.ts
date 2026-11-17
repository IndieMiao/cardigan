/**
 * Stages of a host-side launch, in the order they run (M2 plan §4, M3 §3.1).
 *
 * The stage is part of the failure: a failed start cancels the Run with
 * `<stage> failed` and every entry point reports the same shape.
 */
export const LAUNCH_STEPS = [
  "directory preparation",
  "token issuance",
  "MCP preflight",
  "launch compilation",
  "run directory write",
  "runtime provision",
  "dispatch",
  "sentinel write",
] as const;

export type LaunchStep = (typeof LAUNCH_STEPS)[number] | "cli version";

/** A launch failure that knows which stage produced it (already compensated). */
export class HostLaunchError extends Error {
  readonly step: LaunchStep;

  constructor(
    step: LaunchStep,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "HostLaunchError";
    this.step = step;
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
