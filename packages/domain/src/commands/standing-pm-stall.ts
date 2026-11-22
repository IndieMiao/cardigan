import type { Actor, Assignment, Event, Run } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import { type HostOpsExecution, hostOpsPending } from "../host-ops.js";
import type { CardId } from "../ids.js";
import type { Notification } from "../notification.js";
import { pmNotificationState } from "../pm-notification.js";
import { runsOf } from "../run-index.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
} from "./core.js";
import { decisionFollowupBlocked } from "./decision-followup.js";
import { beginHostOpsActionInDraft } from "./host-ops-actions.js";
import { stoppedByHuman } from "./stop.js";

/**
 * C-596: a managed standing PM whose oldest undelivered notice has waited
 * past `threshold_ms` with no new Run is recovered in stages: redeliver the
 * original bells, restart the session after `grace_ms`, and hand the case to
 * host operations once `max_restarts` restarts happened within `window_ms`.
 */
export interface StandingPmStallPolicy {
  readonly threshold_ms: number;
  readonly grace_ms: number;
  readonly window_ms: number;
  readonly max_restarts: number;
}
export const DEFAULT_STANDING_PM_STALL_POLICY: StandingPmStallPolicy = {
  threshold_ms: 15 * 60_000,
  grace_ms: 5 * 60_000,
  window_ms: 60 * 60_000,
  max_restarts: 2,
};
export const STANDING_PM_STALL_EVENTS = {
  redeliver: "standing_pm_stall_redelivered",
  restart: "standing_pm_stall_restarted",
  escalate: "standing_pm_stall_escalated",
} as const;
export type StandingPmStallEscalation =
  | "repeated"
  | "restart_unconfirmed"
  | "session_maintenance"
  | "not_local";
interface StallBase {
  readonly assignment_id: Assignment["id"];
  /** Stream of the oldest stalled notice: it carries the timeline entry. */
  readonly card_id: CardId | null;
  readonly notification_ids: readonly string[];
  /** When the PM was last free with the oldest notice still undelivered. */
  readonly since: string;
  /** First event of an open recovery episode, if any. */
  readonly episode_id?: Event["id"];
}
export type StandingPmStallPlan =
  | (StallBase & { readonly stage: "redeliver" | "restart" })
  | (StallBase & {
      readonly stage: "escalate";
      readonly reason: StandingPmStallEscalation;
    });

const executing = (r: Run) =>
  ["dispatched", "acked", "running", "unknown"].includes(r.status) ||
  !!r.dispatch_stop ||
  !!r.inactivity_stop ||
  (!!r.launch_publication &&
    !["started", "exited"].includes(r.launch_publication.phase));
const types = new Set<string>(Object.values(STANDING_PM_STALL_EVENTS));
const of = (e: Event) =>
  (e.payload as { assignment_id?: string } | null)?.assignment_id;

export function standingPmStallEvents(
  state: CommandState,
  a: Assignment["id"],
): Event[] {
  return Object.values(STANDING_PM_STALL_EVENTS)
    .flatMap((t) => eventsOfType(state.events, t))
    .filter((e) => e.actor.kind === "system" && of(e) === a)
    .sort(
      (x, y) =>
        Date.parse(x.created_at) - Date.parse(y.created_at) ||
        (x.id < y.id ? -1 : 1),
    );
}

/**
 * Pure planner, reused by the host's read pass and inside every write. `notes`
 * are the PM's own undelivered rows: pending, delivery_failed, or a
 * needs_attention row handed off from this owner. Returns nothing while a Run
 * executes, the human stopped the PM, or a host operation is pending.
 */
export function planStandingPmStall(
  state: CommandState,
  a: Assignment,
  notes: readonly Notification[],
  now: string,
  policy: StandingPmStallPolicy = DEFAULT_STANDING_PM_STALL_POLICY,
): StandingPmStallPlan | undefined {
  if (
    a.scope !== "standing" ||
    a.role_id !== "pm" ||
    a.status !== "active" ||
    a.external ||
    stoppedByHuman(state.events, a.id)
  )
    return;
  const runs = runsOf(state.runs, a.id);
  if (runs.some(executing)) return;
  const at = Date.parse(now);
  let free = a.created_at;
  for (const r of runs)
    for (const t of [r.started_at, r.finished_at]) if (t && t > free) free = t;
  const acked = new Map<string, number>(
    state.cursors
      .filter((c) => c.assignment_id === a.id)
      .map((c) => [c.card_id ?? "", c.acked_seq]),
  );
  const held = new Set(state.cards.filter((c) => c.hold).map((c) => c.id));
  const backlog = notes
    .filter(
      (n) =>
        ["pending", "delivery_failed", "needs_attention"].includes(n.status) &&
        (acked.get(n.card_id ?? "") ?? -1) < n.seq &&
        !(n.card_id && held.has(n.card_id)) &&
        // Rows the dispatcher deliberately holds back are not a stall.
        !decisionFollowupBlocked(state, n.event_id, a.id) &&
        !(
          a.standing_mode === "ops" &&
          pmNotificationState(state, n) === "obsolete"
        ),
    )
    .map((n) => ({ n, since: later(n.created_at, free) }))
    .sort((x, y) => (x.since < y.since ? -1 : x.since > y.since ? 1 : 0));
  const oldest = backlog[0];
  if (!oldest) return;
  const base = {
    assignment_id: a.id,
    card_id: oldest.n.card_id ?? null,
    notification_ids: backlog.map((b) => b.n.id),
    since: oldest.since,
  };
  const history = standingPmStallEvents(state, a.id);
  const last = history.at(-1);
  // An episode stays open until an actual new Run of this PM starts.
  const open =
    last &&
    !runs.some((r) => r.started_at && r.started_at > last.created_at) &&
    oldest.since <= last.created_at
      ? last
      : undefined;
  const elapsed = (since: string) => at - Date.parse(since);
  if (hostOpsPending(state.events, a.id)) {
    // Only our own restart may still be unconfirmed; any other pending
    // operation owns the session until it settles.
    if (
      open?.type === STANDING_PM_STALL_EVENTS.restart &&
      elapsed(open.created_at) >= policy.grace_ms
    )
      return {
        ...base,
        episode_id: episodeOf(open),
        stage: "escalate",
        reason: "restart_unconfirmed",
      };
    return;
  }
  if (!open) {
    if (elapsed(oldest.since) < policy.threshold_ms) return;
    return { ...base, stage: "redeliver" };
  }
  const episode = episodeOf(open);
  if (open.type === STANDING_PM_STALL_EVENTS.redeliver) {
    if (elapsed(open.created_at) < policy.grace_ms) return;
    const recent = history.filter(
      (e) =>
        e.type === STANDING_PM_STALL_EVENTS.restart &&
        elapsed(e.created_at) < policy.window_ms,
    ).length;
    const reason: StandingPmStallEscalation | undefined =
      recent >= policy.max_restarts
        ? "repeated"
        : a.role_upgrade || a.idle_retirement
          ? "session_maintenance"
          : a.machine_id !== "local"
            ? "not_local"
            : undefined;
    return reason
      ? { ...base, episode_id: episode, stage: "escalate", reason }
      : { ...base, episode_id: episode, stage: "restart" };
  }
  // A restart that settled without a new Run, or an escalation whose window
  // passed, starts a new episode with a fresh redelivery.
  const wait =
    open.type === STANDING_PM_STALL_EVENTS.restart
      ? policy.threshold_ms
      : policy.window_ms;
  if (elapsed(open.created_at) < wait) return;
  return { ...base, stage: "redeliver" };
}

/** ISO timestamps compare as strings. */
function later(a: string, b: string) {
  return a < b ? b : a;
}

function episodeOf(e: Event) {
  return (
    ((e.payload as { episode_id?: string }).episode_id as Event["id"]) ?? e.id
  );
}

function notice(state: CommandState, a: Assignment, plan: StandingPmStallPlan) {
  const name = state.employees?.find((e) => e.id === a.employee_id)?.name;
  const who = `常驻 PM ${name ? `${name}（${a.id}）` : a.id}`;
  const count = plan.notification_ids.length;
  if (plan.stage !== "escalate")
    return plan.stage === "redeliver"
      ? `${who}有 ${count} 条通知长时间没有新 Run 处理，系统已按原门铃重投。`
      : `${who}重投后仍没有新 Run，系统已安排重开会话（等同 pm restart），待处理事项保留。`;
  const why = {
    repeated: "短时间内反复停滞",
    restart_unconfirmed: "自动重开未能确认旧会话退出",
    session_maintenance: "正在会话维护，不能自动重开",
    not_local: "不在本机运行时，不能自动重开",
  }[plan.reason];
  return `${who}${why}，已转主机运维核查；系统暂停自动重开。`;
}

interface StallParams {
  readonly assignment_id: Assignment["id"];
  /** Rows loaded in the same write transaction as this command. */
  readonly notes: readonly Notification[];
  readonly policy?: StandingPmStallPolicy;
  /** Host observation of the bound terminal, for the audit only. */
  readonly observation?: string;
}

function current(
  d: CommandDraft,
  p: StallParams,
  stage: StandingPmStallPlan["stage"],
) {
  const a = d.get("assignments", p.assignment_id);
  const plan = planStandingPmStall(d.state, a, p.notes, d.now, p.policy);
  ensure(
    plan?.stage === stage,
    "stale_target",
    "常驻 PM 停滞状态已改变，本次恢复不再执行",
  );
  if (p.observation !== undefined) text(p.observation, "observation");
  return { a, plan };
}

function record(
  d: CommandDraft,
  a: Assignment,
  plan: StandingPmStallPlan,
  extra: Record<string, string> = {},
  observation?: string,
) {
  const body = notice(d.state, a, plan);
  return d.emit(
    STANDING_PM_STALL_EVENTS[plan.stage],
    plan.card_id ?? undefined,
    {
      assignment_id: a.id,
      ...(a.standing_mode ? { standing_mode: a.standing_mode } : {}),
      notification_ids: [...plan.notification_ids],
      since: plan.since,
      ...(plan.episode_id ? { episode_id: plan.episode_id } : {}),
      ...(plan.stage === "escalate" ? { reason: plan.reason } : {}),
      ...(observation ? { observation } : {}),
      ...extra,
      notice: body,
    },
    { type: "system", body, author: "system" },
  );
}

/** System-only first stage; the host retries the same rows in this transaction. */
export function recordStandingPmStallRedelivery(
  state: CommandState,
  actor: Actor,
  p: StallParams,
  ports: CommandPorts,
) {
  return command(state, actor, "recover_standing_pm", ports, (d) => {
    const { a, plan } = current(d, p, "redeliver");
    return { plan, event: record(d, a, plan, {}, p.observation) };
  });
}

/**
 * Second stage: the same host_ops standing-PM restart as `pm restart`. The
 * host proves the old terminal exited before the successor Run is queued;
 * pending notices, decisions and human actions stay with the Assignment.
 */
export function beginStandingPmStallRestart(
  state: CommandState,
  actor: Actor,
  p: StallParams & { snapshot: NonNullable<HostOpsExecution["snapshot"]> },
  ports: CommandPorts,
) {
  return command(state, actor, "recover_standing_pm", ports, (d) => {
    const { a, plan } = current(d, p, "restart");
    const action = beginHostOpsActionInDraft(d, {
      tool: "host_ops_restart_standing_pm",
      target_id: a.id,
      reason: "常驻 PM 通知长时间未投递，重投后仍没有新 Run，系统重开会话。",
      snapshot: p.snapshot,
    });
    const event = record(
      d,
      a,
      plan,
      { action_id: action.action_id },
      p.observation,
    );
    return { plan, event, action_id: action.action_id };
  });
}

/** Third stage: host operations take over; the human is only informed. */
export function escalateStandingPmStall(
  state: CommandState,
  actor: Actor,
  p: StallParams,
  ports: CommandPorts,
) {
  return command(state, actor, "recover_standing_pm", ports, (d) => {
    const { a, plan } = current(d, p, "escalate");
    return { plan, event: record(d, a, plan, {}, p.observation) };
  });
}

export function isStandingPmStallEvent(e: Event) {
  return types.has(e.type);
}
