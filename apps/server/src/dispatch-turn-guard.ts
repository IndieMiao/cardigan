import {
  type Assignment,
  type CardId,
  type CommandState,
  eventsOfType,
  type Notification,
  type Run,
  runsOf,
} from "@cardigan/domain";
import { recordWakeRefusal } from "@cardigan/host";
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

/** Queuing another Run doesn't end the CLI turn. Only consider the last one that actually started. */
function systemEndedTurn(state: CommandState, owner: Assignment) {
  let last: Run | undefined;
  for (const r of runsOf(state.runs, owner.id)) {
    if (!r.started_at) continue;
    if (
      !last?.started_at ||
      r.started_at > last.started_at ||
      (r.started_at === last.started_at &&
        Number(r.id.slice(2)) > Number(last.id.slice(2)))
    )
      last = r;
  }
  if (!last?.finished_at || last.outcome !== "blocked") return;
  const ref =
    last.bell_delivery?.runtime_ref ??
    last.recovery_runtime ??
    last.launch_publication?.runtime_ref;
  if (ref && JSON.stringify(ref) !== JSON.stringify(owner.runtime_ref)) return;
  return eventsOfType(state.events, "run_finished").some(
    (e) =>
      payloadString(e.payload, "run_id") === last.id &&
      payloadString(e.payload, "finished_by") === "system",
  )
    ? last
    : undefined;
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
