import {
  type CommandState,
  type Event,
  eventById,
  eventsOfType,
  type Run,
} from "@cardigan/domain";

const indexes = new WeakMap<
  readonly Event[],
  (run: Run) => { queued_at?: string }
>();
/** When each Run was queued: its run_queued event, else its trigger event. */
export function runQueuedAt({ events }: Pick<CommandState, "events">) {
  const cached = indexes.get(events);
  if (cached) return cached;
  const queuedAt = new Map<string, string>();

  for (const event of eventsOfType(events, "run_queued")) {
    const runId = (event.payload as { readonly run_id?: unknown }).run_id;
    if (typeof runId === "string" && !queuedAt.has(runId))
      queuedAt.set(runId, event.created_at);
  }
  const lookup = (run: Run) => {
    const at =
      queuedAt.get(run.id) ??
      eventById(events, run.trigger_event_id)?.created_at;
    return at === undefined ? {} : { queued_at: at };
  };
  indexes.set(events, lookup);
  return lookup;
}
