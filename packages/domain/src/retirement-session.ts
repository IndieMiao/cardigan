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

/** Correlate settlement with a specific wait without publishing a runtime address. */
export function retirementWaitReceipt(a: Assignment) {
  const eventId = a.idle_retirement?.dispatch_wait?.event_id;
  return eventId && retirementOwnsSession(a)
    ? { retirement_wait_event_id: eventId }
    : {};
}
