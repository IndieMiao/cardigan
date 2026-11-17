import type { Event, Precheck, PrecheckView } from "./entities.js";
import type { CardId } from "./ids.js";

export type { Precheck, PrecheckView } from "./entities.js";

/** The host uses this exact predicate before persisting a projected diagnostic. */
export function validPrecheckSummary(summary: string): boolean {
  return (
    summary.length <= 12000 &&
    !/(?<![\w.-])(?:\/|[A-Za-z]:\\)[^\s]+/u.test(summary)
  );
}

// Event arrays are immutable snapshots, as in event-index.ts. Cache only the
// trusted pure projection, never an actor's response or an authorization result.
const projections = new WeakMap<
  readonly Event[],
  ReadonlyMap<CardId | undefined, readonly Precheck[]>
>();

export function prechecks(events: readonly Event[], card?: CardId): Precheck[] {
  let index = projections.get(events);
  if (!index) {
    const relevant = events
      .filter(
        (e) =>
          e.actor.kind === "system" &&
          ["precheck_queued", "precheck_started", "precheck_finished"].includes(
            e.type,
          ),
      )
      .sort((a, b) => a.seq - b.seq);
    const byCard = new Map<CardId | undefined, Map<string, Precheck>>();
    // The project-wide projection keeps the original stable seq ordering and
    // last-attempt-wins behavior, even if malformed history reuses an attempt.
    const latest = new Map<string, Precheck>();
    for (const e of relevant) {
      const p = e.payload as unknown as Precheck;
      if (!p?.attempt_id || p.card_id !== e.card_id) continue;
      latest.set(p.attempt_id, p);
      let attempts = byCard.get(e.card_id);
      if (!attempts) {
        attempts = new Map();
        byCard.set(e.card_id, attempts);
      }
      attempts.set(p.attempt_id, p);
    }
    const result = new Map<CardId | undefined, readonly Precheck[]>();
    for (const [id, attempts] of byCard) result.set(id, [...attempts.values()]);
    result.set(undefined, [...latest.values()]);
    index = result;
    projections.set(events, index);
  }
  // Preserve the public mutable-array contract without exposing the index.
  return [...(index.get(card || undefined) ?? [])];
}
export function precheckView({
  branch: _branch,
  machine_id: _machine,
  ...view
}: Precheck): PrecheckView {
  return view;
}
