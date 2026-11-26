import type { Assignment, Event, Run, RuntimeRef } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import { hostOpsPending } from "../host-ops.js";
import type { CommandDraft, CommandState } from "./core.js";
import { stoppedByHuman } from "./stop-state.js";

/**
 * C-789: managed session rotation. A signal that a session is stuck
 * (inactivity, an idle session holding a scarce slot, a bell deferred past its
 * deadline, a retirement that could not finish) ends in a host-proven exit of
 * that exact terminal. Only then may the system start the owner again, and
 * only once per Assignment, and only for work that is still in progress, not
 * blocked and has something its owner has not read. Anything else is recorded
 * and, once the allowance is spent, handed to PM: a wake → idle → wait-60-min
 * loop is impossible.
 */
export const SESSION_ROTATION_REQUESTED = "session_rotation_requested";
export const SESSION_ROTATION_SKIPPED = "session_rotation_skipped";

export type RotationSignal =
  | "inactive"
  | "idle_scarce"
  | "bell_deferred"
  | "retirement_failed";

export type RotationSkip =
  | "no_exit_proof"
  | "allowance_used"
  | "not_work_item"
  | "not_in_progress"
  | "blocked"
  | "card_closed"
  | "card_held"
  | "assignment_inactive"
  | "human_stopped"
  | "host_ops_pending"
  | "session_bound"
  | "run_unfinished"
  | "nothing_unread";

/** Host proof that this exact terminal exited; nothing else counts. */
export interface ExitProof {
  readonly runtime_ref: RuntimeRef;
  readonly exited: true;
  /** The stop attempt or event that proved it. */
  readonly evidence: string;
}

/** System events (only) that ask an owner to act; telemetry never counts. */
const WAKE_SYSTEM_TYPES: ReadonlySet<string> = new Set([
  "work_item_resume_requested",
  "instruction_issued",
  "precheck_finished",
  "merge_check_finished",
  "merge_conflicted",
  "review_evidence_unblocked",
]);

/** Run, session and assignment lifecycle records, whoever wrote them. */
const LIFECYCLE = /^(?:run|session|assignment|runtime|machine)_/u;

const payload = (e: Event) =>
  (e.payload ?? {}) as Record<string, unknown> & { assignment_id?: unknown };

/** Each Assignment has one automatic rotation, for life. */
export function rotationAllowanceUsed(
  state: CommandState,
  assignment: Assignment["id"],
) {
  return eventsOfType(state.events, SESSION_ROTATION_REQUESTED).some(
    (e) =>
      e.actor.kind === "system" &&
      e.actor.project_id === state.project_id &&
      payload(e).assignment_id === assignment,
  );
}

/**
 * Card events past the owner's cursor that ask it to act: anything written by
 * another participant, or one of the system's wake events. The owner's own
 * writes and run/dispatch/inactivity telemetry are never "unread".
 */
export function unreadForOwner(state: CommandState, a: Assignment): boolean {
  if (a.scope !== "work_item") return false;
  const item = state.work_items.find((w) => w.id === a.work_item_id);
  if (!item) return false;
  const acked =
    state.cursors.find(
      (c) => c.assignment_id === a.id && c.card_id === item.card_id,
    )?.acked_seq ?? 0;
  return state.events.some(
    (e) =>
      e.card_id === item.card_id &&
      e.seq > acked &&
      e.actor.project_id === state.project_id &&
      !(e.actor.kind === "assignment" && e.actor.assignment_id === a.id) &&
      (e.actor.kind === "system"
        ? WAKE_SYSTEM_TYPES.has(e.type)
        : !LIFECYCLE.test(e.type)),
  );
}

/** Why the system may not start this owner again; undefined when it may. */
export function rotationSkipReason(
  d: CommandDraft,
  a: Assignment,
  proof: ExitProof | undefined,
): RotationSkip | undefined {
  if (!proof?.exited) return "no_exit_proof";
  if (a.scope !== "work_item") return "not_work_item";
  if (a.status !== "active" || a.external) return "assignment_inactive";
  // The proven terminal must be the one released; a newer session is not ours.
  if (a.runtime_ref !== null) return "session_bound";
  const item = d.work(a.work_item_id);
  const card = d.card(item.card_id);
  if (["done", "cancelled"].includes(card.status)) return "card_closed";
  if (card.hold) return "card_held";
  if (item.status !== "in_progress" || item.assignment_id !== a.id)
    return "not_in_progress";
  // In progress, a leftover standby record is stale (cleared on the next scan).
  if (item.reported_blocker) return "blocked";
  if (stoppedByHuman(d.state.events, a.id)) return "human_stopped";
  if (hostOpsPending(d.state.events, a.id)) return "host_ops_pending";
  if (
    d
      .list("runs")
      .some(
        (r) =>
          r.assignment_id === a.id &&
          (!["completed", "failed", "cancelled"].includes(r.status) ||
            r.dispatch_stop ||
            r.inactivity_stop),
      )
  )
    return "run_unfinished";
  if (!unreadForOwner(d.state, a)) return "nothing_unread";
  if (rotationAllowanceUsed(d.state, a.id)) return "allowance_used";
}

/**
 * Settle one managed rotation after the host proved the exit. Requests a
 * single fresh Run (full weight: it claims the work item's resources) or
 * records why not; a spent allowance goes to PM.
 */
export function settleSessionRotation(
  d: CommandDraft,
  a: Assignment,
  signal: RotationSignal,
  run: Run | undefined,
  proof: ExitProof | undefined,
): "requested" | RotationSkip {
  const skip = rotationSkipReason(d, a, proof);
  const card =
    a.scope === "work_item" ? d.work(a.work_item_id).card_id : undefined;
  const system = { kind: "system" as const, project_id: d.state.project_id };
  if (skip) {
    d.emit(
      SESSION_ROTATION_SKIPPED,
      card,
      {
        assignment_id: a.id,
        signal,
        reason: skip,
        ...(run ? { run_id: run.id } : {}),
        ...(a.scope === "work_item" ? { work_item_id: a.work_item_id } : {}),
      },
      undefined,
      system,
    );
    return skip;
  }
  if (a.scope !== "work_item" || !proof) return "not_work_item";
  const item = d.work(a.work_item_id);
  const rotation = d.emit(
    SESSION_ROTATION_REQUESTED,
    item.card_id,
    {
      assignment_id: a.id,
      work_item_id: item.id,
      signal,
      ...(run ? { run_id: run.id } : {}),
      exit_evidence: proof.evidence,
    },
    undefined,
    system,
  );
  const body = `${item.id} 会话已受管停止并确认退出，系统按一次性换代额度请求新会话继续处理未读通知；再次卡住将交 PM。`;
  d.emit(
    "work_item_resume_requested",
    item.card_id,
    {
      work_item_id: item.id,
      assignment_id: a.id,
      role_version: a.role_version,
      rotation: true,
      rotation_event_id: rotation.id,
      previous_run_id: run?.id ?? null,
      reported_blocker_cleared: false,
      body,
    },
    { type: "system", author: "system", body, work_item_id: item.id },
    system,
  );
  return "requested";
}
