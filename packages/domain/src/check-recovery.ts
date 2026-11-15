import type { Actor } from "./entities.js";

// C-329 / Q-618: human-approved lightweight safety inspection cadence.
export const DEFAULT_CHECK_RECOVERY_INSPECTION_MS = 300_000;

export const CHECK_RECOVERY_STAGES = [
  "transport",
  "request",
  "lock",
  "repository_identity",
  "mounts",
  "target_identity",
  "absence",
  "registration",
  "inventory",
  "processes",
  "exclusion",
  "presence",
  "ownership",
] as const;
export interface CheckRecoveryOutcome {
  status: "cleaned" | "manual_attention" | "busy";
  reason:
    | "complete"
    | "occupied"
    | "unverified"
    | "locked"
    | "transport"
    | "exclusion_unproven";
  stage?: (typeof CHECK_RECOVERY_STAGES)[number];
  /** Authenticated, opaque existence evidence; never authority to delete. */
  evidence?: string;
  processes: { pid: number; state: string; wchan: string }[];
}
export type CheckRecoveryState =
  | "pending"
  | "manual_attention"
  | "cleaned"
  | "busy";

/** Evidence refreshes and diagnostic ordering are not business transitions. */
export function sameCheckRecoveryOutcome(
  a: CheckRecoveryOutcome | undefined,
  b: CheckRecoveryOutcome,
): boolean {
  const canonical = (v: CheckRecoveryOutcome) =>
    JSON.stringify({
      status: v.status,
      reason: v.reason,
      stage: v.stage,
      processes: [...v.processes].sort((x, y) => x.pid - y.pid),
    });
  return !!a && canonical(a) === canonical(b);
}

/** Private host operation or explicit human action; no Agent self-authorization. */
export function canRecheckRecovery(actor: Actor, project: string): boolean {
  return (
    actor.project_id === project &&
    (actor.kind === "human" || actor.kind === "system")
  );
}
