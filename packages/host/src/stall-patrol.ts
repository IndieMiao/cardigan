import {
  type Assignment,
  beginStalledPatrolRestart,
  type Clock,
  type CommandState,
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
import { type DispatchStall, dispatchStalls } from "./dispatch-stalls.js";
import { stallEvidence } from "./stall-evidence.js";

/** Called by the existing host service's tick. Reads never publish or start a recovery. */
export class StallPatrol {
  constructor(
    private store: Store,
    private clock: Clock,
    private runtime: Runtime,
    private execution: () => ExecutionConfig | undefined,
    private signal: AbortSignal,
  ) {}
  rows(state: CommandState) {
    return dispatchStalls(
      state,
      this.store.listNotifications({
        project_id: state.project_id,
        statuses: ["pending", "belled", "delivery_failed"],
      }),
      this.clock.now(),
      standingResolver(this.store),
    );
  }
  current(state: CommandState, id: Assignment["id"], cause: string) {
    if (
      unfinishedBellAttempts(this.store.database, state.project_id, id).length
    )
      return;
    return this.rows(state).find(
      (s) =>
        s.assignment_id === id && s.cause_id === cause && !s.restart_blocked,
    );
  }
  async evidence(state: CommandState, a: Assignment) {
    return stallEvidence(state, a, this.runtime, this.execution(), this.signal);
  }
  async diagnostics(project: ProjectId) {
    const state = this.store.uow.read((tx) => loadCommandState(tx, project));
    const stalls = this.rows(state);
    const result = [];
    const consumed = new Set(
      eventsOfType(state.events, "host_ops_action_taken").map(
        (e) => (e.payload as { dispatch_stall_id?: string }).dispatch_stall_id,
      ),
    );
    const evidence = new Map<
      string,
      Awaited<ReturnType<StallPatrol["evidence"]>>
    >();
    for (const s of stalls) {
      const a = state.assignments.find((a) => a.id === s.assignment_id);
      if (!a) continue;
      const view = evidence.get(a.id) ?? (await this.evidence(state, a));
      evidence.set(a.id, view);
      result.push({
        ...s,
        ...view,
        can_restart:
          !s.restart_blocked &&
          !consumed.has(s.cause_id) &&
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
      const rows = this.rows(state);
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
        recordNotification(this.store.database, {
          project_id: project,
          event_id: event.id,
          seq: event.seq,
          kind: "run_attention",
          at: event.created_at,
          recipient:
            patrol && patrol.id !== stall.assignment_id
              ? { kind: "assignment", assignment_id: patrol.id }
              : { kind: "pm_office" },
        });
      }
      return { state, rows, patrol };
    });
  }
  async tick(
    project: ProjectId,
    snapshot: (
      a: Assignment,
      p: ProjectId,
    ) => Promise<NonNullable<HostOpsExecution["snapshot"]>>,
  ) {
    const { state, rows, patrol } = this.publish(project);
    if (!patrol || hostOpsPending(state.events, patrol.id)) return;
    const consumed = new Set(
      eventsOfType(state.events, "host_ops_action_taken").map(
        (e) => (e.payload as { dispatch_stall_id?: string }).dispatch_stall_id,
      ),
    );
    const own = rows.find(
      (s) =>
        s.assignment_id === patrol.id &&
        s.kind === "standing_backlog" &&
        !s.restart_blocked &&
        !consumed.has(s.cause_id),
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
