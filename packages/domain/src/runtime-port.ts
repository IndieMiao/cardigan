import type { Assignment, Machine, RuntimeRef } from "./entities.js";
import type { Role } from "./role.js";

export const runtimeErrorCodes = [
  "runtime_not_found",
  "runtime_unavailable",
  "version_mismatch",
  "runtime_timeout",
  "runtime_queue_timeout",
  "runtime_conflict",
  "invalid_launch",
] as const;
export type RuntimeErrorCode = (typeof runtimeErrorCodes)[number];
export interface RuntimeError {
  readonly code: RuntimeErrorCode;
  readonly message: string;
  /** A launch was attempted but its result cannot rule out a created scope. */
  readonly launch_may_exist?: true;
}
export type RuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RuntimeError };
/** Host-compiled launch instructions, with no Token or provider secret values. */
export interface RuntimeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly agent_name: string;
  readonly labels: Readonly<Record<string, string>>;
}
export interface RuntimeObservation {
  readonly process: "alive" | "exited" | "unknown";
  readonly agent: "working" | "blocked" | "done" | "idle" | "error" | "unknown";
  /** Runtime event sequence, never a local timestamp. */
  readonly observed_seq: number;
}
export interface RuntimeWakeOptions {
  readonly if_idle?: boolean;
  /** Synchronous fresh authority check after all waits, immediately before IO.
   * The adapter must not await between this check and starting the send.
   */
  readonly before_send?: () => boolean;
}
export type RuntimeWakeResult =
  | { readonly sent: boolean; readonly withdrawn?: never }
  /** Only a rejected before_send check proves that no send was attempted. */
  | { readonly sent: false; readonly withdrawn: true };
/** Trusted observation of the entire launch scope, including detached descendants.
 * Terminal absence and PID/name scans cannot establish this proof.
 */
export interface RuntimeExitEvidence {
  readonly ref: RuntimeRef;
  readonly state: "exited" | "alive" | "unknown";
}
export function runtimeExitMatches(
  evidence: RuntimeExitEvidence,
  ref: RuntimeRef,
): boolean {
  const binding = (r: RuntimeRef) => [
    r.machine_id,
    r.runtime_machine,
    r.terminal_ref,
    r.agent_name,
    r.agent_session_id,
    r.worktree_path,
    r.branch,
    r.target?.project_id,
    r.target?.machine_id,
    r.target?.session,
    r.target?.generation,
    r.target?.fingerprint,
  ];
  return (
    evidence.state === "exited" &&
    JSON.stringify(binding(evidence.ref)) === JSON.stringify(binding(ref))
  );
}
export interface Runtime {
  /** Unsupported capability, failures and unknown evidence prohibit cleanup. */
  verifyExit?(ref: RuntimeRef): Promise<RuntimeResult<RuntimeExitEvidence>>;
  provision(
    assignment: Assignment,
    role: Role,
    machine: Machine,
    launch: RuntimeLaunch,
  ): Promise<RuntimeResult<RuntimeRef>>;
  /** Failure or sent=false alone does not prove non-delivery; withdrawn does. */
  wake(
    ref: RuntimeRef,
    doorbell: string,
    options?: RuntimeWakeOptions,
  ): Promise<RuntimeResult<RuntimeWakeResult>>;
  status(ref: RuntimeRef): Promise<RuntimeResult<RuntimeObservation>>;
  interrupt(ref: RuntimeRef): Promise<RuntimeResult<void>>;
  resume_or_replace(
    ref: RuntimeRef,
    launch: RuntimeLaunch,
  ): Promise<RuntimeResult<RuntimeRef>>;
  human_entry(ref: RuntimeRef): Promise<RuntimeResult<string>>;
  /** Runtime terminal only; never removes a worktree. */
  release(
    ref: RuntimeRef,
    options: { readonly force: boolean },
  ): Promise<RuntimeResult<void>>;
}
