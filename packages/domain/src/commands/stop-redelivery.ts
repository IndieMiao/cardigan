import type { Assignment, Event } from "../entities.js";
import { eventsOfTypes } from "../event-index.js";
import { hasRunTarget } from "../run-target.js";
import type { CommandDraft } from "./core.js";

/**
 * C-812: the dispatcher's escalation of a bell it could not deliver to a busy
 * session (`continuing_turn` and the other turn guards). It moves the original
 * rows to `needs_attention`, which never ring again, and alerts host ops.
 */
export const BELL_WAKE_ESCALATED = "bell_wake_escalated";

/** Work item states in which the owner may still act on what it was sent. */
const REDELIVERABLE: Readonly<Record<string, ReadonlySet<string>>> = {
  produce: new Set([
    "ready",
    "in_progress",
    "delivered",
    "accepted",
    "changes_requested",
  ]),
  verify: new Set(["ready", "in_progress"]),
};

const field = (payload: unknown, key: string): unknown =>
  payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)[key]
    : undefined;

const unfinished = (status: string) =>
  !["completed", "failed", "cancelled"].includes(status);

/**
 * C-812: bells escalated for this owner since its last dispatch, on its card,
 * past its read cursor, and not yet handed to a fresh session by
 * `redeliverEscalatedBells`. A later dispatch delivered them: that session
 * reads every update past the cursor.
 */
function undeliveredEscalations(
  d: CommandDraft,
  a: Extract<Assignment, { scope: "work_item" }>,
  card_id: Event["card_id"],
): Event[] {
  const acked =
    d.state.cursors.find(
      (c) => c.assignment_id === a.id && c.card_id === card_id,
    )?.acked_seq ?? 0;
  let open: Event[] = [];
  for (const e of eventsOfTypes(d.state.events, [
    "run_dispatched",
    BELL_WAKE_ESCALATED,
    "work_item_resume_requested",
  ])) {
    if (field(e.payload, "assignment_id") !== a.id) continue;
    if (e.type === "run_dispatched") {
      open = [];
      continue;
    }
    if (e.actor.kind !== "system" || e.actor.project_id !== d.state.project_id)
      continue;
    if (e.type === "work_item_resume_requested") {
      if (field(e.payload, "stop_redelivery") === true) open = [];
      continue;
    }
    const ids = field(e.payload, "notification_ids");
    if (
      e.card_id === card_id &&
      e.seq > acked &&
      Array.isArray(ids) &&
      ids.length > 0
    )
      open.push(e);
  }
  return open;
}

/**
 * C-812: a managed stop (`hold: false`) ends with "new work starts a new
 * session", but the bells the dispatcher escalated while the stopped session
 * was busy are `needs_attention` rows the dispatcher never rings again. With
 * nothing pending, no session ever started (C-811: 30 minutes until PM Ops
 * issued an instruction). When the release is confirmed, request one fresh
 * session for them, through the same resume request the router rings and the
 * dispatcher launches with the current trusted configuration.
 *
 * Call after the stopped Runs are cancelled and the terminal is cleared, and
 * only for a managed stop: a pause waits for the human's start.
 */
export function redeliverEscalatedBells(
  d: CommandDraft,
  a: Assignment,
): Event | undefined {
  if (a.scope !== "work_item" || a.status !== "active" || a.external) return;
  const item = d.work(a.work_item_id);
  if (
    item.assignment_id !== a.id ||
    item.replaced_by_work_item_id ||
    !REDELIVERABLE[item.kind]?.has(item.status)
  )
    return;
  const card = d.card(item.card_id);
  if (card.hold || ["done", "cancelled"].includes(card.status)) return;
  if (
    !hasRunTarget(a, {
      work_items: d.list("work_items"),
      deliveries: d.list("deliveries"),
    })
  )
    return;
  const runs = d.list("runs").filter((r) => r.assignment_id === a.id);
  // A kept queued Run (or the replayed resume) already starts the session.
  if (runs.some((r) => unfinished(r.status))) return;
  const escalations = undeliveredEscalations(d, a, item.card_id);
  if (!escalations.length) return;
  const notification_ids = [
    ...new Set(
      escalations.flatMap(
        (e) => field(e.payload, "notification_ids") as string[],
      ),
    ),
  ];
  const last = runs.toSorted(
    (x, y) => Number(y.id.slice(2)) - Number(x.id.slice(2)),
  )[0];
  const body = `${item.id} 的会话已受管停止并确认退出；停止前有 ${notification_ids.length} 条通知因会话占用未能投递，系统请求新会话继续处理。`;
  return d.emit(
    "work_item_resume_requested",
    item.card_id,
    {
      work_item_id: item.id,
      assignment_id: a.id,
      role_version: a.role_version,
      stop_redelivery: true,
      escalation_event_ids: escalations.map((e) => e.id),
      notification_ids,
      previous_run_id: last?.id ?? null,
      reported_blocker_cleared: false,
      body,
    },
    { type: "system", author: "system", body, work_item_id: item.id },
    { kind: "system", project_id: d.state.project_id },
  );
}
