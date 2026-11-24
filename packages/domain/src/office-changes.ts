import type { Assignment, Card, Cursor, Event } from "./entities.js";
import type { CardId, ProjectId } from "./ids.js";

/**
 * C-722: the two tiers of project changes a PM Office hears about.
 *
 * - `alert`: exceptions and pending work. The Router adds one extra
 *   notification for the project's own active Office on top of the event's
 *   existing recipients; it rides the normal inbox, bell merging (§6.7) and
 *   ACK path. Nothing is blocked or gated by it.
 * - `digest`: routine progress. It never rings the Office; the Office reads it
 *   from `get_updates` on the project stream (session start or next wake).
 *
 * Every rule is scoped to one project: the Office of another project never
 * hears about these events.
 */
export const OFFICE_ALERT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "human_action_requested",
  "blocker_reported",
  "run_inactive",
  "merge_conflicted",
  "decision_requested",
]);

export const OFFICE_DIGEST_EVENT_TYPES: ReadonlySet<string> = new Set([
  "card_created",
  "card_updated",
  "card_hold_set",
  "card_hold_released",
  "delivery_submitted",
  "delivery_accepted",
  "review_submitted",
  "completion_reviewed",
  "card_merged",
  "host_deployment_recorded",
]);

/** Newest digest entries returned per read; older ones are counted, not lost. */
export const DEFAULT_OFFICE_DIGEST_LIMIT = 50;

export function officeChangeTier(type: string): "alert" | "digest" | undefined {
  if (OFFICE_ALERT_EVENT_TYPES.has(type)) return "alert";
  if (OFFICE_DIGEST_EVENT_TYPES.has(type)) return "digest";
  return undefined;
}

/** The PM Office on duty: active (not suspended or released) and explicitly `standing_mode=office`. */
export function isOfficeOnDuty(assignment: Assignment): boolean {
  return (
    assignment.scope === "standing" &&
    assignment.role_id === "pm" &&
    assignment.standing_mode === "office" &&
    assignment.status === "active"
  );
}

export function officeOnDuty(
  assignments: readonly Assignment[],
): Assignment | undefined {
  return assignments.find(isOfficeOnDuty);
}

const payloadField = (event: Event, key: string): unknown =>
  event.payload &&
  typeof event.payload === "object" &&
  !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)[key]
    : undefined;

/** The Office's own actions (and its own inactivity) never notify itself. */
function concernsOffice(event: Event, office: Assignment): boolean {
  return (
    (event.actor.kind === "assignment" &&
      event.actor.assignment_id === office.id) ||
    payloadField(event, "assignment_id") === office.id
  );
}

/**
 * Whether `event` adds one alert notification for the project's Office.
 * Returns that Office, or `undefined` when nothing should be delivered: a
 * non-alert type, another project's event, no Office on duty (none,
 * suspended, released or not `standing_mode=office`), or an event about the
 * Office itself. Never fails.
 */
export function officeAlertRecipient(
  project_id: ProjectId,
  event: Event,
  assignments: readonly Assignment[],
): Assignment | undefined {
  if (officeChangeTier(event.type) !== "alert") return undefined;
  if (event.actor.project_id !== project_id) return undefined;
  const office = officeOnDuty(assignments);
  if (!office || concernsOffice(event, office)) return undefined;
  return office;
}

export interface OfficeDigestEntry {
  readonly card_id: CardId;
  readonly card_title?: string;
  readonly seq: number;
  readonly type: string;
  readonly created_at: string;
  /** A few identifying payload fields (ids, verdict, status). */
  readonly detail?: Readonly<Record<string, string>>;
}

export interface OfficeDigest {
  /** Routine card changes at or after this time are listed. */
  readonly since: string;
  /** Newest first. */
  readonly entries: readonly OfficeDigestEntry[];
  /** Matching entries beyond the limit. */
  readonly omitted: number;
}

const DETAIL_FIELDS = [
  "work_item_id",
  "delivery_id",
  "review_id",
  "verdict",
  "status",
] as const;

function detailOf(event: Event): Record<string, string> | undefined {
  const detail: Record<string, string> = {};
  for (const key of DETAIL_FIELDS) {
    const value = payloadField(event, key);
    if (typeof value === "string") detail[key] = value;
  }
  return Object.keys(detail).length ? detail : undefined;
}

/**
 * C-722: where the Office's digest starts. The Office's existing ACK cursor
 * on the project stream is the watermark: the time of the project event it
 * last acknowledged, or the Office's creation when it never acknowledged one.
 * Nothing is stored for the digest itself, so a new session reads the same
 * window until the Office acknowledges the project stream again.
 */
export function officeDigestSince(
  office: Assignment,
  projectEvents: readonly Event[],
  projectCursor: number,
): string {
  if (projectCursor > 0) {
    const acked = projectEvents.find((e) => e.seq === projectCursor);
    if (acked && acked.created_at > office.created_at) return acked.created_at;
  }
  return office.created_at;
}

/**
 * C-722: routine progress on the project's cards since the Office's
 * watermark. Events the Office already acknowledged on that card's own
 * stream, events of other projects and the Office's own actions are left
 * out. Project-level routine events (for example `host_deployment_recorded`)
 * already arrive in the same `get_updates` read and are not repeated here.
 * Ties on the watermark are kept (repeat rather than lose).
 */
export function officeDigest(input: {
  readonly project_id: ProjectId;
  readonly office: Assignment;
  /** Card-stream events of the digest types; extra events are filtered. */
  readonly events: Iterable<Event>;
  readonly since: string;
  readonly cursors: readonly Cursor[];
  readonly cards: readonly Pick<Card, "id" | "title">[];
  readonly limit?: number;
}): OfficeDigest {
  const limit = Math.max(0, input.limit ?? DEFAULT_OFFICE_DIGEST_LIMIT);
  const acked = new Map<string, number>();
  for (const cursor of input.cursors)
    if (cursor.assignment_id === input.office.id)
      acked.set(cursor.card_id, cursor.acked_seq);
  const matched: Event[] = [];
  for (const event of input.events) {
    if (
      !event.card_id ||
      officeChangeTier(event.type) !== "digest" ||
      event.actor.project_id !== input.project_id ||
      event.created_at < input.since ||
      event.seq <= (acked.get(event.card_id) ?? 0) ||
      concernsOffice(event, input.office)
    )
      continue;
    matched.push(event);
  }
  matched.sort(
    (a, b) =>
      (a.created_at < b.created_at
        ? 1
        : a.created_at > b.created_at
          ? -1
          : 0) ||
      String(a.card_id).localeCompare(String(b.card_id)) ||
      b.seq - a.seq,
  );
  const titles = new Map(input.cards.map((c) => [c.id, c.title]));
  const entries = matched.slice(0, limit).map((event): OfficeDigestEntry => {
    const card_id = event.card_id as CardId;
    const title = titles.get(card_id);
    const detail = detailOf(event);
    return {
      card_id,
      ...(title === undefined ? {} : { card_title: title }),
      seq: event.seq,
      type: event.type,
      created_at: event.created_at,
      ...(detail ? { detail } : {}),
    };
  });
  return {
    since: input.since,
    entries,
    omitted: matched.length - entries.length,
  };
}
