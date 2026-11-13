import type { Assignment, Event } from "../entities.js";

/**
 * C-228 / Q-387 (human chose g60_c10): a runtime that went `unknown` only
 * because consecutive subscription attempts failed waits 60 seconds before it
 * reaches the human's Needs You. Explicit exits and `lost` are shown at once.
 */
export const DEFAULT_RUNTIME_UNKNOWN_GRACE_MS = 60_000;
/** C-228 / Q-387: CARDIGAN_RUNTIME_FAILURE_LIMIT is accepted in 2..10. */
export const MIN_RUNTIME_FAILURE_LIMIT = 2;
export const MAX_RUNTIME_FAILURE_LIMIT = 10;
/** Payload `cause` of a `runtime_disconnected` fact written by the monitor. */
export type RuntimeDisconnectCause = "exit" | "failures";

const RUNTIME_FACTS = [
  "runtime_disconnected",
  "runtime_reconnected",
  "runtime_exit_observed",
] as const;

const field = (event: Event, key: string): string | undefined => {
  const p = event.payload;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return undefined;
  const value = (p as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * When an `unknown` runtime may first be shown to the human, or null when it
 * must be shown now regardless of the clock (explicit exit, legacy facts
 * without a cause, anything but `unknown`).
 *
 * The grace period starts at the first disconnect of a flapping run: a
 * disconnect that follows the previous reconnection by less than the grace
 * period continues the same run, so repeated short reconnects cannot postpone
 * the incident forever. Only facts of the current RuntimeRef count: an
 * Assignment is reused across Sessions, and a replacement terminal must not
 * inherit the old terminal's elapsed time (V-804).
 */
export function runtimeUnknownVisibleAt(
  events: readonly Event[],
  assignment: Pick<Assignment, "id" | "runtime_state" | "runtime_ref">,
  graceMs: number,
): string | null {
  if (assignment.runtime_state !== "unknown") return null;
  // Same key the RuntimeMonitor writes into each fact's `runtime_key`.
  const key = JSON.stringify(assignment.runtime_ref);
  const facts = events.filter(
    (e) =>
      (RUNTIME_FACTS as readonly string[]).includes(e.type) &&
      field(e, "assignment_id") === assignment.id &&
      field(e, "runtime_key") === key,
  );
  let index = facts.findLastIndex((e) => e.type === "runtime_disconnected");
  const current = facts[index];
  if (!current || field(current, "cause") !== "failures") return null;
  if (facts.slice(index + 1).some((e) => e.type === "runtime_exit_observed"))
    return null;
  let start = Date.parse(current.created_at);
  for (;;) {
    const before = facts.slice(0, index);
    const reconnect = before.findLastIndex(
      (e) => e.type === "runtime_reconnected",
    );
    const reconnectedAt = before[reconnect]?.created_at;
    if (reconnectedAt === undefined) break;
    if (start - Date.parse(reconnectedAt) >= graceMs) break;
    const previous = before
      .slice(0, reconnect)
      .findLastIndex((e) => e.type === "runtime_disconnected");
    const previousAt = before[previous]?.created_at;
    if (previousAt === undefined) break;
    index = previous;
    start = Math.min(start, Date.parse(previousAt));
  }
  if (!Number.isFinite(start)) return null;
  return new Date(start + graceMs).toISOString();
}

/** True while a failures-only `unknown` is still inside its grace period. */
export function runtimeUnknownDeferred(
  events: readonly Event[],
  assignment: Pick<Assignment, "id" | "runtime_state" | "runtime_ref">,
  now: string,
  graceMs: number,
): boolean {
  const at = runtimeUnknownVisibleAt(events, assignment, graceMs);
  return at !== null && Date.parse(now) < Date.parse(at);
}

/**
 * Parse CARDIGAN_RUNTIME_UNKNOWN_GRACE_SECONDS. A positive integer strictly
 * below the loss grace period; anything else refuses to start.
 */
export function parseRuntimeUnknownGraceMs(
  text: string | undefined,
  lossGraceMs = 5 * 60_000,
): number {
  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed === "")
    return DEFAULT_RUNTIME_UNKNOWN_GRACE_MS;
  const seconds = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  const ms = seconds * 1000;
  if (!Number.isSafeInteger(ms) || seconds < 1 || ms >= lossGraceMs)
    throw new Error(
      `CARDIGAN_RUNTIME_UNKNOWN_GRACE_SECONDS must be an integer from 1 to ${Math.ceil(lossGraceMs / 1000) - 1} (Q-387 default 60)`,
    );
  return ms;
}
