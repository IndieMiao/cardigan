import {
  type Assignment,
  type CardId,
  type CommandState,
  eventsOfType,
  type Notification,
  type ProjectId,
  type PromptBinding,
  type Run,
  retirementOwnsSession,
  runsOf,
  systemEndedTurn,
} from "@cardigan/domain";
import { recordWakeRefusal, turnSessionKey } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { payloadString, payloadStrings } from "@cardigan/router";
import {
  type BellAttempt,
  moveNotification,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import {
  alertAudience,
  dispatchAlert,
  hostOpsAlertRecipient,
} from "./dispatch-alert.js";
import type { StandingResolver } from "./dispatch-inbox.js";

export function keptPromptBinding(
  project: ProjectId,
  a: Assignment,
  harness: Run["harness"],
): PromptBinding | undefined {
  if (
    a.idle_retirement?.phase === "waiting" &&
    a.idle_retirement.evidence?.reason === "kept_terminal" &&
    retirementOwnsSession(a) &&
    (harness === "codex" || harness === "claude-code")
  )
    return { project_id: project, assignment_id: a.id, harness };
}

/** CandidateIndex groups unread retries by their original Run, separately from new work. */
export function previousInboxTurn(
  state: CommandState,
  owner: Assignment,
  notes: readonly Notification[],
) {
  const note = notes[0];
  const reminder =
    note?.attempts &&
    note.run_id &&
    runsOf(state.runs, owner.id).find(
      (r) => r.id === note.run_id && r.status === "completed",
    );
  if (reminder) return { turn: reminder, reason: "unread_reminder" } as const;
  const turn = owner.runtime_ref && systemEndedTurn(state, owner);
  if (turn) return { turn, reason: "system_finished_turn" } as const;
}

/** Exclude only notices already claimed by this system-ended turn's own deadline. */
export function systemTurnWaitingNotes(state: CommandState, owner: Assignment) {
  const turn = owner.runtime_ref && systemEndedTurn(state, owner);
  return new Set(
    turn
      ? eventsOfType(state.events, "bell_wake_deferred")
          .filter(
            (e) =>
              payloadString(e.payload, "assignment_id") === owner.id &&
              payloadString(e.payload, "run_id") === turn.id &&
              payloadString(e.payload, "reason") === "system_finished_turn",
          )
          .flatMap((e) => payloadStrings(e.payload, "notification_ids"))
      : [],
  );
}

/** Commit the deadline with the positive non-write receipt, not when its next retry is due. */
export function settleRefusedWake(
  store: Store,
  attempt: BellAttempt,
  owner: Assignment,
  at: string,
  observation: string,
  timeoutMs: number,
  standing?: StandingResolver,
) {
  recordWakeRefusal(store, attempt, owner, at, (tx, turn) => {
    const notes = store.listNotifications({
      project_id: attempt.project_id,
      ids: attempt.notification_ids,
      statuses: ["pending", "belled", "delivery_failed"],
    });
    if (attempt.notification_ids.length && !notes.length) return;
    recordTurnWait(tx, store, loadCommandState(tx, attempt.project_id), at, {
      owner,
      turn,
      reason: "first_write_guard",
      observation,
      notes,
      timeoutMs,
      standing,
    });
  });
}

/** Durable per-notification deadline. A restart or a new note in this stream cannot reset an older wait. */
export function recordTurnWait(
  tx: StoreTransactionContext,
  store: Store,
  state: CommandState,
  at: string,
  input: {
    owner: Assignment;
    turn: Run;
    reason:
      | "continuing_turn"
      | "system_finished_turn"
      | "unread_reminder"
      | "first_write_guard";
    observation: string;
    notes: readonly Notification[];
    timeoutMs: number;
    standing?: StandingResolver | undefined;
  },
) {
  const { owner, turn, notes, reason, observation } = input;
  const card =
    notes[0]?.card_id ??
    (notes.length
      ? undefined
      : state.work_items.find((w) => w.id === owner.work_item_id)?.card_id);
  const ids = notes.map((n) => n.id);
  const matching = (type: string) =>
    eventsOfType(state.events, type).filter(
      (e) =>
        e.card_id === card &&
        payloadString(e.payload, "reason") === reason &&
        payloadString(e.payload, "run_id") === turn.id,
    );
  const waits = matching("bell_wake_deferred");
  const first = new Map<string, string>();
  for (const e of waits)
    for (const id of payloadStrings(e.payload, "notification_ids"))
      first.set(id, e.created_at);
  const common = {
    assignment: owner,
    card_id: card,
    run_id: turn.id,
    reason,
    activity_source: observation,
  };
  const unseen = ids.filter((id) => !first.has(id));
  const emptyWait = waits.find(
    (e) => !payloadStrings(e.payload, "notification_ids").length,
  );
  if (unseen.length || (!ids.length && !emptyWait)) {
    dispatchAlert(tx, store, state, at, {
      ...common,
      type: "bell_wake_deferred",
      notification_ids: unseen,
      audience: "activity_log",
    });
  }
  const expired = (since: string | undefined) =>
    since !== undefined &&
    Date.parse(at) - Date.parse(since) >= input.timeoutMs;
  const overdue = ids.filter((id) => expired(first.get(id)));
  if (
    !overdue.length &&
    (ids.length ||
      !expired(emptyWait?.created_at) ||
      matching("bell_wake_escalated").some(
        (e) => !payloadStrings(e.payload, "notification_ids").length,
      ))
  )
    return;
  // Keep the unread rows dispatchable: a replacement must ring the original seqs.
  if (reason === "system_finished_turn") {
    const previous = matching("bell_turn_recovery_due");
    const recorded = new Set(
      previous.flatMap((e) => payloadStrings(e.payload, "notification_ids")),
    );
    const newIds = overdue.filter((id) => !recorded.has(id));
    if (newIds.length || (!ids.length && !previous.length))
      dispatchAlert(tx, store, state, at, {
        ...common,
        type: "bell_turn_recovery_due",
        notification_ids: newIds,
        session_key: turnSessionKey(owner),
        // An empty bell belongs to an already queued Run. Never stop it.
        audience: newIds.length ? "activity_log" : "ops",
      });
    return;
  }
  handoffUnread(
    tx,
    store,
    state,
    at,
    { ...common, type: "bell_wake_escalated" },
    overdue,
    notes,
    input.standing,
  );
}

/** Transfer the original rows and notify a different recipient in the same transaction. */
export function handoffUnread(
  tx: StoreTransactionContext,
  store: Store,
  state: CommandState,
  at: string,
  incident: {
    assignment: Assignment;
    card_id: CardId | undefined;
    type: "standing_inbox_stalled" | "bell_wake_escalated";
    reason: string;
    run_id?: Run["id"];
    activity_source?: string;
  },
  ids: readonly string[],
  notes: readonly Notification[],
  standing?: StandingResolver,
) {
  for (const id of ids)
    moveNotification(store.database, {
      project_id: state.project_id,
      id,
      event: "needs_attention",
      at,
    });
  dispatchAlert(tx, store, state, at, {
    ...incident,
    notification_ids: ids,
    notifyHostOps: true,
    audience: hostOpsAlertRecipient(state, incident.assignment)
      ? "host_ops_only"
      : alertAudience(incident.assignment, state, standing, notes),
  });
}
