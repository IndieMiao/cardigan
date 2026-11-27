import type { CommandState } from "./commands/core.js";
import type { Event } from "./entities.js";
import { eventsOfType } from "./event-index.js";
import type { AssignmentId, CardId, EventId, RunId } from "./ids.js";

/**
 * C-821: a model service outage seen by the sessions themselves. A session
 * that went quiet while its own terminal shows a model API error (5xx,
 * "No available accounts", overloaded, 429) joins the one open outage of its
 * provider. The host probes the provider with a minimal model request; once
 * it answers, every session still stopped on that error gets one resume
 * message. Facts live in events only:
 *
 * - `upstream_outage_started` (project stream): one per provider and outage.
 * - `upstream_outage_session_added` (card stream): one per stopped Run.
 * - `upstream_outage_resolved` (project stream): the probe answered.
 * - `upstream_outage_resume` (card stream): the one resume attempt per Run.
 * - `upstream_outage_reminded` (project stream): the single Needs You reminder.
 */
export interface UpstreamOutagePolicy {
  /** Between two recovery probes of one provider. */
  readonly probe_interval_ms: number;
  /** How long an outage may last before the single Needs You reminder. */
  readonly remind_after_ms: number;
  /** After recovery, how long a stopped session stays reserved for its resume. */
  readonly resume_window_ms: number;
}
export const DEFAULT_UPSTREAM_OUTAGE_POLICY: UpstreamOutagePolicy = {
  probe_interval_ms: 60_000,
  remind_after_ms: 30 * 60_000,
  resume_window_ms: 10 * 60_000,
};

export type UpstreamOutageResumeResult =
  /** Claimed immediately before the send; at most one per Run and outage. */
  | "sent"
  /** The send was claimed but its delivery could not be confirmed. */
  | "unconfirmed"
  /** The session no longer showed the error at an empty prompt. */
  | "skipped"
  /** The send failed before it was claimed. */
  | "failed";

export interface UpstreamOutageSession {
  readonly assignment_id: AssignmentId;
  readonly run_id: RunId;
  readonly card_id?: CardId;
  readonly profile?: string;
  readonly at: string;
  readonly resume?: {
    readonly result: UpstreamOutageResumeResult;
    readonly at: string;
  };
}
export interface UpstreamOutage {
  readonly id: EventId;
  readonly provider: string;
  readonly started_at: string;
  readonly sessions: readonly UpstreamOutageSession[];
  readonly resolved_at?: string;
  readonly reminded_at?: string;
  readonly human_action_id?: string;
}

const field = (e: Event, key: string) =>
  (e.payload as Record<string, unknown> | null)?.[key];
const text = (e: Event, key: string) => {
  const v = field(e, key);
  return typeof v === "string" ? v : undefined;
};

const outageCache = new WeakMap<readonly Event[], readonly UpstreamOutage[]>();

/** Every outage, oldest first. Cached per immutable events array (C-221). */
export function upstreamOutages(
  state: Pick<CommandState, "events">,
): readonly UpstreamOutage[] {
  const cached = outageCache.get(state.events);
  if (cached) return cached;
  const outages = buildOutages(state.events);
  outageCache.set(state.events, outages);
  return outages;
}

function buildOutages(events: readonly Event[]): readonly UpstreamOutage[] {
  const started = eventsOfType(events, "upstream_outage_started");
  if (!started.length) return [];
  const byId = (type: string) => {
    const map = new Map<string, Event[]>();
    for (const e of eventsOfType(events, type)) {
      const id = text(e, "outage_id");
      if (!id) continue;
      const list = map.get(id);
      if (list) list.push(e);
      else map.set(id, [e]);
    }
    return map;
  };
  const added = byId("upstream_outage_session_added");
  const resolved = byId("upstream_outage_resolved");
  const resumed = byId("upstream_outage_resume");
  const reminded = byId("upstream_outage_reminded");
  return started.map((start) => {
    const resumes = new Map<string, UpstreamOutageSession["resume"]>();
    for (const e of resumed.get(start.id) ?? []) {
      const run = text(e, "run_id");
      const result = text(e, "result") as UpstreamOutageResumeResult;
      // "unconfirmed" refines a claimed send; it never reopens the Run.
      if (run) resumes.set(run, { result, at: e.created_at });
    }
    const sessions: UpstreamOutageSession[] = [];
    for (const e of added.get(start.id) ?? []) {
      const run_id = text(e, "run_id") as RunId | undefined;
      const assignment_id = text(e, "assignment_id") as
        | AssignmentId
        | undefined;
      if (
        !run_id ||
        !assignment_id ||
        sessions.some((s) => s.run_id === run_id)
      )
        continue;
      const profile = text(e, "profile");
      const resume = resumes.get(run_id);
      sessions.push({
        assignment_id,
        run_id,
        ...(e.card_id ? { card_id: e.card_id } : {}),
        ...(profile ? { profile } : {}),
        at: e.created_at,
        ...(resume ? { resume } : {}),
      });
    }
    const end = resolved.get(start.id)?.[0];
    const reminder = reminded.get(start.id)?.[0];
    const action = reminder && text(reminder, "human_action_id");
    return {
      id: start.id,
      provider: text(start, "provider") ?? "",
      started_at: start.created_at,
      sessions,
      ...(end ? { resolved_at: end.created_at } : {}),
      ...(reminder ? { reminded_at: reminder.created_at } : {}),
      ...(action ? { human_action_id: action } : {}),
    };
  });
}

export function openUpstreamOutage(
  state: Pick<CommandState, "events">,
  provider: string,
) {
  return upstreamOutages(state).findLast(
    (o) => o.provider === provider && !o.resolved_at,
  );
}

/** The latest outage this Run stopped in. */
export function upstreamOutageOfRun(
  state: Pick<CommandState, "events">,
  run: RunId,
) {
  return upstreamOutages(state).findLast((o) =>
    o.sessions.some((s) => s.run_id === run),
  );
}

/**
 * The Run waits for its outage's resume: the outage is open, or it was
 * resolved within the resume window and this Run has no resume attempt yet.
 */
export function runAwaitingUpstreamResume(
  state: Pick<CommandState, "events">,
  run: RunId,
  now: string,
  policy: Pick<
    UpstreamOutagePolicy,
    "resume_window_ms"
  > = DEFAULT_UPSTREAM_OUTAGE_POLICY,
) {
  const outage = upstreamOutageOfRun(state, run);
  const session = outage?.sessions.find((s) => s.run_id === run);
  if (!outage || !session || session.resume) return false;
  return (
    !outage.resolved_at ||
    Date.parse(now) - Date.parse(outage.resolved_at) < policy.resume_window_ms
  );
}

/**
 * Inactivity alerts and inactive stops leave the Run alone while it waits for
 * its resume, and for one resume window after a resume message was sent (its
 * last recorded activity predates the outage). Afterwards, or when no message
 * was sent, the existing inactivity flow applies.
 */
export function runHeldByUpstreamOutage(
  state: Pick<CommandState, "events">,
  run: RunId,
  now: string,
  policy: Pick<
    UpstreamOutagePolicy,
    "resume_window_ms"
  > = DEFAULT_UPSTREAM_OUTAGE_POLICY,
) {
  if (runAwaitingUpstreamResume(state, run, now, policy)) return true;
  const resume = upstreamOutageOfRun(state, run)?.sessions.find(
    (s) => s.run_id === run,
  )?.resume;
  return (
    (resume?.result === "sent" || resume?.result === "unconfirmed") &&
    Date.parse(now) - Date.parse(resume.at) < policy.resume_window_ms
  );
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal ANSI styling before matching fixed UI markers.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
/** The first line of a model API error as Claude Code or Codex prints it. */
const ERROR_START =
  /^(?:[⎿●■⚠✗✘]\s*)*(?:API Error\b|unexpected status\b|stream error\b|exceeded retry limit\b)/iu;
/** A new message, prompt or spinner: the error is not the last thing shown. */
const NEW_BLOCK = /^(?:[●⏺>›❯✻✶✳✢·*]\s|[●⏺✻✶✳✢]$)/u;
const STATUS =
  /(?:API Error:?|unexpected status|last status:?)\s*\(?(\d{3})\b/iu;
const OUTAGE_TEXT =
  /No available accounts|overloaded|Service Unavailable|Bad Gateway|Gateway Timeout/iu;
const NOT_OUTAGE = /Connection lost mid-response|stream disconnected/iu;
const SCAN_LINES = 12;

/**
 * C-821: whether the lines directly above an empty editor end with a model
 * API outage error (5xx, 429, "No available accounts", overloaded). The text
 * is only matched, never returned. A disconnect belongs to client recovery;
 * an authentication or request error is not an outage.
 */
export function upstreamApiErrorShown(lines: readonly string[]): boolean {
  const recent = lines
    .map((line) => line.replace(ANSI, "").trim())
    .filter(Boolean)
    .slice(-SCAN_LINES);
  const start = recent.findLastIndex((line) => ERROR_START.test(line));
  if (start < 0) return false;
  const block = recent.slice(start);
  if (block.slice(1).some((line) => NEW_BLOCK.test(line))) return false;
  const joined = block.join(" ");
  if (NOT_OUTAGE.test(joined)) return false;
  const status = Number(joined.match(STATUS)?.[1]);
  return (
    (status >= 500 && status <= 599) ||
    status === 429 ||
    OUTAGE_TEXT.test(joined)
  );
}
