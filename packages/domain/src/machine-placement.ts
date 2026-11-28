import type { Assignment, Run, WorkItem } from "./entities.js";

/** Configured physical-machine resource slots; absence of a key means unlimited. */
export type MachineResources = ReadonlyMap<
  string,
  { readonly limit: number; readonly occupied: number }
>;

export function remainingResourceRatio(
  keys: readonly string[],
  resources?: MachineResources,
): number {
  let ratio = 1;
  for (const key of keys) {
    const slot = resources?.get(key);
    if (slot)
      ratio = Math.min(ratio, (slot.limit - slot.occupied) / slot.limit);
  }
  return ratio;
}

export type WorktreePreparation =
  | "missing"
  | "invalid"
  | "expired"
  /** C-784: proven for this binding before a Run PATH or env edit; awaits the next real preparation. */
  | "stale"
  | "verified";

/** Transaction-local host evidence. Contains neither worker configuration nor other projects' identities. */
export interface MachinePlacement {
  /** Does this observation cover the current remote worker binding, OS and architecture? */
  readonly observation_target_matches?: boolean;
  /** Current project opt-in and platform match; a past health check is not a binding. */
  readonly remote_binding: "disabled" | "platform_mismatch" | "allowed";
  readonly preparation_cooldown_until?: string;
  /** Host-attested server dispatch on this exact binding, independent of ordinary health. */
  readonly worktree_preparation?: WorktreePreparation;
  readonly health: {
    readonly blockers?: readonly string[];
    readonly status: string;
    readonly available: boolean;
  } | null;
  readonly capabilities: readonly {
    readonly key: string;
    readonly version: string | null;
    readonly available: boolean;
  }[];
  readonly resources?: MachineResources;
  /**
   * C-716: this project's private ceilings on this machine (run-capacity
   * `projects.<id>`) with its current usage. They only rank placement; dispatch
   * enforces the same quota separately.
   */
  readonly project_quota?: {
    readonly limit?: { readonly limit: number; readonly occupied: number };
    readonly resources?: MachineResources;
  };
  /**
   * C-826: resource keys another project holds on this machine right now by
   * an exclusive calendar reservation. Work needing one cannot start here.
   */
  readonly reserved?: readonly string[];
  /**
   * C-850: per device type this machine knows (`android.device`), how many of
   * its devices a new Run of this project could take now: listed by the
   * current check, enabled for the project, not held, not reserved by another
   * project, less the claims of owners still waiting to start. Ranks
   * `android.any` toward a machine with an idle device.
   */
  readonly idle_devices?: Readonly<Record<string, number>>;
  readonly limit: number;
  /** Portion of occupied from assigned work not already holding a physical slot. */
  readonly pending_assignments?: number;
  readonly occupied: number;
}
export type ReadMachinePlacement = (
  project: string,
  now: string,
  launchProfile?: string,
  draft?: {
    assignments: readonly Assignment[];
    work_items: readonly WorkItem[];
    runs: readonly Run[];
  },
) => {
  readonly harness: import("./role.js").Role["harness"] | undefined;
  readonly machines: ReadonlyMap<string, MachinePlacement>;
};
