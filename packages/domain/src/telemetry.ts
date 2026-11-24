import type { Event } from "./entities.js";

/**
 * C-643: high-volume host telemetry. These events stay in the event table
 * (timeline, activity, get_updates and bells read them as before), but the
 * command-state event stream excludes them, so generic projections that scan
 * `state.events` no longer walk them. Rules that need them read the journal
 * through the indexed lookups in `event-index.ts` or `fullEventHistory`.
 */
export const TELEMETRY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "github_check_dispatch",
  "github_probe_dispatch",
  "run_queued",
  "run_dispatched",
  "run_started",
  "run_finished",
  "assignment_branch_backed_up",
  "session_maintenance_changed",
]);
export const isTelemetryEvent = (event: Pick<Event, "type">) =>
  TELEMETRY_EVENT_TYPES.has(event.type);
