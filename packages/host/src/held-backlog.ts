import {
  type AssignmentId,
  assignmentCardHeld,
  type CommandState,
  type HeldResumeRequest,
  heldPause,
  heldResumeDecision,
  type Notification,
} from "@cardigan/domain";

/**
 * C-732: how long bells may wait for a human-paused Assignment on an open,
 * unheld card before the system asks to resume it. Invalid values fail host
 * startup.
 */
export const DEFAULT_HELD_BACKLOG_MS = 30 * 60_000;
export function heldBacklogMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const raw = env.CARDIGAN_HELD_BACKLOG_MS;
  if (raw === undefined || raw === "") return DEFAULT_HELD_BACKLOG_MS;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("Invalid CARDIGAN_HELD_BACKLOG_MS");
  return value;
}

const LIVE = new Set(["pending", "belled", "delivery_failed"]);

/**
 * Paused work-item Assignments whose undelivered instructions or bells waited
 * longer than `threshold`, on a card that is neither held nor closed, with no
 * resume question raised for this pause yet. A pause without waiting work is
 * never reported.
 */
export function heldBacklogs(
  state: CommandState,
  notes: readonly Notification[],
  now: string,
  threshold: number,
): HeldResumeRequest[] {
  const acked = new Map(
    state.cursors.map((c) => [`${c.assignment_id}/${c.card_id}`, c.acked_seq]),
  );
  const waiting = new Map<AssignmentId, Notification[]>();
  for (const n of notes) {
    if (n.recipient.kind !== "assignment" || !LIVE.has(n.status)) continue;
    const id = n.recipient.assignment_id;
    if ((acked.get(`${id}/${n.card_id ?? ""}`) ?? -1) >= n.seq) continue;
    waiting.set(id, [...(waiting.get(id) ?? []), n]);
  }
  const found: HeldResumeRequest[] = [];
  for (const [id, pending] of waiting) {
    const a = state.assignments.find((x) => x.id === id);
    if (a?.scope !== "work_item" || a.status !== "active" || a.external)
      continue;
    const pause = heldPause(state.events, a.id);
    if (!pause || a.runtime_ref) continue;
    const item = state.work_items.find((w) => w.id === a.work_item_id);
    const card = item && state.cards.find((c) => c.id === item.card_id);
    if (
      !item ||
      item.assignment_id !== a.id ||
      !card ||
      card.hold ||
      assignmentCardHeld(a, state) ||
      ["done", "cancelled"].includes(card.status) ||
      heldResumeDecision(state.decisions, a.id, pause)
    )
      continue;
    const oldest = pending.reduce((v, n) =>
      n.created_at < v.created_at ? n : v,
    );
    if (Date.parse(now) - Date.parse(oldest.created_at) < threshold) continue;
    found.push({
      assignment_id: a.id,
      reason: "pending_work",
      pending_since: oldest.created_at,
      pending_count: pending.length,
    });
  }
  return found;
}
