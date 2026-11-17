import type { Event, Precheck, PrecheckView, WorkItem } from "./entities.js";
import type { CardId } from "./ids.js";

export type { Precheck, PrecheckView } from "./entities.js";

/** Only a host-recorded candidate preparation failure can request baseline recovery. */
export function isPrecheckConflict(check: Precheck): boolean {
  return (
    check.status === "environment_failed" &&
    (check.failure_kind === "candidate_conflict" ||
      check.summary === "预检查环境故障（准备候选）：Precheck merge conflict")
  );
}

export function latestPrecheckConflict(
  events: readonly Event[],
  item: WorkItem,
  project: string,
): Precheck | undefined {
  if (item.kind !== "produce") return;
  const latest = prechecks(events, item.card_id).findLast(
    (c) => c.work_item_id === item.id && c.assignment_id === item.assignment_id,
  );
  return latest &&
    isPrecheckConflict(latest) &&
    events.some(
      (e) =>
        (e.payload as unknown) === latest &&
        e.actor.kind === "system" &&
        e.actor.project_id === project,
    )
    ? latest
    : undefined;
}

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
