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
export interface RuntimeLaunchRecovery {
  /** Recover a lost provision acknowledgement by exact host labels, never by name alone. */
  find_launch(
    assignment: Assignment,
    launch: RuntimeLaunch,
  ): Promise<RuntimeResult<RuntimeRef>>;
}
export interface RuntimeWakeOptions {
  readonly if_idle?: boolean;
  /** For exact states hc cannot compare with --if. Re-read after the send slot is held.
   * Unknown requires additional positive evidence from this exact harness turn. */
  readonly observed_guard?:
    | { state: "done" }
    | { state: "unknown"; confirm_turn_end: () => Promise<boolean> };
  /** Synchronous fresh authority check after all waits, immediately before IO.
   * The adapter must not await between this check and starting the send.
   */
  /** Target preflight inside the acquired send slot, before synchronous authority. */
  readonly resource_preflight?: () => Promise<boolean>;
  readonly before_send?: () => boolean;
}
export type RuntimeWakeResult =
  | { readonly sent: boolean; readonly withdrawn?: never }
  /** A failed pre-send authority or observation check proves no send was attempted. */
  | { readonly sent: false; readonly withdrawn: true };
export interface RuntimeInteractionReader {
  /** Host-only, fixed target diagnostic. Returns enums, never terminal text. */
  interaction(
    ref: RuntimeRef,
    identity: { project_id: string; assignment_id: string; harness: string },
  ): Promise<RuntimeResult<import("./interaction.js").InteractionState>>;
}
export interface Runtime {
  /** Optional host-only idle retirement. Never escalates beyond HUP/TERM. */
  retire_idle?(
    ref: RuntimeRef,
    options: {
      readonly project_id: string;
      readonly assignment_id: string;
      readonly hangup_ms: number;
      readonly terminate_ms: number;
      readonly before_signal: () => boolean;
    },
  ): Promise<
    RuntimeResult<{ readonly exited: boolean; readonly withdrawn?: boolean }>
  >;
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
