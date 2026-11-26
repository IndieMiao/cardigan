import type { Event, Precheck, PrecheckView, WorkItem } from "./entities.js";
import { eventsOfTypes } from "./event-index.js";
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

const PRECHECK_TYPES = [
  "precheck_queued",
  "precheck_started",
  "precheck_finished",
];

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
    // C-671: the precheck event itself, from the type index.
    eventsOfTypes(events, PRECHECK_TYPES).some(
      (e) =>
        (e.payload as unknown) === latest &&
        e.actor.kind === "system" &&
        e.actor.project_id === project,
    )
    ? latest
    : undefined;
}

/** Both the idle scanner and inline delivery bind settlement to this terminal event. */
export function authorPrecheckWaitHandled(
  events: readonly Event[],
  result: Event,
): boolean {
  const check = result.payload as unknown as Precheck;
  // C-649: the predicate only accepts these three types.
  return eventsOfTypes(events, [
    "precheck_wait_delivered",
    "work_item_resume_requested",
    "precheck_wait_escalated",
  ]).some((e) => {
    if (
      e.card_id !== result.card_id ||
      e.actor.project_id !== result.actor.project_id
    )
      return false;
    const p = e.payload as Record<string, unknown>;
    return (
      ((e.type === "precheck_wait_delivered" &&
        e.actor.kind === "assignment" &&
        e.actor.assignment_id === check.assignment_id) ||
        (["work_item_resume_requested", "precheck_wait_escalated"].includes(
          e.type,
        ) &&
          e.actor.kind === "system" &&
          p.assignment_id === check.assignment_id)) &&
      p.work_item_id === check.work_item_id &&
      p.evidence === result.id
    );
  });
}

/** Persisted automatic handling; previousRunId scopes notification suppression. */
export function precheckConflictHandling(
  events: readonly Event[],
  check: Precheck,
  project: string,
  previousRunId?: string,
): Event | undefined {
  return eventsOfTypes(events, [
    "work_item_resume_requested",
    "baseline_conflict_limit_reached",
  ]).findLast((e) => {
    if (
      e.actor.kind !== "system" ||
      e.actor.project_id !== project ||
      e.card_id !== check.card_id ||
      ![
        "work_item_resume_requested",
        "baseline_conflict_limit_reached",
      ].includes(e.type)
    )
      return false;
    const p = e.payload as Record<string, unknown>;
    return (
      p.work_item_id === check.work_item_id &&
      (previousRunId === undefined || p.previous_run_id === previousRunId) &&
      ((e.type === "work_item_resume_requested" &&
        p.conflict_attempt_id === check.attempt_id) ||
        (e.type === "baseline_conflict_limit_reached" &&
          p.head_sha === check.head_sha))
    );
  });
}

export function pendingPrecheckConflict(
  events: readonly Event[],
  item: WorkItem,
  project: string,
): Precheck | undefined {
  const latest = latestPrecheckConflict(events, item, project);
  return latest && !precheckConflictHandling(events, latest, project)
    ? latest
    : undefined;
}

const FINGERPRINT = /^[a-f0-9]{64}$/u;
/**
 * C-798: one sha256 hex fingerprint per uniquely named check step. Domain
 * compares the host's values only; it never computes them.
 */
export function validCheckFingerprints(value: unknown): boolean {
  if (!Array.isArray(value) || !value.length) return false;
  const names = new Set<string>();
  for (const entry of value as unknown[]) {
    const e = entry as Record<string, unknown> | null;
    if (
      typeof e !== "object" ||
      e === null ||
      Object.keys(e).length !== 2 ||
      typeof e.name !== "string" ||
      !e.name.trim() ||
      typeof e.fingerprint !== "string" ||
      !FINGERPRINT.test(e.fingerprint) ||
      names.has(e.name)
    )
      return false;
    names.add(e.name);
  }
  return true;
}

/** The host uses this exact predicate before persisting a projected diagnostic. */
export function validPrecheckSummary(
  summary: string,
  external?: Precheck["external_run"],
): boolean {
  // The one URL a failure diagnostic can carry is the bound github.com run,
  // optionally followed by a numeric job. Never exempt other paths in the line.
  const locator =
    /(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/([1-9]\d*))(?:\/job\/[1-9]\d*)?$/u.exec(
      summary,
    );
  const diagnostic =
    locator &&
    external &&
    Number(locator[2]) === external.run_id &&
    locator[1] === external.html_url
      ? summary.slice(0, locator.index)
      : summary;
  return (
    summary.length <= 12000 &&
    !/(?<![\w.-])(?:\/|[A-Za-z]:\\)[^\s]+/u.test(diagnostic)
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
    // C-649: from the type index; filter-then-stable-sort keeps the order.
    const relevant = eventsOfTypes(events, PRECHECK_TYPES)
      .filter((e) => e.actor.kind === "system")
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
  check_fingerprints: _fingerprints,
  ...view
}: Precheck): PrecheckView {
  return view;
}

/** C-773: what host_ops may ask the host to do with a stuck author precheck. */
export const precheckRecoveryActions = ["reinspect", "abandon"] as const;
export type PrecheckRecoveryAction = (typeof precheckRecoveryActions)[number];
export interface PrecheckRecoveryRequest {
  readonly request_id: string;
  readonly card_id: CardId;
  readonly attempt_id: string;
  readonly action: PrecheckRecoveryAction;
}
const RECOVERY_TYPES = [
  "precheck_recovery_requested",
  "precheck_recovery_handled",
];
/**
 * C-773: the oldest host_ops request on this attempt that the host has not
 * handled yet. Only a host_ops Assignment can file one and only the system
 * marks it handled; anything else in the stream is ignored.
 */
export function pendingPrecheckRecovery(
  events: readonly Event[],
  card: CardId,
  attempt: string,
): PrecheckRecoveryRequest | undefined {
  const relevant = eventsOfTypes(events, RECOVERY_TYPES).filter(
    (e) =>
      e.card_id === card &&
      (e.payload as { attempt_id?: unknown })?.attempt_id === attempt,
  );
  const handled = new Set(
    relevant
      .filter(
        (e) =>
          e.type === "precheck_recovery_handled" && e.actor.kind === "system",
      )
      .map((e) => (e.payload as { request_id?: unknown }).request_id),
  );
  const request = relevant
    .filter(
      (e) =>
        e.type === "precheck_recovery_requested" &&
        e.actor.kind === "assignment" &&
        e.actor.role_id === "host_ops" &&
        !handled.has(e.id),
    )
    .sort((a, b) => a.seq - b.seq)[0];
  if (!request) return undefined;
  const action = (request.payload as { action?: unknown }).action;
  return precheckRecoveryActions.includes(action as PrecheckRecoveryAction)
    ? {
        request_id: request.id,
        card_id: card,
        attempt_id: attempt,
        action: action as PrecheckRecoveryAction,
      }
    : undefined;
}
