import {
  type Assignment,
  beginStalledPatrolRestart,
  type Clock,
  type CommandState,
  eventById,
  eventsOfType,
  type HostOpsExecution,
  hostOpsPending,
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
import {
  type DispatchStall,
  dispatchHandoffs,
  dispatchStallCauses,
} from "./dispatch-stalls.js";
import { stallEvidence } from "./stall-evidence.js";

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
    private execution: () => ExecutionConfig | undefined,
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
    const causes = this.causes(state);
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
      actionable: new Set(actionable.values()),
    };
  }
  current(state: CommandState, id: Assignment["id"], cause: string) {
    if (
      unfinishedBellAttempts(this.store.database, state.project_id, id).length
    )
      return;
    // An in-flight action must recheck its exact cause, even after it is marked consumed.
    return this.causes(state).find(
      (s) =>
        s.assignment_id === id && s.cause_id === cause && !s.restart_blocked,
    );
  }
  async evidence(state: CommandState, a: Assignment) {
    return stallEvidence(state, a, this.runtime, this.execution(), this.signal);
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
      const view = evidence.get(a.id) ?? (await this.evidence(state, a));
      evidence.set(a.id, view);
      result.push({
        ...s,
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
      const { rows, actionable } = this.survey(state);
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
      for (const stall of rows) {
        if (sent.has(key(stall))) continue;
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
      return { state, actionable, patrol };
    });
  }
  async tick(
    project: ProjectId,
    snapshot: (
      a: Assignment,
      p: ProjectId,
    ) => Promise<NonNullable<HostOpsExecution["snapshot"]>>,
  ) {
    const { state, actionable, patrol } = this.publish(project);
    if (!patrol || hostOpsPending(state.events, patrol.id)) return;
    const own = [...actionable].find(
      (s) => s.assignment_id === patrol.id && s.kind === "standing_backlog",
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
