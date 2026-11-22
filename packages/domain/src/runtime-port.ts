import type { Assignment, Machine, RuntimeRef } from "./entities.js";
import type { RunId } from "./ids.js";
import type { Role } from "./role.js";
import type { IdleRetirementResult, RuntimeResult } from "./runtime-types.js";

export * from "./runtime-types.js";

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
/** Both local and worker adapters must repeat this observation at the send slot. */
export function idleWakeGuard(
  observation: RuntimeObservation,
): RuntimeWakeOptions | undefined {
  if (observation.process !== "alive") return;
  if (observation.agent === "idle") return { if_idle: true };
  if (observation.agent === "done")
    return { observed_guard: { state: "done" } };
  return;
}
export interface RuntimeLaunchRecovery {
  /** Recover a lost provision acknowledgement by exact host labels, never by name alone. */
  find_launch(
    assignment: Assignment,
    launch: RuntimeLaunch,
  ): Promise<RuntimeResult<RuntimeRef>>;
}
/** Only the named, currently live CLI may receive a recovery prompt. */
export interface PromptObservation extends RetirementIdentity {
  readonly harness: "codex" | "claude-code";
  /** Omitted: either bound empty editor. False: positively require a clear
   * editor (not a failed observation). True: positively require a disconnect. */
  readonly require_disconnect?: boolean;
}
/** A clear-screen observation is read-only, never a send condition. */
export interface PromptBinding extends PromptObservation {
  readonly require_disconnect?: true;
}
export interface RuntimeWakeOptions {
  readonly prompt_binding?: PromptBinding;
  /** A retirement-held ref must still belong to this owner at the send slot. */
  readonly retirement_owner?: RetirementIdentity;
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
export interface RetirementIdentity {
  /** First host-confirmed bell on this exact legacy ref; the worker must
   * independently show this Run as the terminal's original launch label. */
  readonly first_bell_run_id?: RunId;
  readonly project_id: string;
  readonly assignment_id: string;
}
export interface Runtime {
  observe_prompt?(
    ref: RuntimeRef,
    binding: PromptObservation,
  ): Promise<RuntimeResult<boolean>>;
  /** Read-only. Only a finished terminal with this exact identity proves exit. */
  observe_retirement?(
    ref: RuntimeRef,
    identity: RetirementIdentity & { readonly system_finished_turn?: true },
  ): Promise<RuntimeResult<RuntimeObservation["process"]>>;
  /** Read-only local kernel check for an already queued Run whose core is gone.
   * A missing socket alone never proves the original terminal process exited. */
  confirm_local_exit?(
    ref: RuntimeRef,
    owner: RetirementIdentity,
  ): Promise<RuntimeResult<boolean>>;
  /** Optional host-only idle retirement. Never escalates beyond HUP/TERM. */
  retire_idle?(
    ref: RuntimeRef,
    options: RetirementIdentity & {
      readonly hangup_ms: number;
      readonly terminate_ms: number;
      readonly before_signal: () => boolean;
    } & (
        | { readonly system_finished_turn?: never }
        | {
            /** One owner-bound TERM; recheck workspace inside the signal slot,
             * then terminal identity/activity, then synchronous authority. */
            readonly system_finished_turn: true;
            readonly expected_process?: NonNullable<
              NonNullable<
                import("./entities.js").Run["launch_publication"]
              >["process"]
            >;
            readonly workspace_preflight: () => Promise<boolean>;
          }
      ),
  ): Promise<RuntimeResult<IdleRetirementResult>>;
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
