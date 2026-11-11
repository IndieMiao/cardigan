import { type Result, validationFailed } from "./errors.js";
import type {
  AssignmentStatus,
  CardStatus,
  DecisionStatus,
  DeliveryStatus,
  EmployeeStatus,
  HumanActionStatus,
  MemberStatus,
  NotificationStatus,
  ProduceStatus,
  RunStatus,
  RuntimeState,
  VerifyStatus,
} from "./states.js";

interface MachineStates {
  employee: EmployeeStatus;
  member: MemberStatus;
  produce: ProduceStatus;
  verify: VerifyStatus;
  delivery: DeliveryStatus;
  decision: DecisionStatus;
  human_action: HumanActionStatus;
  run: RunStatus;
  assignment: AssignmentStatus;
  runtime: RuntimeState;
  card: CardStatus;
  notification: NotificationStatus;
}
type Table<S extends string> = Readonly<
  Partial<Record<S, Readonly<Record<string, S>>>>
>;
export const transitionTables: {
  readonly [M in keyof MachineStates]: Table<MachineStates[M]>;
} = {
  member: {
    active: { deactivate: "inactive" },
    inactive: { activate: "active" },
  },
  employee: {
    active: { deactivate: "inactive" },
    inactive: { activate: "active" },
  },
  produce: {
    todo: { dependencies_met: "ready", cancel: "cancelled" },
    ready: { run_started: "in_progress", cancel: "cancelled" },
    in_progress: {
      delivery_submitted: "delivered",
      block: "blocked",
      request_decision: "waiting_decision",
      cancel: "cancelled",
    },
    delivered: {
      delivery_submitted: "delivered",
      verifiers_passed: "accepted",
      review_rejected: "changes_requested",
      cancel: "cancelled",
    },
    changes_requested: { run_started: "in_progress", cancel: "cancelled" },
    blocked: { resume: "in_progress", cancel: "cancelled" },
    waiting_decision: { decision_resolved: "in_progress", cancel: "cancelled" },
    accepted: {
      delivery_submitted: "delivered",
      merge_conflicted: "changes_requested",
      request_changes: "changes_requested",
      cancel: "cancelled",
    },
  },
  verify: {
    todo: { target_delivered: "ready", cancel: "cancelled" },
    ready: {
      run_started: "in_progress",
      review_limit_exceeded: "waiting_decision",
      target_withdrawn: "todo",
      cancel: "cancelled",
    },
    in_progress: {
      target_redelivered: "ready",
      target_withdrawn: "todo",
      review_limit_exceeded: "waiting_decision",
      review_passed: "passed",
      review_rejected: "failed",
      block: "blocked",
      request_decision: "waiting_decision",
      cancel: "cancelled",
    },
    failed: {
      target_redelivered: "ready",
      target_withdrawn: "todo",
      review_limit_exceeded: "waiting_decision",
      cancel: "cancelled",
    },
    passed: {
      target_redelivered: "ready",
      target_withdrawn: "todo",
      withdraw_pass: "ready",
    },
    blocked: { resume: "in_progress", cancel: "cancelled" },
    waiting_decision: { decision_resolved: "ready", cancel: "cancelled" },
  },
  delivery: {
    submitted: {
      accept: "accepted",
      reject: "rejected",
      supersede: "superseded",
    },
    accepted: { supersede: "superseded" },
    rejected: { supersede: "superseded" },
  },
  decision: {
    open: {
      resolve: "resolved",
      provisionally_resolve: "provisional",
      withdraw: "withdrawn",
      supersede: "superseded",
    },
    provisional: { resolve: "resolved", revoke: "revoked" },
    resolved: { revoke: "revoked", supersede: "superseded" },
  },
  human_action: { open: { complete: "done", cancel: "cancelled" } },
  assignment: {
    active: { suspend: "suspended", release: "released" },
    suspended: { resume: "active", release: "released" },
  },
  runtime: {
    not_provisioned: { provision: "provisioning", release: "released" },
    provisioning: {
      provisioned: "idle",
      connection_lost: "unknown",
      release: "released",
    },
    idle: {
      run_started: "running",
      connection_lost: "unknown",
      release: "released",
    },
    running: {
      run_finished: "idle",
      connection_lost: "unknown",
      release: "released",
    },
    unknown: {
      reconnected: "idle",
      session_replaced: "idle",
      declared_lost: "lost",
      release: "released",
    },
    lost: { session_replaced: "idle", release: "released" },
  },
  run: {
    queued: { dispatch: "dispatched", cancel: "cancelled" },
    dispatched: {
      acknowledge: "acked",
      connection_lost: "unknown",
      cancel: "cancelled",
    },
    acked: {
      start: "running",
      connection_lost: "unknown",
      cancel: "cancelled",
    },
    running: {
      complete: "completed",
      fail: "failed",
      cancel: "cancelled",
      connection_lost: "unknown",
    },
    unknown: { reconnected: "running", cancel: "cancelled" },
  },
  notification: {
    pending: {
      bell: "belled",
      ack: "acked",
      deliver_failed: "delivery_failed",
      needs_attention: "needs_attention",
      resolve: "resolved",
    },
    belled: {
      ack: "acked",
      retry: "pending",
      deliver_failed: "delivery_failed",
      needs_attention: "needs_attention",
      resolve: "resolved",
    },
    // A failed wake may still have landed (§6.8): the Agent can ack it later.
    delivery_failed: {
      ack: "acked",
      retry: "pending",
      bell: "belled",
      deliver_failed: "delivery_failed",
      needs_attention: "needs_attention",
      resolve: "resolved",
    },
    // Terminal: an acked or escalated notification never rings again.
    acked: {},
    needs_attention: { resolve: "resolved" },
    resolved: {},
  },
  card: {
    backlog: { human_mark_done: "done", set_todo: "todo", cancel: "cancelled" },
    todo: {
      human_mark_done: "done",
      set_backlog: "backlog",
      cancel: "cancelled",
    },
    in_progress: {
      human_mark_done: "done",
      completion_submitted: "review",
      cancel: "cancelled",
    },
    review: {
      human_mark_done: "done",
      completion_submitted: "review",
      completion_review_passed: "awaiting_merge",
      completion_review_rejected: "in_progress",
      cancel: "cancelled",
    },
    awaiting_merge: {
      merge_not_required: "done",
      merge_succeeded: "done",
      merge_conflicted: "in_progress",
      request_changes: "in_progress",
      cancel: "cancelled",
    },
  },
};

// Event names describe validated facts; actor/subject checks belong to M1.3.
export function transition<M extends keyof MachineStates>(
  machine: M,
  from: MachineStates[M],
  event: string,
): Result<MachineStates[M]> {
  const table = Object.hasOwn(transitionTables, machine)
    ? transitionTables[machine]
    : undefined;
  const row = table && Object.hasOwn(table, from) ? table[from] : undefined;
  const to = row && Object.hasOwn(row, event) ? row[event] : undefined;
  return to === undefined
    ? {
        ok: false,
        error: {
          code: "illegal_transition",
          message: `Cannot apply ${event} to ${machine}:${from}`,
        },
      }
    : { ok: true, value: to };
}

export const DEFAULT_MAX_REVIEW_ROUNDS = 3;
// round is the one-based round about to start, not a count of completed rounds.
export function beginReviewRound(
  from: VerifyStatus,
  round: number,
  max_review_rounds = DEFAULT_MAX_REVIEW_ROUNDS,
): Result<VerifyStatus> {
  if (
    ![round, max_review_rounds].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    return validationFailed("Review rounds must be positive safe integers");
  const start = transition("verify", from, "run_started");
  return start.ok && round > max_review_rounds
    ? transition("verify", from, "review_limit_exceeded")
    : start;
}
