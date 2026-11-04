import { type Result, validationFailed } from "./errors.js";
import type {
  AssignmentStatus,
  CardStatus,
  DecisionStatus,
  DeliveryStatus,
  HumanActionStatus,
  ProduceStatus,
  RunStatus,
  RuntimeState,
  VerifyStatus,
} from "./states.js";

interface MachineStates {
  produce: ProduceStatus;
  verify: VerifyStatus;
  delivery: DeliveryStatus;
  decision: DecisionStatus;
  human_action: HumanActionStatus;
  run: RunStatus;
  assignment: AssignmentStatus;
  runtime: RuntimeState;
  card: CardStatus;
}
type Table<S extends string> = Readonly<
  Partial<Record<S, Readonly<Record<string, S>>>>
>;
export const transitionTables: {
  readonly [M in keyof MachineStates]: Table<MachineStates[M]>;
} = {
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
    accepted: { delivery_submitted: "delivered", cancel: "cancelled" },
  },
  verify: {
    todo: { target_delivered: "ready", cancel: "cancelled" },
    ready: {
      run_started: "in_progress",
      review_limit_exceeded: "waiting_decision",
      cancel: "cancelled",
    },
    in_progress: {
      target_redelivered: "ready",
      review_passed: "passed",
      review_rejected: "failed",
      block: "blocked",
      request_decision: "waiting_decision",
      cancel: "cancelled",
    },
    failed: {
      target_redelivered: "ready",
      review_limit_exceeded: "waiting_decision",
      cancel: "cancelled",
    },
    passed: { target_redelivered: "ready" },
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
      declared_lost: "lost",
      release: "released",
    },
    lost: { release: "released" },
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
  card: {
    backlog: { set_todo: "todo", cancel: "cancelled" },
    todo: { set_backlog: "backlog", cancel: "cancelled" },
    in_progress: { completion_submitted: "review", cancel: "cancelled" },
    review: {
      completion_submitted: "review",
      completion_review_passed: "done",
      completion_review_rejected: "in_progress",
      cancel: "cancelled",
    },
    done: { cancel: "cancelled" },
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
