import {
  type Assignment,
  type Clock,
  type Event,
  type HostOpsExecution,
  type IdleRetirementResult,
  idleWakeGuard,
  type NotificationRecipient,
  type ProjectId,
  type Runtime,
  type RuntimeObservation,
  type RuntimeRef,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { recordNotification, type Store } from "@cardigan/store";
import { recoveryPm } from "./automatic-context-restart.js";
import { idleRetirementPolicy } from "./idle-session-retirement.js";

/**
 * C-625: evidence trail for the old session of a standing PM restart. One
 * event per step; the host appends it, never an Agent.
 */
export const STANDING_EXIT_STEP = "standing_session_exit_step";
export type StandingExitStep =
  | "busy"
  | "exit_command"
  | "terminate"
  | "terminal_kill"
  | "exited"
  | "overdue";
export interface StandingExitPolicy {
  /** Wait after a sent exit command before the system signals the PID. */
  readonly grace_ms: number;
  /** Pending this long: a confirmed idle session no longer waits for the
   * upstream diagnosis, and an unsettled restart reminds host operations. */
  readonly overdue_ms: number;
  /** In-drain observation budget after an exit command. */
  readonly settle_ms: number;
}

function duration(name: string, fallback: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/u.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new Error(`Invalid ${name}`);
  return value;
}
export function standingExitPolicy(): StandingExitPolicy {
  return {
    grace_ms: duration("CARDIGAN_STANDING_EXIT_GRACE_MS", 60_000, 3_600_000),
    overdue_ms: duration(
      "CARDIGAN_STANDING_EXIT_OVERDUE_MS",
      300_000,
      86_400_000,
    ),
    settle_ms: duration("CARDIGAN_STANDING_EXIT_SETTLE_MS", 5_000, 30_000),
  };
}

type StepRecord = {
  readonly step: StandingExitStep;
  readonly at: string;
  readonly payload: Record<string, unknown>;
};
export function standingExitSteps(
  events: readonly Event[],
  action_id: string,
): StepRecord[] {
  return events
    .filter(
      (e) =>
        e.type === STANDING_EXIT_STEP &&
        e.actor.kind === "system" &&
        (e.payload as { action_id?: string }).action_id === action_id,
    )
    .map((e) => ({
      step: (e.payload as { step: StandingExitStep }).step,
      at: e.created_at,
      payload: e.payload as Record<string, unknown>,
    }));
}

/** Typed only into a CLI known to treat it as a local command, never as a
 * prompt: an unknown harness would start a model turn instead. */
export function exitCommand(harness: string | undefined) {
  return harness === "claude-code" || harness === "codex" ? "/exit" : undefined;
}
/** Busy means a turn is running or waiting on someone: never signalled. */
const busy = (o: Observed) =>
  o.process === "alive" && (o.agent === "working" || o.agent === "blocked");
/** Only an explicit idle or done report from the terminal counts as idle. */
const idle = (o: Observed) =>
  o.process === "alive" && (o.agent === "idle" || o.agent === "done");
type Observed = {
  readonly process: RuntimeObservation["process"] | "missing";
  readonly agent: RuntimeObservation["agent"];
  readonly observed_seq?: number;
};
const gone = (o: Observed) => o.process === "exited" || o.process === "missing";

export type StandingExitOutcome =
  /** Exit observed; continue to the existing settlement. */
  | "exited"
  /** Nothing proven yet; the action stays pending for the next drain. */
  | "waiting"
  /** The terminal reports neither busy nor idle: keep the original path. */
  | "legacy";

export interface StandingExitInput {
  readonly store: Store;
  readonly project: ProjectId;
  readonly clock: Clock;
  readonly runtime: Runtime;
  readonly action: HostOpsExecution & { readonly runtime_ref: RuntimeRef };
  /** Harness of the old session; only known CLIs receive an exit command. */
  readonly harness: string | undefined;
  readonly policy: StandingExitPolicy;
  /** Fresh authority; `overdue` lets a confirmed idle session pass the
   * upstream diagnosis. Must stay synchronous (used inside signal slots). */
  readonly mayStop: (overdue: boolean) => boolean;
  /** Record why the action is still pending (deduplicated by the caller). */
  readonly defer: (reason: string) => void;
  readonly delay?: (ms: number) => Promise<void>;
}

/**
 * C-625: make an idle standing PM session leave on its own before anything is
 * signalled. Order: confirmed idle -> exit command -> (grace) one owner-bound
 * HUP/TERM through the idle-retirement helper -> observe only. A busy turn is
 * never signalled. Every step is recorded with its evidence.
 */
export async function exitStandingSession(
  input: StandingExitInput,
): Promise<StandingExitOutcome> {
  const { store, project, clock, runtime, action, policy } = input;
  const ref = action.runtime_ref;
  const read = () => store.uow.read((tx) => loadCommandState(tx, project));
  const taken = read().events.find((e) => e.id === action.action_id);
  const now = () => Date.parse(clock.now());
  const overdue = () =>
    !!taken && now() - Date.parse(taken.created_at) >= policy.overdue_ms;
  const steps = standingExitSteps(read().events, action.action_id);
  const record = (step: StandingExitStep, details: Record<string, unknown>) => {
    const event = appendStep(store, project, clock, action, step, details);
    if (event)
      steps.push({
        step,
        at: event.created_at,
        payload: event.payload as Record<string, unknown>,
      });
  };
  const observe = async (): Promise<Observed> => {
    const r = await runtime.status(ref).catch(() => undefined);
    if (r?.ok) return r.value;
    return r?.error.code === "runtime_not_found"
      ? { process: "missing", agent: "unknown" }
      : { process: "unknown", agent: "unknown" };
  };
  const last = (step: StandingExitStep) =>
    steps.findLast((s) => s.step === step);
  const method = () =>
    last("terminal_kill")
      ? "terminal_kill"
      : last("terminate")
        ? "terminate"
        : last("exit_command")
          ? "exit_command"
          : "observed";
  const finished = (o: Observed) => {
    // A settlement that fails later re-observes; the exit is recorded once.
    if (!last("exited"))
      record("exited", { method: method(), process: o.process });
    return "exited" as const;
  };
  const settle = async (budget: number) => {
    const delay = input.delay ?? sleep;
    const until = Date.now() + budget;
    for (;;) {
      const o = await observe();
      if (gone(o)) return o;
      if (Date.now() >= until) return;
      await delay(Math.min(250, Math.max(0, until - Date.now())));
    }
  };

  const seen = await observe();
  if (gone(seen)) return finished(seen);
  if (busy(seen)) {
    // A running or blocked turn is never interrupted. Record it once.
    if (!last("busy"))
      record("busy", {
        agent_state: seen.agent,
        observed_seq: seen.observed_seq,
      });
    input.defer("old_session_busy");
    return "waiting";
  }
  const requested = steps.findLast(
    (s) => s.step === "exit_command" && s.payload.sent === true,
  );
  const command = exitCommand(input.harness);
  if (!requested && command) {
    if (!idle(seen)) return "legacy";
    if (!input.mayStop(overdue())) return "waiting";
    const guard = idleWakeGuard({
      process: "alive",
      agent: seen.agent,
      observed_seq: seen.observed_seq ?? 0,
    });
    let authorized = false;
    const sent = await runtime
      .wake(ref, command, {
        ...guard,
        before_send: () => (authorized = input.mayStop(overdue())),
      })
      .catch(() => undefined);
    const delivered = sent?.ok === true && sent.value.sent;
    if (!delivered && !authorized) {
      // The guard refused before any IO: nothing was typed into the session.
      return "waiting";
    }
    record("exit_command", {
      command,
      sent: delivered,
      idle_basis: `terminal_status_${seen.agent}`,
      observed_seq: seen.observed_seq,
      ...(sent && !sent.ok ? { runtime_code: sent.error.code } : {}),
    });
    if (!delivered) {
      input.defer("standing_exit_command_unconfirmed");
      return "waiting";
    }
    const exited = await settle(policy.settle_ms);
    if (exited) return finished(exited);
    input.defer("standing_exit_requested");
    return "waiting";
  }
  // Without a known exit command the signal is the first step, and only
  // from a confirmed idle state. Otherwise give the command its grace period.
  if (!requested && !idle(seen)) return "legacy";
  if (requested && now() - Date.parse(requested.at) < policy.grace_ms) {
    input.defer("standing_exit_requested");
    return "waiting";
  }
  // One signal attempt per action. After it only observation remains;
  // never a second signal and never SIGKILL.
  if (
    steps.some(
      (s) =>
        s.step === "terminal_kill" ||
        (s.step === "terminate" && s.payload.outcome !== "withdrawn"),
    )
  ) {
    input.defer("standing_exit_unconfirmed");
    return "waiting";
  }
  if (!input.mayStop(overdue())) return "waiting";
  const { hangup_ms, terminate_ms } = idleRetirementPolicy();
  const retired: IdleRetirementResult | undefined = runtime.retire_idle
    ? await runtime
        .retire_idle(ref, {
          project_id: project,
          assignment_id: action.assignment_id,
          hangup_ms,
          terminate_ms,
          report_signals: true,
          before_signal: () => input.mayStop(overdue()),
        })
        .then((r) =>
          r.ok
            ? r.value
            : ({
                outcome: "uncertain",
                evidence: { stage: "target", reason: "hc_failed" },
              } as const),
        )
        .catch(() => undefined)
    : {
        outcome: "withdrawn",
        evidence: { stage: "target", reason: "unsupported" },
      };
  if (!retired) {
    record("terminate", { outcome: "uncertain", reason: "hc_failed" });
    input.defer("standing_exit_unconfirmed");
    return "waiting";
  }
  if (retired.outcome === "exited") {
    record("terminate", {
      outcome: "exited",
      ...(retired.signalled
        ? {
            pid: retired.signalled.pid,
            signals: retired.signalled.signals,
            ...(retired.signalled.exit_code !== undefined
              ? { exit_code: retired.signalled.exit_code }
              : {}),
            ...(retired.signalled.exit_reason
              ? { exit_reason: retired.signalled.exit_reason }
              : {}),
          }
        : {}),
    });
    const o = await observe();
    return gone(o) ? finished(o) : "waiting";
  }
  const { stage, reason, exit_code } = retired.evidence;
  if (
    retired.outcome === "withdrawn" &&
    (reason === "kept_terminal" || reason === "unsupported")
  ) {
    // A kept terminal replaces a signalled program with a shell, so the
    // helper cannot prove exit there. Use the terminal's own kill once.
    if (!input.mayStop(overdue())) return "waiting";
    const before = await observe();
    if (gone(before)) return finished(before);
    if (busy(before)) {
      input.defer("old_session_busy");
      return "waiting";
    }
    record("terminal_kill", { reason });
    await runtime.release(ref, { force: true }).catch(() => undefined);
    const o = await observe();
    if (gone(o)) return finished(o);
    input.defer("standing_exit_unconfirmed");
    return "waiting";
  }
  // A withdrawn attempt sent nothing and may be retried; record each
  // distinct refusal once so a recurring one does not flood the stream.
  const previous = last("terminate");
  if (
    retired.outcome !== "withdrawn" ||
    previous?.payload.outcome !== "withdrawn" ||
    previous.payload.reason !== reason
  )
    record("terminate", {
      outcome: retired.outcome,
      stage,
      reason,
      ...(exit_code !== undefined ? { exit_code } : {}),
    });
  const o = await observe();
  if (gone(o)) return finished(o);
  input.defer(
    retired.outcome === "withdrawn"
      ? `standing_exit_withdrawn:${reason}`
      : "standing_exit_unconfirmed",
  );
  return "waiting";
}

/**
 * One reminder per action once it has waited past the threshold without
 * settling. Host operations first; without one, the other PM.
 */
export function remindStandingExitOverdue(
  store: Store,
  project: ProjectId,
  clock: Clock,
  action: HostOpsExecution,
  policy: StandingExitPolicy,
  reason: string,
) {
  const state = store.uow.read((tx) => loadCommandState(tx, project));
  const taken = state.events.find((e) => e.id === action.action_id);
  if (
    !taken ||
    Date.parse(clock.now()) - Date.parse(taken.created_at) <
      policy.overdue_ms ||
    standingExitSteps(state.events, action.action_id).some(
      (s) => s.step === "overdue",
    )
  )
    return;
  const target = state.assignments.find((a) => a.id === action.assignment_id);
  const ops = state.assignments.find(
    (a) =>
      a.scope === "standing" &&
      a.role_id === "host_ops" &&
      a.status === "active" &&
      !a.external &&
      a.id !== action.assignment_id,
  );
  const minutes = Math.round(
    (Date.parse(clock.now()) - Date.parse(taken.created_at)) / 60_000,
  );
  const event = appendStep(store, project, clock, action, "overdue", {
    reason,
    waited_ms: Date.parse(clock.now()) - Date.parse(taken.created_at),
    ...(ops ? { host_ops_assignment_id: ops.id } : {}),
    body: `常驻 PM ${action.assignment_id} 换会话已等待约 ${minutes} 分钟，旧会话尚未确认退出（${reason}）。系统不会强停正在执行的轮次，请主机运维核对。`,
  });
  if (!event) return;
  const recipient: NotificationRecipient = ops
    ? { kind: "assignment", assignment_id: ops.id }
    : { kind: recoveryPm(target as Assignment | undefined) };
  recordNotification(store.database, {
    project_id: project,
    event_id: event.id,
    seq: event.seq,
    kind: "run_attention",
    at: event.created_at,
    recipient,
  });
}

function appendStep(
  store: Store,
  project: ProjectId,
  clock: Clock,
  action: HostOpsExecution,
  step: StandingExitStep,
  details: Record<string, unknown>,
) {
  return store.uow.run((tx) => {
    const state = loadCommandState(tx, project);
    // Only a still-pending action gathers evidence.
    if (
      !state.events.some((e) => e.id === action.action_id) ||
      state.events.some(
        (e) =>
          (e.type === "host_ops_action_finished" ||
            e.type === "context_session_restart_result") &&
          (e.payload as { action_id?: string }).action_id === action.action_id,
      )
    )
      return undefined;
    const event: Event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: STANDING_EXIT_STEP,
      actor: { kind: "system", project_id: project },
      payload: {
        action_id: action.action_id,
        assignment_id: action.assignment_id,
        terminal_ref: action.runtime_ref?.terminal_ref ?? null,
        step,
        ...details,
      },
      created_at: clock.now(),
    };
    tx.events.append(project, event);
    return event;
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
