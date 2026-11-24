import type { CommandDraft, CommandState } from "./commands/core.js";
import type { Event, Run } from "./entities.js";
import { eventsOfType, eventsOfTypes } from "./event-index.js";
import {
  associatedHarnessActivity,
  type HarnessActivity,
} from "./harness-activity.js";
import type { EventId } from "./ids.js";

export const DEFAULT_PROVIDER_FAILURES = 2;
export const DEFAULT_PROVIDER_COOLDOWN_MS = 5 * 60_000;
interface Incident {
  episode: EventId;
  failures: number;
  retry_at?: string;
  cooldown_ms: number;
}
const cache = new WeakMap<readonly Event[], ReadonlyMap<string, Incident>>();
/** All breaker facts belong to the project stream, so seq orders concurrent cards. */
export function providerIncidents(events: readonly Event[]) {
  const hit = cache.get(events);
  if (hit) return hit;
  const current = new Map<string, Incident>();
  // C-649: the two breaker types, in history order, from the type index.
  for (const e of eventsOfTypes(events, [
    "provider_start_failed",
    "provider_start_restored",
  ])) {
    if (
      e.card_id ||
      !["provider_start_failed", "provider_start_restored"].includes(e.type)
    )
      continue;
    const p = e.payload;
    if (
      !p ||
      typeof p !== "object" ||
      !("profile" in p) ||
      typeof p.profile !== "string"
    )
      continue;
    const previous = current.get(p.profile);
    if (e.type === "provider_start_restored") current.delete(p.profile);
    else if (
      typeof p.failures === "number" &&
      typeof p.cooldown_ms === "number"
    )
      current.set(p.profile, {
        episode: previous?.retry_at ? previous.episode : e.id,
        failures: p.failures,
        cooldown_ms: p.cooldown_ms,
        ...(typeof p.retry_at === "string" ? { retry_at: p.retry_at } : {}),
      });
  }
  cache.set(events, current);
  return current;
}

export function recordProviderFailure(
  d: CommandDraft,
  run: Run,
  threshold: number,
  cooldown: number,
) {
  const profile = run.launch_profile_ref;
  if (!profile) return;
  const prior = providerIncidents(d.state.events).get(profile);
  const failures = (prior?.failures ?? 0) + 1;
  const paused = !!prior?.retry_at || failures >= threshold;
  const notice = paused && !prior?.retry_at;
  d.emit("provider_start_failed", undefined, {
    profile,
    failures,
    run_id: run.id,
    cooldown_ms: cooldown,
    ...(paused
      ? { retry_at: new Date(Date.parse(d.now) + cooldown).toISOString() }
      : {}),
    ...(notice
      ? {
          notice: `模型服务不可用：${profile} 已连续 ${failures} 次启动失败，暂停新派发。`,
        }
      : {}),
  });
}
export function providerStarted(d: CommandDraft, run: Run) {
  const profile = run.launch_profile_ref;
  if (!profile) return;
  const incident = providerIncidents(d.state.events).get(profile);
  if (
    incident &&
    (!incident.retry_at || run.provider_probe?.episode === incident.episode)
  )
    d.emit("provider_start_restored", undefined, { profile, run_id: run.id });
}

/** Caller saves the probe reservation with the launch intent in the same transaction. */
export function providerAdmission(
  state: CommandState,
  profile: string | undefined,
  now: string,
  inFlight: (run: Run) => boolean,
): "wait" | Run["provider_probe"] {
  if (!profile) return;
  const incident = providerIncidents(state.events).get(profile);
  if (!incident?.retry_at) return;
  const time = Date.parse(now);
  if (time < Date.parse(incident.retry_at)) return "wait";
  for (const run of state.runs) {
    const probe = run.provider_probe;
    if (probe?.episode !== incident.episode) continue;
    if (
      time < Date.parse(probe.at) + incident.cooldown_ms ||
      (run.status === "queued"
        ? inFlight(run)
        : !["failed", "cancelled", "completed"].includes(run.status))
    )
      return "wait";
  }
  return { episode: incident.episode, at: now };
}

export function providerStartFailed(
  state: CommandState,
  run: Run,
  sample: HarnessActivity | undefined,
  now: string,
  timeoutMs: number,
) {
  const a = state.assignments.find((a) => a.id === run.assignment_id);
  if (
    !a ||
    run.started_at ||
    run.heartbeat_at ||
    !["unknown", "dispatched"].includes(run.status) ||
    !run.launch_profile_ref
  )
    return false;
  // The caller just re-read this terminal's transcript (again before stopping).
  // The error can be as old as the dispatch window; a cached sample is not proof.
  const activity = associatedHarnessActivity(state, a, now, sample);
  if (
    !activity?.error ||
    activity.error === "unclassified" ||
    activity.model_silent_since === undefined
  )
    return false;
  const start = eventsOfType(state.events, "run_dispatched").findLast(
    (e) => (e.payload as { run_id?: string }).run_id === run.id,
  )?.created_at;
  return (
    !!start &&
    !(
      a.last_mcp_activity_at &&
      Date.parse(a.last_mcp_activity_at) >= Date.parse(start)
    ) &&
    Date.parse(now) - Date.parse(start) >= timeoutMs &&
    Date.parse(activity.updated_at) >= Date.parse(start) &&
    activity.model_silent_since < Date.parse(start)
  );
}
