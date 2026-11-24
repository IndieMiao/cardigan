import type { Assignment } from "./entities.js";

export function canonicalSessionFacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSessionFacts);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalSessionFacts(child)]),
    );
  return value;
}

/** A retirement of this exact session still owns its exit/credential decision. */
export function retirementOwnsSession(a: Assignment): boolean {
  return (
    !!a.idle_retirement &&
    JSON.stringify(canonicalSessionFacts(a.idle_retirement.runtime_ref)) ===
      JSON.stringify(canonicalSessionFacts(a.runtime_ref))
  );
}

/**
 * C-690: a waiting retirement (no signal in flight) of an earlier session,
 * while the Assignment is already bound to a newer one (a human stop released
 * the old terminal, then a start launched this one). It must not fence the
 * current session. Without a current binding the record stays: only an
 * explicit start or a host operation supersedes it.
 */
export function supersededRetirement(a: Assignment): boolean {
  return (
    a.idle_retirement?.phase === "waiting" &&
    !!a.runtime_ref &&
    !retirementOwnsSession(a)
  );
}

/** Correlate settlement with a specific wait without publishing a runtime address. */
export function retirementWaitReceipt(a: Assignment) {
  const eventId = a.idle_retirement?.dispatch_wait?.event_id;
  return eventId && retirementOwnsSession(a)
    ? { retirement_wait_event_id: eventId }
    : {};
}
