import type { CommandState } from "./commands/core.js";
import type { Assignment, Event, Run } from "./entities.js";
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

/** Owned by one analysis/command invocation. Never retained on CommandState or globally. */
export class UpstreamHealthSnapshot {
  private assignments?: Map<AssignmentId, Assignment>;
  private runs?: Map<AssignmentId, { all: Run[]; first: Map<unknown, Run> }>;
  private events?: {
    first: Map<unknown, Event>;
    buckets: Map<string, Map<unknown, Event[]>>;
  };

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

  private eventIndex() {
    if (!this.events) {
      this.events = { first: new Map(), buckets: new Map() };
      for (const event of this.state.events) {
        if (!this.events.first.has(event.id))
          this.events.first.set(event.id, event);
        if (!Object.hasOwn(eventKeys, event.type)) continue;
        const key = eventKeys[event.type as IndexedEvent];
        const value = (event.payload as Record<string, unknown>)[key];
        let byValue = this.events.buckets.get(event.type);
        if (!byValue) {
          byValue = new Map();
          this.events.buckets.set(event.type, byValue);
        }
        let bucket = byValue.get(value);
        if (!bucket) {
          bucket = [];
          byValue.set(value, bucket);
        }
        // Preserve input order: sequence and timestamp are not ordering keys here.
        bucket.push(event);
        const pair =
          event.type === "run_inactive" || event.type === "run_dispatch_stalled"
            ? "run_inactive|run_dispatch_stalled"
            : event.type === "bell_delivery_failed" ||
                event.type === "bell_delivery_attempt_failed"
              ? "bell_delivery_failed|bell_delivery_attempt_failed"
              : undefined;
        if (pair) {
          let combined = this.events.buckets.get(pair);
          if (!combined) {
            combined = new Map();
            this.events.buckets.set(pair, combined);
          }
          const ordered = combined.get(value) ?? [];
          ordered.push(event);
          combined.set(value, ordered);
        }
      }
    }
    return this.events;
  }

  event(id: unknown) {
    return this.eventIndex().first.get(id);
  }

  matching(
    type: IndexedEvent | CombinedEvent,
    value: unknown,
  ): readonly Event[] {
    return this.eventIndex().buckets.get(type)?.get(value) ?? [];
  }
}
