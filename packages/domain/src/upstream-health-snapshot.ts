import type { CommandState } from "./commands/core.js";
import type { Assignment, Event, Run } from "./entities.js";
import { eventById, eventsOfType } from "./event-index.js";
import type { AssignmentId } from "./ids.js";

const eventKeys = {
  run_inactive: "assignment_id",
  run_dispatch_stalled: "assignment_id",
  host_ops_action_finished: "assignment_id",
  host_ops_action_taken: "assignment_id",
  bell_delivery_failed: "assignment_id",
  bell_delivery_attempt_failed: "assignment_id",
  upstream_incident_started: "group",
  upstream_incident_resolved: "incident_id",
  upstream_incident_expanded: "incident_id",
  upstream_harness_failed: "group",
  upstream_probe_changed: "provider",
  upstream_recovery_ready: "incident_id",
  upstream_recovery_recurred: "inactive_event_id",
  human_action_requested: "upstream_key",
} as const;
type IndexedEvent = keyof typeof eventKeys;
type CombinedEvent =
  | "run_inactive|run_dispatch_stalled"
  | "bell_delivery_failed|bell_delivery_attempt_failed";

/**
 * Owned by one analysis/command invocation. Never retained on CommandState or
 * globally; event buckets are keyed by the immutable events array itself.
 */
export class UpstreamHealthSnapshot {
  private assignments?: Map<AssignmentId, Assignment>;
  private runs?: Map<AssignmentId, { all: Run[]; first: Map<unknown, Run> }>;

  constructor(
    private readonly state: Pick<CommandState, "events"> &
      Partial<Pick<CommandState, "assignments" | "runs">>,
  ) {}

  assignment(id: AssignmentId) {
    if (!this.assignments) {
      this.assignments = new Map();
      for (const a of this.state.assignments ?? [])
        if (!this.assignments.has(a.id)) this.assignments.set(a.id, a);
    }
    return this.assignments.get(id);
  }

  private assignmentRuns(id: AssignmentId) {
    if (!this.runs) {
      this.runs = new Map();
      for (const run of this.state.runs ?? []) {
        let bucket = this.runs.get(run.assignment_id);
        if (!bucket) {
          bucket = { all: [], first: new Map() };
          this.runs.set(run.assignment_id, bucket);
        }
        bucket.all.push(run);
        // Array.find matches the first (assignment, Run ID), even for duplicate IDs.
        if (!bucket.first.has(run.id)) bucket.first.set(run.id, run);
      }
    }
    return this.runs.get(id);
  }

  run(id: AssignmentId, runId: unknown) {
    return this.assignmentRuns(id)?.first.get(runId);
  }

  runsFor(id: AssignmentId): readonly Run[] {
    return this.assignmentRuns(id)?.all ?? [];
  }

  event(id: unknown) {
    return typeof id === "string"
      ? eventById(this.state.events, id)
      : undefined;
  }

  matching(
    type: IndexedEvent | CombinedEvent,
    value: unknown,
  ): readonly Event[] {
    return eventBuckets(this.state.events, type).get(value) ?? noEvents;
  }
}

const noEvents: readonly Event[] = Object.freeze([]);
/**
 * C-670: buckets keyed by the immutable events array (C-221), shared by every
 * snapshot of the same history. Single types read the typed index, so no
 * lookup walks the whole history; a combined pair keeps input order.
 */
const bucketCache = new WeakMap<
  readonly Event[],
  Map<string, ReadonlyMap<unknown, readonly Event[]>>
>();
function eventBuckets(
  events: readonly Event[],
  type: IndexedEvent | CombinedEvent,
): ReadonlyMap<unknown, readonly Event[]> {
  let cache = bucketCache.get(events);
  if (!cache) {
    cache = new Map();
    bucketCache.set(events, cache);
  }
  let buckets = cache.get(type);
  if (!buckets) {
    const map = new Map<unknown, Event[]>();
    for (const event of typedEvents(events, type)) {
      const key = eventKeys[event.type as IndexedEvent];
      const value = (event.payload as Record<string, unknown>)[key];
      const bucket = map.get(value);
      if (bucket) bucket.push(event);
      else map.set(value, [event]);
    }
    buckets = map;
    cache.set(type, buckets);
  }
  return buckets;
}
function typedEvents(
  events: readonly Event[],
  type: IndexedEvent | CombinedEvent,
): readonly Event[] {
  const [first, second] = type.split("|") as [IndexedEvent, IndexedEvent?];
  const head = eventsOfType(events, first);
  if (!second) return head;
  const tail = eventsOfType(events, second);
  if (!head.length) return tail;
  if (!tail.length) return head;
  // Both types occur: interleave in input order (one identity pass).
  const wanted = new Set<Event>([...head, ...tail]);
  return events.filter((e) => wanted.has(e));
}
