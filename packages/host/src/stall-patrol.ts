import { isDeepStrictEqual } from "node:util";
import {
  type Assignment,
  beginStalledPatrolRestart,
  beginSystemTurnRestart,
  type Clock,
  type CommandState,
  eventById,
  eventsOfType,
  type HostOpsExecution,
  hostOpsPending,
  observedLocalExitCause,
  type ProjectId,
  type Runtime,
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
import { stallEvidence } from "./stall-evidence.js";
import { overdueStallHandoffs } from "./stall-handoff.js";

function turnKey(s: DispatchStall) {
  return s.retirement_handoff ? s.cause_id : s.system_finished_run_id;
}
// Maintenance observations are a projection (not the retirement/upgrade fence).
// Exclude only that projection from the CAS. A new runtime or activity sample
// invalidates the observation; retry it only for the very same registration.
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
const turnNextStep =
  "系统会复查原通知；请主机运维从派发停滞核对终端名字、归属及客户端状态，确认空闲后续办。不能确认时保留会话，不自动重启。";

// Keep diagnostics and notifications compact, without using a display row as a recovery fence.
function oldestPerGroup(causes: DispatchStall[]) {
  const rows = new Map<string, DispatchStall>();
  for (const s of causes) {
    const key = `${s.assignment_id}/${s.kind}/${s.card_id ?? ""}`;
    if ((rows.get(key)?.age_ms ?? -1) < s.age_ms) rows.set(key, s);
  }
  return rows;
}

/** Called by the existing host service's tick. Reads never publish or start a recovery. */
export class StallPatrol {
  constructor(
    private store: Store,
    private clock: Clock,
    private runtime: Runtime,
    private execution: (
      project: ProjectId,
      machine: Assignment["machine_id"],
    ) => ExecutionConfig | undefined,
    private signal: AbortSignal,
  ) {}
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
    const consumed = new Set(
      eventsOfType(state.events, "host_ops_action_taken").map(
        (e) => (e.payload as { dispatch_stall_id?: string }).dispatch_stall_id,
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
      result.push({
        ...s,
        ...(s.system_finished_run_id &&
        eventsOfType(state.events, "bell_turn_recovery_failed").some(
          (e) =>
            (e.payload as { system_finished_run_id?: string })
              .system_finished_run_id === s.system_finished_run_id,
        )
          ? { next_step: turnNextStep }
          : {}),
        ...view,
        can_restart:
          actionable.has(s) &&
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
        const event = {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project),
          actor: { kind: "system" as const, project_id: project },
          type: "dispatch_stall_attention",
          created_at: this.clock.now(),
          payload: { ...stall },
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
          kind: "run_attention",
          at: event.created_at,
          recipient:
            patrol && patrol.id !== stall.assignment_id
              ? { kind: "assignment", assignment_id: patrol.id }
              : { kind: "pm_office" },
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
    const handled = (s: CommandState) => recorded(s, "host_ops_action_taken");
    if (!a || handled(state) || hostOpsPending(state.events, a.id)) return;
    const view = await this.evidence(state, a, stall);
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
          next_step: turnNextStep,
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
      if (!recorded(fresh, "bell_turn_recovery_failed"))
        publish("bell_turn_recovery_failed", { kind: recoveryPm(a) });
      // Adopt older failures too. All overdue notices for this owner's turn
      // share a handoff; the still-pending originals keep their retry path.
      if (!recorded(fresh, "dispatch_stall_attention")) {
        const ops = fresh.assignments.find(
          (o) =>
            o.scope === "standing" &&
            o.role_id === "host_ops" &&
            o.status === "active" &&
            !o.external &&
            o.id !== a.id,
        );
        publish(
          "dispatch_stall_attention",
          ops
            ? { kind: "assignment", assignment_id: ops.id }
            : { kind: "pm_office" },
        );
      }
    });
    if (retry && !this.signal.aborted)
      await this.recoverTurn(retry.state, retry.stall, snapshot, false);
  }
  async tick(
    project: ProjectId,
    snapshot: (
      a: Assignment,
      p: ProjectId,
    ) => Promise<NonNullable<HostOpsExecution["snapshot"]>>,
  ) {
    const { state, actionable, patrol, turns } = this.publish(project);
    const seen = new Set<string>();
    for (const stall of turns.sort(
      (a, b) => Number(!!a.restart_blocked) - Number(!!b.restart_blocked),
    )) {
      const key = turnKey(stall);
      if (!key || seen.has(key) || this.signal.aborted) continue;
      seen.add(key);
      await this.recoverTurn(state, stall, snapshot);
    }
    if (!patrol || hostOpsPending(state.events, patrol.id)) return;
    const own = [...actionable].find(
      (s) =>
        s.assignment_id === patrol.id &&
        s.kind === "standing_backlog" &&
        !s.system_finished_run_id,
    );
    if (!own) return;
    if (
      !(await this.evidence(state, patrol)).can_restart ||
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
