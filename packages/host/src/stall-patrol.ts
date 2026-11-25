import { isDeepStrictEqual } from "node:util";
import {
  type Assignment,
  beginStalledPatrolRestart,
  beginSystemTurnRestart,
  type Clock,
  type CommandState,
  type Event,
  eventById,
  eventsOfType,
  type HostOpsExecution,
  heldPause,
  heldPauseHandler,
  hostOpsPending,
  nudgeStalledPatrol,
  observedLocalExitCause,
  type ProjectId,
  patrolNudges,
  type Runtime,
  type RuntimeRef,
  requestHeldAssignmentResume,
  runsOf,
  STANDING_PM_STALL_EVENTS,
  stoppedByHuman,
  systemTurnOwner,
  type WithdrawnRecoveryDiagnosis,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import {
  recordNotification,
  type Store,
  standingResolver,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { recoveryPm } from "./automatic-context-restart.js";
import {
  type DispatchStall,
  dispatchHandoffs,
  dispatchStallCauses,
} from "./dispatch-stalls.js";
import { heldBacklogMs, heldBacklogs } from "./held-backlog.js";
import { releaseExitedAgent } from "./idle-session-retirement.js";
import {
  observeTurnOwner,
  sessionExitProof,
  stallEvidence,
  stallWorkspace,
} from "./stall-evidence.js";
import { overdueStallHandoffs } from "./stall-handoff.js";
import {
  doneSessionReleaseMs,
  managedReleaseCommand,
  releaseStalledSession,
  SESSION_RELEASE_HELD,
  type StalledSession,
  sessionReleaseHandedOff,
  stalledSessionDecision,
  stalledSessionReleaseMs,
  stalledSessions,
  systemTurnReleased,
  TRANSIENT_RELEASE_REFUSALS,
} from "./stalled-session-release.js";
import { StandingPmRecovery } from "./standing-pm-recovery.js";

function turnKey(s: DispatchStall) {
  return s.retirement_handoff ? s.cause_id : s.system_finished_run_id;
}
// Maintenance observations are a projection (not the retirement/upgrade fence).
// Exclude only that projection from the CAS. A new runtime or activity sample
// invalidates the observation; retry it only for the very same registration.
/** Same incident key as the patrol's turn recovery: retirement transfers by
 * cause, system-ended turns by the ended Run. */
function incidentMatches(stall: DispatchStall, payload: unknown) {
  const p = payload as {
    system_finished_run_id?: string;
    cause_id?: string;
    dispatch_stall_id?: string;
  };
  return stall.retirement_handoff
    ? (p.cause_id ?? p.dispatch_stall_id) === stall.cause_id
    : !!stall.system_finished_run_id &&
        p.system_finished_run_id === stall.system_finished_run_id;
}
/** The reason the latest automatic (system) attempt for this incident failed:
 * it finished without a successor, kept an unconfirmed stop for PM, or its
 * preserved checkout was refused at launch. Undefined while it may succeed. */
export function failedAutomaticAttempt(
  state: CommandState,
  matches: (e: { payload: unknown }) => boolean,
) {
  const attempt = eventsOfType(state.events, "host_ops_action_taken").findLast(
    (e) => e.actor.kind === "system" && matches(e),
  );
  if (!attempt) return;
  const about = (e: { payload: unknown }) =>
    (e.payload as { action_id?: string }).action_id === attempt.id;
  const refused = eventsOfType(state.events, "retained_writer_refused").find(
    about,
  );
  if (refused)
    return (refused.payload as { reason?: string }).reason ?? "writer_refused";
  const finished = eventsOfType(state.events, "host_ops_action_finished").find(
    about,
  );
  if (finished) {
    const p = finished.payload as { run_id?: string; reason?: string };
    return p.run_id ? undefined : (p.reason ?? "automatic_recovery_withdrawn");
  }
  const deferred = eventsOfType(state.events, "host_ops_action_deferred").find(
    (e) => about(e) && (e.payload as { notify_pm?: boolean }).notify_pm,
  );
  return deferred
    ? ((deferred.payload as { reason?: string }).reason ??
        "terminal_exit_unconfirmed")
    : undefined;
}
/** One Ops handoff per incident (to the host_ops patrol, else PM Office). */
function publishStallHandoff(
  tx: Parameters<Parameters<Store["uow"]["run"]>[0]>[0],
  store: Store,
  state: CommandState,
  a: Assignment,
  stall: DispatchStall,
  clock: Clock,
  payload: object,
  notify?: boolean,
) {
  const project = state.project_id;
  const ops = state.assignments.find(
    (o) =>
      o.scope === "standing" &&
      o.role_id === "host_ops" &&
      o.status === "active" &&
      !o.external &&
      o.id !== a.id,
  );
  const event = {
    ...(stall.card_id ? { card_id: stall.card_id } : {}),
    actor: { kind: "system" as const, project_id: project },
    created_at: clock.now(),
    payload: payload as Event["payload"],
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project, stall.card_id ?? undefined),
    type: "dispatch_stall_attention",
  };
  tx.events.append(project, event);
  // C-739: PM already has this turn's reason; keep the record, not a second ring.
  if (notify === false) return;
  const held = heldStallRecipient(state, stall);
  recordNotification(store.database, {
    project_id: project,
    event_id: event.id,
    card_id: stall.card_id ?? undefined,
    seq: event.seq,
    at: event.created_at,
    recipient:
      held ??
      // C-739: a system-ended turn goes to PM (who can run the managed
      // release), not to host operations.
      (systemTurnStall(stall)
        ? { kind: recoveryPm(a) }
        : ops
          ? { kind: "assignment", assignment_id: ops.id }
          : { kind: "pm_office" }),
    kind: held?.kind === "needs_you" ? "needs_you" : "run_attention",
  });
}
/** C-739: an incident of a system-ended turn (not a retirement transfer). */
function systemTurnStall(
  stall: Pick<DispatchStall, "system_finished_run_id" | "retirement_handoff">,
) {
  return !!stall.system_finished_run_id && !stall.retirement_handoff;
}
/**
 * C-732: host operations cannot end a human pause. A stall held only by one
 * goes to whoever can resume it (PM Ops under the `permission` delegation,
 * else the human), never to the host_ops patrol.
 */
function heldStallRecipient(
  state: CommandState,
  stall: Pick<DispatchStall, "restart_blocked" | "assignment_id">,
): { kind: "pm_ops" } | { kind: "needs_you" } | undefined {
  // A managed stop still releasing its terminal is transient, not a pause.
  return stall.restart_blocked === "human_stopped" &&
    heldPause(state.events, stall.assignment_id)
    ? { kind: heldPauseHandler(state) }
    : undefined;
}
/** C-732: who paused the Assignment and when, on a `human_stopped` stall. */
function heldStallDetails(state: CommandState, stall: DispatchStall) {
  const pause = heldPause(state.events, stall.assignment_id);
  if (stall.restart_blocked !== "human_stopped" || !pause) return {};
  const handler = heldPauseHandler(state);
  return {
    paused_by: pause.by,
    paused_at: pause.at,
    handled_by: handler,
    next_step: `${stall.assignment_id} 处于人工暂停（${pause.by} 于 ${pause.at} 暂停），主机运维不能解除。卡片未暂停且待办排队超过阈值时，系统会请${handler === "pm_ops" ? "项目经理" : "人"}在恢复拍板中一键恢复；也可用 cardigan assignment start ${stall.assignment_id} 恢复。`,
  };
}
export function recoveryBasis({
  session_maintenance: _maintenance,
  ...rest
}: Assignment) {
  return rest;
}
function registration({
  runtime_state: _state,
  last_mcp_activity_at: _activity,
  context_patrol_cursor: _cursor,
  ...rest
}: ReturnType<typeof recoveryBasis>) {
  return rest;
}
const retirementNextStep =
  "系统会复查原通知；请主机运维从派发停滞核对终端名字、归属及客户端状态，确认空闲后续办。不能确认时保留会话，不自动重启。";
/** C-739: what PM can do about a turn the system could not settle. */
function managedReleaseNextStep(id: Assignment["id"]) {
  return `系统没有自动释放 ${id} 的旧会话（原因见 reason），原通知和排队的 Run 保留。PM 核对后可执行受管释放：${managedReleaseCommand(id)}（不带 --hold；确认旧会话退出后，排队的工作在新会话中派发）。工作区有未提交改动时，先确认这些改动可以留在原工作区。`;
}
/** C-739: the managed release entry for a system-ended turn incident. */
function turnFollowUp(
  stall: Pick<
    DispatchStall,
    "assignment_id" | "system_finished_run_id" | "retirement_handoff"
  >,
) {
  return systemTurnStall(stall)
    ? {
        next_step: managedReleaseNextStep(stall.assignment_id),
        managed_release: {
          command: managedReleaseCommand(stall.assignment_id),
        },
      }
    : { next_step: retirementNextStep };
}

// Keep diagnostics and notifications compact, without using a display row as a recovery fence.
function oldestPerGroup(causes: DispatchStall[]) {
  const rows = new Map<string, DispatchStall>();
  for (const s of causes) {
    const key = `${s.assignment_id}/${s.kind}/${s.card_id ?? ""}`;
    if ((rows.get(key)?.age_ms ?? -1) < s.age_ms) rows.set(key, s);
  }
  return rows;
}

/** C-596 already replaced this PM's session after the bell expired: the old turn is moot. */
function standingRestarted(state: CommandState, stall: DispatchStall) {
  const due = eventById(state.events, stall.cause_id);
  return (
    !!due &&
    eventsOfType(state.events, STANDING_PM_STALL_EVENTS.restart).some(
      (e) =>
        e.actor.kind === "system" &&
        (e.payload as { assignment_id?: string }).assignment_id ===
          stall.assignment_id &&
        e.created_at >= due.created_at,
    )
  );
}

/**
 * C-626: how long the bound empty editor must keep standing in for a missing
 * hc activity report before the patrol stops a system-ended turn. Every patrol
 * pass (about 30 s) re-reads it; any other observation restarts the window.
 */
export const DEFAULT_TURN_IDLE_PROMPT_MS = 60_000;
export function turnIdlePromptMs() {
  const raw = process.env.CARDIGAN_TURN_IDLE_PROMPT_MS;
  if (raw === undefined) return DEFAULT_TURN_IDLE_PROMPT_MS;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value > 3_600_000)
    throw new Error("Invalid CARDIGAN_TURN_IDLE_PROMPT_MS");
  return value;
}

/**
 * C-669: the patrol's own automatic restart that was withdrawn before any
 * signal is retried, at most this many more times per incident and no sooner
 * than the interval after the last withdrawal, and only once its session is
 * kernel-proven gone. Invalid values fail host startup.
 */
export const DEFAULT_PATROL_RESTART_RETRIES = 3;
export const DEFAULT_PATROL_RESTART_RETRY_MS = 60_000;
export function patrolRestartRetryPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const read = (name: string, fallback: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value > max)
      throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    retries: read(
      "CARDIGAN_PATROL_RESTART_RETRIES",
      DEFAULT_PATROL_RESTART_RETRIES,
      100,
    ),
    interval_ms: read(
      "CARDIGAN_PATROL_RESTART_RETRY_MS",
      DEFAULT_PATROL_RESTART_RETRY_MS,
      3_600_000,
    ),
  };
}
type PatrolAttempts =
  /** A system attempt reached a signal, a deferred stop or another outcome. */
  | { readonly settled: true }
  | {
      readonly settled: false;
      readonly withdrawn: number;
      readonly last_at?: string;
      readonly reason?: string;
      /** C-680: the diagnosis that held the last withdrawn attempt. */
      readonly blocked_by?: WithdrawnRecoveryDiagnosis;
    };
/** C-669: this incident's system attempts, when every one of them was
 * withdrawn before touching the terminal (`withdrawn_stall_changed`). */
export function patrolAttempts(
  state: CommandState,
  assignment: Assignment["id"],
  cause: string,
): PatrolAttempts {
  const attempts = eventsOfType(state.events, "host_ops_action_taken").filter(
    (e) => {
      const p = e.payload as {
        assignment_id?: string;
        dispatch_stall_id?: string;
      };
      return (
        e.actor.kind === "system" &&
        p.assignment_id === assignment &&
        p.dispatch_stall_id === cause
      );
    },
  );
  let last: Event | undefined;
  for (const attempt of attempts) {
    const finished = eventsOfType(
      state.events,
      "host_ops_action_finished",
    ).find(
      (e) => (e.payload as { action_id?: string }).action_id === attempt.id,
    );
    if (
      (finished?.payload as { result?: string } | undefined)?.result !==
      "withdrawn_stall_changed"
    )
      return { settled: true };
    last = finished;
  }
  return {
    settled: false,
    withdrawn: attempts.length,
    ...(last
      ? {
          last_at: last.created_at,
          reason:
            (last.payload as { reason?: string }).reason ??
            "automatic_recovery_withdrawn",
          ...withdrawnBlockedBy(last),
        }
      : {}),
  };
}
function withdrawnBlockedBy(e: Event) {
  const blocked = (
    e.payload as unknown as { blocked_by?: WithdrawnRecoveryDiagnosis }
  ).blocked_by;
  return blocked ? { blocked_by: blocked } : {};
}
const withdrawnNextStep = (
  reason: string,
  exhausted: boolean,
  blocked?: WithdrawnRecoveryDiagnosis,
  nudges?: { attempts: number; limit: number },
) =>
  `自动换会话已撤回（${reason}${
    blocked?.evidence.length ? `：${blocked.evidence.join(", ")}` : ""
  }），旧会话未被停止。${
    nudges
      ? `已在原会话续排 Run ${nudges.attempts}/${nudges.limit} 次${
          nudges.attempts >= nudges.limit ? "，次数已用完" : ""
        }；`
      : ""
  }${
    exhausted
      ? "自动重试次数已用完；"
      : "系统每轮巡检复查：会话仍在时先在原会话续排 Run，终端和进程都确认已退出后自动续起；"
  }旧会话仍在或无法确认时保持不动，请主机运维从派发停滞核对终端归属和进程，确认已退出或空闲后用 host_ops_restart_assignment 续办。`;

/** C-672/C-690: only the maintenance and retirement fences yield to a proven
 * exited Agent; the guarded release re-checks stops, host operations and Runs. */
const EXITED_AGENT_FENCES = new Set([
  "session_maintenance",
  "retirement_handoff_changed",
  "retirement_exit_unconfirmed",
]);
export function exitedAgentRow(
  stall: Pick<DispatchStall, "restart_blocked">,
  view: { readonly agent_exited: boolean },
) {
  return (
    view.agent_exited && EXITED_AGENT_FENCES.has(stall.restart_blocked ?? "")
  );
}

/** Called by the existing host service's tick. Reads never publish or start a recovery. */
export class StallPatrol {
  private readonly standingPm: StandingPmRecovery;
  /** First consecutive bound-idle-prompt observation per incident (in memory:
   * a restarted host simply observes the full window again). */
  private readonly idlePromptSince = new Map<string, number>();
  private readonly idlePromptMs = turnIdlePromptMs();
  private readonly retry = patrolRestartRetryPolicy();
  private readonly heldBacklogMs = heldBacklogMs();
  /** C-739: stalled sessions are released after work waited this long. */
  private readonly releaseMs = stalledSessionReleaseMs();
  /** C-759: idle `done` sessions are released after a queued Run waited this long. */
  private readonly doneMs = doneSessionReleaseMs();
  /** C-739: next observation of a kept incident (in memory). */
  private readonly releaseRetryAt = new Map<string, number>();
  constructor(
    private store: Store,
    private clock: Clock,
    private runtime: Runtime,
    private execution: (
      project: ProjectId,
      machine: Assignment["machine_id"],
    ) => ExecutionConfig | undefined,
    private signal: AbortSignal,
    owns?: (ref: RuntimeRef) => boolean,
    private scrubCredentials?: (
      project: ProjectId,
      assignment: Assignment["id"],
      ref: RuntimeRef | null,
    ) => Promise<void>,
  ) {
    this.standingPm = new StandingPmRecovery(
      store,
      clock,
      runtime,
      signal,
      undefined,
      owns,
    );
  }
  private causes(state: CommandState) {
    const handoffs = dispatchHandoffs(state);
    const live = this.store.listNotifications({
      project_id: state.project_id,
      statuses: ["pending", "belled", "delivery_failed"],
    });
    const escalated = this.store.listNotifications({
      project_id: state.project_id,
      status: "needs_attention",
      ids: [...handoffs.keys()],
    });
    return dispatchStallCauses(
      state,
      [...live, ...escalated],
      handoffs,
      this.clock.now(),
      standingResolver(this.store),
    );
  }
  private survey(state: CommandState) {
    const all = this.causes(state);
    const turns = all.filter(turnKey);
    // Don't let a generic backlog row mask the exact expired bell or issue
    // a second recovery for a related resume instruction.
    const owners = new Set(turns.map((s) => s.assignment_id));
    const causes = all.filter(
      (s) => turnKey(s) || !owners.has(s.assignment_id),
    );
    // An automatic attempt withdrawn before any signal leaves the incident to
    // Ops: once evidence recovers they may resume the original queue from it.
    const withdrawn = new Set(
      eventsOfType(state.events, "host_ops_action_finished")
        .filter(
          (e) =>
            (e.payload as { result?: string }).result ===
            "withdrawn_stall_changed",
        )
        .map((e) => (e.payload as { action_id?: string }).action_id),
    );
    // So does one whose successor launch refused the preserved checkout.
    for (const e of eventsOfType(state.events, "retained_writer_refused"))
      withdrawn.add((e.payload as { action_id?: string }).action_id);
    const consumed = new Set(
      eventsOfType(state.events, "host_ops_action_taken")
        .filter((e) => e.actor.kind !== "system" || !withdrawn.has(e.id))
        .map(
          (e) =>
            (e.payload as { dispatch_stall_id?: string }).dispatch_stall_id,
        ),
    );
    const actionable = oldestPerGroup(
      causes.filter((s) => !s.restart_blocked && !consumed.has(s.cause_id)),
    );
    // Groups with no actionable cause still report their oldest outstanding wait.
    const rows = oldestPerGroup(causes);
    for (const [key, s] of actionable) rows.set(key, s);
    return {
      rows: [...rows.values()],
      turns,
      actionable: new Set(actionable.values()),
    };
  }
  current(state: CommandState, id: Assignment["id"], cause: string) {
    if (
      unfinishedBellAttempts(this.store.database, state.project_id, id).length
    )
      return;
    // An in-flight action must recheck its exact cause, even after it is marked consumed.
    const causes = this.causes(state).filter((s) => s.assignment_id === id);
    const hasTurn = causes.some(turnKey);
    return causes.find(
      (s) =>
        (!hasTurn || turnKey(s)) && s.cause_id === cause && !s.restart_blocked,
    );
  }
  /** C-669: nothing of this session is left: never provisioned, or its
   * terminal is gone and the kernel shows no process of its launch. */
  private async sessionGone(state: CommandState, a: Assignment) {
    if (!a.runtime_ref) return !a.session_ref;
    return (
      (await sessionExitProof(
        state,
        a,
        this.runtime,
        this.execution(state.project_id, a.machine_id),
      )) === "exited"
    );
  }
  async evidence(state: CommandState, a: Assignment, stall?: DispatchStall) {
    return stallEvidence(
      state,
      a,
      this.runtime,
      this.execution(state.project_id, a.machine_id),
      this.signal,
      stall?.system_finished_run_id,
      stall?.retirement_handoff,
      observedLocalExitCause(eventById(state.events, stall?.cause_id)),
    );
  }
  async diagnostics(project: ProjectId) {
    const state = this.store.uow.read((tx) => loadCommandState(tx, project));
    const { rows, actionable } = this.survey(state);
    const result = [];
    const evidence = new Map<
      string,
      Awaited<ReturnType<StallPatrol["evidence"]>>
    >();
    for (const s of rows) {
      const a = state.assignments.find((a) => a.id === s.assignment_id);
      if (!a) continue;
      const view = evidence.get(a.id) ?? (await this.evidence(state, a, s));
      evidence.set(a.id, view);
      const prior = turnKey(s)
        ? undefined
        : patrolAttempts(state, a.id, s.cause_id);
      const nudges = patrolNudges(state, a.id, s.cause_id);
      const light = nudges.length
        ? {
            attempts: nudges.length,
            limit: this.retry.retries,
            last_at: nudges.at(-1)?.created_at,
          }
        : undefined;
      result.push({
        ...s,
        ...(prior && !prior.settled && prior.withdrawn
          ? {
              withdrawn_reason: prior.reason,
              ...(prior.blocked_by
                ? { withdrawn_blocked_by: prior.blocked_by }
                : {}),
              ...(light ? { light_recovery: light } : {}),
              next_step: withdrawnNextStep(
                prior.reason ?? "automatic_recovery_withdrawn",
                prior.withdrawn > this.retry.retries,
                prior.blocked_by,
                light,
              ),
            }
          : {}),
        ...(s.system_finished_run_id &&
        eventsOfType(state.events, "bell_turn_recovery_failed").some(
          (e) =>
            (e.payload as { system_finished_run_id?: string })
              .system_finished_run_id === s.system_finished_run_id,
        )
          ? turnFollowUp(s)
          : {}),
        ...view,
        // C-672: an exited Agent in a live terminal is not held by the
        // session maintenance fence: the managed restart settles it.
        ...(exitedAgentRow(s, view) ? { restart_blocked: null } : {}),
        can_restart:
          (actionable.has(s) || exitedAgentRow(s, view)) &&
          view.can_restart &&
          !hostOpsPending(state.events, a.id) &&
          !unfinishedBellAttempts(this.store.database, project, a.id).length,
      });
    }
    return result;
  }
  private publish(project: ProjectId) {
    return this.store.uow.run((tx) => {
      const state = loadCommandState(tx, project);
      const { rows, actionable, turns } = this.survey(state);
      const patrol = state.assignments.find(
        (a) =>
          a.scope === "standing" &&
          a.role_id === "host_ops" &&
          a.status === "active" &&
          !a.external,
      );
      const key = (
        s: Pick<DispatchStall, "assignment_id" | "kind" | "cause_id">,
      ) => JSON.stringify([s.assignment_id, s.kind, s.cause_id]);
      const sent = new Set(
        eventsOfType(state.events, "dispatch_stall_attention").map((e) =>
          key(e.payload as unknown as DispatchStall),
        ),
      );
      for (const original of overdueStallHandoffs(
        state.events,
        rows,
        this.clock.now(),
      )) {
        const row = original.payload as unknown as DispatchStall;
        const event = {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project, row.card_id ?? undefined),
          ...(row.card_id ? { card_id: row.card_id } : {}),
          actor: { kind: "system" as const, project_id: project },
          type: "dispatch_stall_handoff_overdue",
          created_at: this.clock.now(),
          payload: {
            assignment_id: row.assignment_id,
            cause_id: row.cause_id,
            handoff_id: original.id,
            body: `${row.assignment_id} 的派发停滞移交已满 15 分钟，未记录接续操作。请 PM Office 核对运维承接。`,
          },
        };
        tx.events.append(project, event);
        recordNotification(this.store.database, {
          project_id: project,
          event_id: event.id,
          card_id: row.card_id ?? undefined,
          seq: event.seq,
          at: event.created_at,
          kind: "run_attention",
          recipient: { kind: "pm_office" },
        });
      }
      for (const stall of rows) {
        if (turnKey(stall) || sent.has(key(stall))) continue;
        const held = heldStallRecipient(state, stall);
        const event = {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project),
          actor: { kind: "system" as const, project_id: project },
          type: "dispatch_stall_attention",
          created_at: this.clock.now(),
          payload: { ...stall, ...heldStallDetails(state, stall) },
        };
        tx.events.append(project, event);
        // Reuse the handoff's (event, recipient) key; the dispatcher already rang operations.
        const notice =
          (stall.handoff_event_id
            ? eventById(state.events, stall.handoff_event_id)
            : undefined) ?? event;
        recordNotification(this.store.database, {
          project_id: project,
          event_id: notice.id,
          card_id: "card_id" in notice ? notice.card_id : undefined,
          seq: notice.seq,
          kind: held?.kind === "needs_you" ? "needs_you" : "run_attention",
          at: event.created_at,
          recipient:
            held ??
            (patrol && patrol.id !== stall.assignment_id
              ? { kind: "assignment", assignment_id: patrol.id }
              : { kind: "pm_office" }),
        });
      }
      return { state, actionable, patrol, turns };
    });
  }
  private async recoverTurn(
    state: CommandState,
    stall: DispatchStall,
    snapshot: (
      a: Assignment,
      p: ProjectId,
    ) => Promise<NonNullable<HostOpsExecution["snapshot"]>>,
    mayRefresh = true,
  ): Promise<void> {
    const project = state.project_id;
    const a = state.assignments.find((a) => a.id === stall.assignment_id);
    // A failed observation did not acquire the stop fence. Remember the
    // alert separately so fresh evidence can still recover the original bell.
    const recorded = (s: CommandState, type: string) =>
      eventsOfType(s.events, type).some((e) => {
        const p = e.payload as {
          system_finished_run_id?: string;
          cause_id?: string;
          dispatch_stall_id?: string;
        };
        return stall.retirement_handoff
          ? (p.cause_id ?? p.dispatch_stall_id) === stall.cause_id
          : !!stall.system_finished_run_id &&
              p.system_finished_run_id === stall.system_finished_run_id;
      });
    const handled = (s: CommandState) =>
      recorded(s, "host_ops_action_taken") ||
      standingRestarted(s, stall) ||
      // C-739: the patrol already released this turn's session.
      systemTurnReleased(s, stall.system_finished_run_id);
    // A failed automatic attempt is neither a recovery nor Ops pickup. Hand the
    // incident off once, without starting a second stop for the same turn.
    if (a && recorded(state, "host_ops_action_taken")) {
      const failure = failedAutomaticAttempt(state, (e) =>
        incidentMatches(stall, e.payload),
      );
      if (failure && !recorded(state, "dispatch_stall_attention"))
        this.store.uow.run((tx) => {
          const fresh = loadCommandState(tx, project);
          if (
            recorded(fresh, "dispatch_stall_attention") ||
            !failedAutomaticAttempt(fresh, (e) =>
              incidentMatches(stall, e.payload),
            )
          )
            return;
          const row = this.causes(fresh).find(
            (s) => s.cause_id === stall.cause_id && s.assignment_id === a.id,
          );
          if (!row) return; // Original notification already delivered.
          publishStallHandoff(tx, this.store, fresh, a, stall, this.clock, {
            ...row,
            ...heldStallDetails(fresh, row),
            can_restart: false,
            reason: failure,
            ...turnFollowUp(row),
          });
        });
      return;
    }
    const incident = `${project}/${stall.assignment_id}/${turnKey(stall)}`;
    if (!a || handled(state) || hostOpsPending(state.events, a.id)) {
      if (!a || handled(state)) this.idlePromptSince.delete(incident);
      return;
    }
    const view = await this.evidence(state, a, stall);
    // C-672: the session's CLI is gone while its terminal stays live. Close
    // that terminal and settle the session (guarded like maintenance); the
    // dispatcher then starts a new session for the original notification.
    if (
      view.agent_exited &&
      (!stall.restart_blocked || exitedAgentRow(stall, view))
    ) {
      await releaseExitedAgent(
        this.store,
        project,
        a,
        this.runtime,
        this.clock,
      );
      return;
    }
    // The bound empty editor must persist across the window; until then
    // keep the session and the original queue untouched, without an alert.
    if (
      !stall.restart_blocked &&
      view.can_restart &&
      view.idle_basis === "bound_idle_prompt"
    ) {
      const now = Date.parse(this.clock.now());
      const since = this.idlePromptSince.get(incident) ?? now;
      this.idlePromptSince.set(incident, since);
      if (now - since < this.idlePromptMs) return;
    } else this.idlePromptSince.delete(incident);
    let reason =
      stall.restart_blocked ?? (!view.can_restart ? "unsafe_evidence" : null);
    let launch: HostOpsExecution["snapshot"];
    if (!reason) {
      try {
        launch = await snapshot(a, project);
      } catch {
        reason = "launch_snapshot_unavailable";
      }
    }
    if (this.signal.aborted) return;
    const retry = this.store.uow.run((tx) => {
      const fresh = loadCommandState(tx, project);
      if (handled(fresh) || hostOpsPending(fresh.events, a.id)) return;
      const row = this.causes(fresh).find(
        (s) =>
          s.cause_id === stall.cause_id &&
          s.assignment_id === a.id &&
          s.review_trigger_id === stall.review_trigger_id,
      );
      if (!row) return; // Original notification already delivered or acknowledged.
      reason = row.restart_blocked ?? reason;
      if (unfinishedBellAttempts(this.store.database, project, a.id).length)
        reason = "bell_in_flight";
      const current = fresh.assignments.find((v) => v.id === a.id);
      const prior = recoveryBasis(a);
      const next = current && recoveryBasis(current);
      if (!isDeepStrictEqual(prior, next)) {
        if (
          mayRefresh &&
          !reason &&
          next &&
          isDeepStrictEqual(registration(prior), registration(next))
        )
          return { state: fresh, stall: row };
        reason ??= "assignment_changed";
      }
      if (!reason && launch) {
        const effect = beginSystemTurnRestart(
          fresh,
          { kind: "system", project_id: project },
          {
            assignment_id: a.id,
            cause_id: stall.cause_id,
            snapshot: launch,
            ...(row.review_trigger_id
              ? { review_trigger_id: row.review_trigger_id }
              : {}),
          },
          { clock: this.clock, ids: tx.ids },
        );
        if (effect.ok) {
          persistEffect(tx, project, effect.value);
          return;
        }
        reason = effect.error.message;
      }
      const incident = {
        ...(stall.card_id ? { card_id: stall.card_id } : {}),
        actor: { kind: "system" as const, project_id: project },
        created_at: this.clock.now(),
        payload: {
          ...row,
          ...view,
          can_restart: false,
          reason,
          ...turnFollowUp(row),
          ...heldStallDetails(fresh, row),
        },
      };
      const publish = (
        type: string,
        recipient:
          | Parameters<typeof recordNotification>[1]["recipient"]
          | undefined,
      ) => {
        const event = {
          ...incident,
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project, stall.card_id ?? undefined),
          type,
        };
        tx.events.append(project, event);
        if (recipient)
          recordNotification(this.store.database, {
            project_id: project,
            event_id: event.id,
            card_id: stall.card_id ?? undefined,
            seq: event.seq,
            at: event.created_at,
            recipient,
            kind: "run_attention",
          });
      };
      // C-739: PM was already told why the patrol kept this turn.
      const told = sessionReleaseHandedOff(
        fresh,
        a.id,
        stall.system_finished_run_id,
      );
      if (!recorded(fresh, "bell_turn_recovery_failed"))
        publish(
          "bell_turn_recovery_failed",
          told ? undefined : { kind: recoveryPm(a) },
        );
      // Adopt older failures too. All overdue notices for this owner's turn
      // share a handoff; the still-pending originals keep their retry path.
      if (!recorded(fresh, "dispatch_stall_attention"))
        publishStallHandoff(
          tx,
          this.store,
          fresh,
          a,
          stall,
          this.clock,
          incident.payload,
          !told,
        );
    });
    if (retry && !this.signal.aborted)
      await this.recoverTurn(retry.state, retry.stall, snapshot, false);
  }
  private async nudge(
    project: ProjectId,
    state: CommandState,
    patrol: Assignment,
    stall: DispatchStall,
    snapshot: (
      a: Assignment,
      p: ProjectId,
    ) => Promise<NonNullable<HostOpsExecution["snapshot"]>>,
  ) {
    const done = patrolNudges(state, patrol.id, stall.cause_id);
    const last = done.at(-1)?.created_at;
    if (
      !patrol.runtime_ref ||
      done.length >= this.retry.retries ||
      (last &&
        Date.parse(this.clock.now()) - Date.parse(last) <
          this.retry.interval_ms) ||
      runsOf(state.runs, patrol.id).some(
        (r) => !["completed", "failed", "cancelled"].includes(r.status),
      )
    )
      return;
    // Only a session positively seen live gets the Run: a terminal that is
    // no longer listed would make dispatch start a second session while its
    // processes may still run.
    const seen = await this.runtime
      .status(patrol.runtime_ref)
      .catch(() => undefined);
    if (
      !seen?.ok ||
      seen.value.process !== "alive" ||
      seen.value.kept ||
      this.signal.aborted
    )
      return;
    const launch = await snapshot(patrol, project);
    if (this.signal.aborted) return;
    this.store.uow.run((tx) => {
      const fresh = loadCommandState(tx, project);
      if (
        JSON.stringify(fresh.assignments.find((a) => a.id === patrol.id)) !==
          JSON.stringify(patrol) ||
        !this.current(fresh, patrol.id, stall.cause_id) ||
        patrolNudges(fresh, patrol.id, stall.cause_id).length !== done.length
      )
        return;
      const effect = nudgeStalledPatrol(
        fresh,
        { kind: "system", project_id: project },
        {
          assignment_id: patrol.id,
          cause_id: stall.cause_id,
          snapshot: launch,
          attempt: done.length + 1,
        },
        { clock: this.clock, ids: tx.ids },
      );
      if (effect.ok) persistEffect(tx, project, effect.value);
    });
  }
  /**
   * C-732: a human pause with work waiting past the threshold, on an open and
   * unheld card, gets one resume question per pause for whoever may answer.
   */
  private askHeldResume(project: ProjectId) {
    const state = this.store.uow.read((tx) => loadCommandState(tx, project));
    const notes = this.store.listNotifications({
      project_id: project,
      statuses: ["pending", "belled", "delivery_failed"],
    });
    for (const ask of heldBacklogs(
      state,
      notes,
      this.clock.now(),
      this.heldBacklogMs,
    ))
      this.store.uow.run((tx) => {
        const fresh = loadCommandState(tx, project);
        const effect = requestHeldAssignmentResume(
          fresh,
          { kind: "system", project_id: project },
          ask,
          { clock: this.clock, ids: tx.ids },
        );
        if (effect.ok && effect.value.data)
          persistEffect(tx, project, effect.value);
      });
  }
  /** C-739: live notifications, as the dispatcher sees them. */
  private liveNotes(project: ProjectId) {
    return this.store.listNotifications({
      project_id: project,
      statuses: ["pending", "belled", "delivery_failed", "needs_attention"],
    });
  }
  /**
   * C-739: a live session the dispatcher cannot use while work waits past
   * the threshold (an unconfirmed system-ended turn, or idle retirement that
   * keeps withdrawing): release it (a managed stop, no hold) when the
   * checkout is clean, so the dispatcher starts the waiting work in a new
   * session; otherwise tell PM once, with the reason and the managed release
   * entry.
   */
  private stalledDue(project: ProjectId) {
    if (!this.releaseMs && !this.doneMs) return [];
    const state = this.store.uow.read((tx) => loadCommandState(tx, project));
    const stalled = stalledSessions(
      state,
      this.liveNotes(project),
      this.clock.now(),
      this.releaseMs,
      this.doneMs,
    );
    const key = (s: StalledSession) =>
      `${project}/${s.assignment.id}/${s.trigger}/${s.incident}`;
    const open = new Set(stalled.map(key));
    for (const k of this.releaseRetryAt.keys())
      if (k.startsWith(`${project}/`) && !open.has(k))
        this.releaseRetryAt.delete(k);
    const now = Date.parse(this.clock.now());
    return stalled
      .filter((s) => (this.releaseRetryAt.get(key(s)) ?? 0) <= now)
      .map((s) => ({ state, stalled: s, key: key(s) }));
  }
  private async releaseStalled(due: ReturnType<StallPatrol["stalledDue"]>) {
    for (const { state, stalled, key } of due) {
      if (this.signal.aborted) return;
      const outcome = await this.releaseOne(state, stalled);
      // A kept incident is rechecked after two thresholds; one left to
      // another path (or transiently locked) after a minute, not every pass.
      const ms = stalled.trigger === "turn_done" ? this.doneMs : this.releaseMs;
      if (outcome !== "released")
        this.releaseRetryAt.set(
          key,
          Date.parse(this.clock.now()) +
            (outcome === "kept" ? 2 * ms : Math.min(60_000, ms)),
        );
    }
  }
  private async releaseOne(
    state: CommandState,
    stalled: StalledSession,
  ): Promise<"released" | "kept" | "skipped"> {
    const project = state.project_id;
    const a = stalled.assignment;
    const ref = a.runtime_ref;
    const turn = stalled.turn?.id;
    if (
      !ref ||
      hostOpsPending(state.events, a.id) ||
      stoppedByHuman(state.events, a.id) ||
      (turn &&
        eventsOfType(state.events, "host_ops_action_taken").some(
          (e) =>
            (e.payload as { system_finished_run_id?: string })
              .system_finished_run_id === turn,
        )) ||
      unfinishedBellAttempts(this.store.database, project, a.id).length
    )
      return "skipped";
    const execution = this.execution(project, a.machine_id);
    // The ordinary turn recovery is preferred while its evidence allows it.
    const view = turn
      ? await stallEvidence(
          state,
          a,
          this.runtime,
          execution,
          this.signal,
          turn,
        )
      : undefined;
    const status = await this.runtime.status(ref).catch(() => undefined);
    const owner = await observeTurnOwner(
      this.runtime,
      ref,
      turn
        ? systemTurnOwner(state, a.id, ref, turn)
        : { project_id: project, assignment_id: a.id },
      !!turn,
    );
    const workspace = await stallWorkspace(
      state,
      a,
      execution,
      this.signal,
      undefined,
      false,
      true,
    );
    if (this.signal.aborted) return "skipped";
    const observedOwner = owner?.ok ? owner.value : "unobserved";
    const decision = stalledSessionDecision({
      trigger: stalled.trigger,
      can_restart: view?.can_restart === true,
      status: status?.ok ? status.value : undefined,
      owner: observedOwner,
      workspace,
    });
    const facts = {
      workspace,
      terminal_state: status?.ok ? status.value.agent : null,
      process_state: status?.ok ? status.value.process : null,
      terminal_owner: observedOwner,
    };
    if (decision.action === "skip") return "skipped";
    if (decision.action === "hand_off") {
      this.handOff(project, stalled, decision.reason, facts);
      return "kept";
    }
    const result = await releaseStalledSession(
      this.store,
      project,
      stalled,
      this.runtime,
      this.clock,
      {
        execution,
        signal: this.signal,
        stillWaiting: (fresh, current) =>
          stalledSessions(
            fresh,
            this.liveNotes(project),
            this.clock.now(),
            this.releaseMs,
            this.doneMs,
          ).some(
            (s) =>
              s.assignment.id === current.id &&
              s.trigger === stalled.trigger &&
              s.incident === stalled.incident,
          ),
        scrubCredentials: this.scrubCredentials,
      },
    );
    if (result.outcome === "settled") return "released";
    if (TRANSIENT_RELEASE_REFUSALS.has(result.reason)) return "skipped";
    this.handOff(project, stalled, result.reason, facts);
    return "kept";
  }
  /** C-739: once per incident, to PM (not host operations). */
  private handOff(
    project: ProjectId,
    stalled: StalledSession,
    reason: string,
    facts: Record<string, string | null>,
  ) {
    const a = stalled.assignment;
    this.store.uow.run((tx) => {
      const fresh = loadCommandState(tx, project);
      if (sessionReleaseHandedOff(fresh, a.id, stalled.incident)) return;
      const minutes = Math.round(stalled.waited_ms / 60_000);
      const what = stalled.turn
        ? `系统代为结束 ${stalled.turn.id} 后 ${minutes} 分钟，${a.id}（${a.machine_id}）的旧回合仍确认不了是否结束`
        : stalled.trigger === "turn_done"
          ? `${a.id}（${a.machine_id}）上一轮已结束、会话空闲，排队的 ${stalled.queued_run_id} ${minutes} 分钟仍未开始`
          : `${a.id}（${a.machine_id}）有待办 ${minutes} 分钟仍派不出新 Run，空闲回收已 ${stalled.withdrawals} 次被撤回`;
      const event = {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, stalled.card_id ?? undefined),
        ...(stalled.card_id ? { card_id: stalled.card_id } : {}),
        actor: { kind: "system" as const, project_id: project },
        type: SESSION_RELEASE_HELD,
        created_at: this.clock.now(),
        payload: {
          assignment_id: a.id,
          machine_id: a.machine_id,
          trigger: stalled.trigger,
          incident: stalled.incident,
          ...(stalled.turn
            ? { system_finished_run_id: stalled.turn.id }
            : stalled.trigger === "turn_done"
              ? {}
              : { withdrawals: stalled.withdrawals ?? 0 }),
          ...(stalled.queued_run_id
            ? { queued_run_id: stalled.queued_run_id }
            : {}),
          notification_ids: [...stalled.notification_ids],
          waited_ms: stalled.waited_ms,
          reason,
          ...facts,
          managed_release: { command: managedReleaseCommand(a.id) },
          body: `${what}，系统没有自动释放：${reason}。`,
          next_step: managedReleaseNextStep(a.id),
        },
      };
      tx.events.append(project, event);
      recordNotification(this.store.database, {
        project_id: project,
        event_id: event.id,
        card_id: stalled.card_id ?? undefined,
        seq: event.seq,
        at: event.created_at,
        kind: "run_attention",
        recipient: { kind: recoveryPm(a) },
      });
    });
  }
  async tick(
    project: ProjectId,
    snapshot: (
      a: Assignment,
      p: ProjectId,
    ) => Promise<NonNullable<HostOpsExecution["snapshot"]>>,
  ) {
    this.askHeldResume(project);
    // Synchronous unless a session is due: no extra await on an idle pass.
    const due = this.stalledDue(project);
    if (due.length && !this.signal.aborted) await this.releaseStalled(due);
    const { state, actionable, patrol, turns } = this.publish(project);
    const open = new Set(
      turns.map((s) => `${project}/${s.assignment_id}/${turnKey(s)}`),
    );
    for (const key of this.idlePromptSince.keys())
      if (key.startsWith(`${project}/`) && !open.has(key))
        this.idlePromptSince.delete(key);
    const seen = new Set<string>();
    for (const stall of turns.sort(
      (a, b) => Number(!!a.restart_blocked) - Number(!!b.restart_blocked),
    )) {
      const key = turnKey(stall);
      if (!key || seen.has(key) || this.signal.aborted) continue;
      seen.add(key);
      await this.recoverTurn(state, stall, snapshot);
    }
    if (!this.signal.aborted) await this.standingPm.tick(project, snapshot);
    if (!patrol || hostOpsPending(state.events, patrol.id)) return;
    // An attempt by anyone else (Ops, a human) is never repeated here. C-669:
    // a system attempt withdrawn before any signal is retried, bounded, once
    // the old session is proven gone; while it may still live it stays put.
    const foreign = new Set(
      eventsOfType(state.events, "host_ops_action_taken")
        .filter((e) => e.actor.kind !== "system")
        .map(
          (e) =>
            (e.payload as { dispatch_stall_id?: string }).dispatch_stall_id,
        ),
    );
    const now = Date.parse(this.clock.now());
    const candidates = [...actionable]
      .filter(
        (s) =>
          s.assignment_id === patrol.id &&
          s.kind === "standing_backlog" &&
          !s.system_finished_run_id &&
          !foreign.has(s.cause_id),
      )
      .map((s) => ({ s, prior: patrolAttempts(state, patrol.id, s.cause_id) }))
      .filter(
        (c): c is typeof c & { prior: { settled: false } } =>
          !c.prior.settled &&
          (!c.prior.withdrawn ||
            (c.prior.withdrawn <= this.retry.retries &&
              now - Date.parse(c.prior.last_at ?? "") >=
                this.retry.interval_ms)),
      )
      // A fresh incident first: a retry needs stronger evidence.
      .sort((x, y) => x.prior.withdrawn - y.prior.withdrawn);
    const next = candidates[0];
    if (!next) return;
    const own = next.s;
    if (next.prior.withdrawn && !stoppedByHuman(state.events, patrol.id)) {
      const gone = await this.sessionGone(state, patrol);
      if (this.signal.aborted) return;
      // C-680: a withdrawn restart whose session is still there is resumed
      // the lightest way, as a human `assignment start` would: queue a Run
      // for the original session, bounded per incident; nothing is stopped.
      if (!gone) {
        await this.nudge(project, state, patrol, own, snapshot);
        return;
      }
    } else if (
      next.prior.withdrawn ||
      !(await this.evidence(state, patrol)).can_restart
    )
      return;
    if (this.signal.aborted) return;
    const launch = await snapshot(patrol, project);
    if (this.signal.aborted) return;
    this.store.uow.run((tx) => {
      const fresh = loadCommandState(tx, project);
      if (
        JSON.stringify(fresh.assignments.find((a) => a.id === patrol.id)) !==
          JSON.stringify(patrol) ||
        !this.current(fresh, patrol.id, own.cause_id)
      )
        return;
      const effect = beginStalledPatrolRestart(
        fresh,
        { kind: "system", project_id: project },
        { assignment_id: patrol.id, cause_id: own.cause_id, snapshot: launch },
        { clock: this.clock, ids: tx.ids },
      );
      if (effect.ok) persistEffect(tx, project, effect.value);
    });
  }
}
