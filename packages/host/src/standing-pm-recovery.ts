import {
  type Assignment,
  beginStandingPmStallRestart,
  type Clock,
  type CommandState,
  DEFAULT_STANDING_PM_STALL_POLICY,
  deliverStandingPmStallHandoff,
  type Event,
  escalateStandingPmStall,
  type HostOpsExecution,
  type Notification,
  type NotificationRecipient,
  type ProjectId,
  planStandingPmStall,
  type Runtime,
  type RuntimeRef,
  recordStandingPmStallRedelivery,
  runById,
  type StandingPmStallContext,
  type StandingPmStallPlan,
  type StandingPmStallPolicy,
  waitingStandingPmStallHandoffs,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import {
  moveNotification,
  recordNotification,
  type Store,
  standingResolver,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { recoveryPm } from "./automatic-context-restart.js";
import { dispatchHandoffs } from "./dispatch-stalls.js";

const ENV = {
  threshold_ms: "CARDIGAN_STANDING_PM_STALL_MS",
  grace_ms: "CARDIGAN_STANDING_PM_STALL_GRACE_MS",
  window_ms: "CARDIGAN_STANDING_PM_STALL_WINDOW_MS",
  max_restarts: "CARDIGAN_STANDING_PM_STALL_MAX_RESTARTS",
} as const;

/** C-596 host policy. Unset variables keep the defaults; invalid values fail startup. */
export function standingPmStallPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StandingPmStallPolicy {
  const policy = { ...DEFAULT_STANDING_PM_STALL_POLICY };
  for (const [key, name] of Object.entries(ENV) as [
    keyof StandingPmStallPolicy,
    string,
  ][]) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Invalid ${name}`);
    policy[key] = value;
  }
  return policy;
}

const system = (project: ProjectId) =>
  ({ kind: "system", project_id: project }) as const;

/**
 * Recovers a managed standing PM that has undelivered notices but no new Run.
 * Every stage is re-planned inside its own write transaction; the restart is
 * the existing host_ops standing-PM action, so the old terminal must be proved
 * exited before a successor Run is queued (one executor, nothing reassigned).
 */
export class StandingPmRecovery {
  constructor(
    private store: Store,
    private clock: Clock,
    private runtime: Runtime,
    private signal: AbortSignal,
    private policy: StandingPmStallPolicy = standingPmStallPolicy(),
    /** False only when this host cannot stop the bound terminal (C-152). */
    private owns: (ref: RuntimeRef) => boolean = () => true,
  ) {}
  /**
   * First actual failure to begin the due restart of an episode. Only a real
   * attempt records one; the planner escalates once it is a grace old.
   */
  private readonly failures = new Map<
    string,
    { episode_id: string; since: string; reason: string }
  >();
  /** Assignment numbers are per project; one patrol walks every project. */
  private key(project: ProjectId, a: Assignment) {
    return JSON.stringify([project, a.id]);
  }

  private context(project: ProjectId, a: Assignment): StandingPmStallContext {
    const failed = this.failures.get(this.key(project, a));
    return {
      ...(a.runtime_ref && !this.owns(a.runtime_ref)
        ? { foreign_runtime: true }
        : {}),
      ...(failed
        ? {
            restart_failed: {
              episode_id: failed.episode_id,
              since: failed.since,
            },
          }
        : {}),
    };
  }

  private failed(
    project: ProjectId,
    a: Assignment,
    plan: StandingPmStallPlan,
    reason: string,
  ) {
    const prior = this.failures.get(this.key(project, a));
    const episode_id = plan.episode_id ?? "";
    this.failures.set(this.key(project, a), {
      episode_id,
      since: prior?.episode_id === episode_id ? prior.since : this.clock.now(),
      reason,
    });
  }

  /** The PM's own undelivered rows, resolved like the dispatcher's inbox. */
  notes(state: CommandState, a: Assignment): Notification[] {
    const handoffs = dispatchHandoffs(state);
    const resolve = standingResolver(this.store);
    const kinds = new Map<string, string | undefined>();
    const logical = (kind: "pm_ops" | "pm_office") => {
      if (!kinds.has(kind))
        kinds.set(kind, resolve(state.project_id, kind, state));
      return kinds.get(kind);
    };
    const rows = [
      ...this.store.listNotifications({
        project_id: state.project_id,
        statuses: ["pending", "delivery_failed"],
      }),
      ...this.store
        .listNotifications({
          project_id: state.project_id,
          status: "needs_attention",
          ids: [...handoffs.keys()],
        })
        .filter((n) => handoffs.get(n.id)?.owner === a.id),
    ];
    return rows.filter((n) => {
      const r = n.recipient;
      if (r.kind === "needs_you") return false;
      const sent = n.run_id ? runById(state.runs, n.run_id) : undefined;
      const owner =
        r.kind === "assignment"
          ? r.assignment_id
          : sent
            ? sent.assignment_id
            : logical(r.kind);
      return owner === a.id;
    });
  }

  private candidates(state: CommandState) {
    return state.assignments.filter(
      (a) =>
        a.scope === "standing" &&
        a.role_id === "pm" &&
        a.status === "active" &&
        !a.external,
    );
  }

  plans(state: CommandState) {
    const now = this.clock.now();
    return this.candidates(state).flatMap((a) => {
      const plan = planStandingPmStall(
        state,
        a,
        this.notes(state, a),
        now,
        this.policy,
        this.context(state.project_id, a),
      );
      return plan ? [{ assignment: a, plan }] : [];
    });
  }

  private async observe(a: Assignment) {
    if (!a.runtime_ref) return "no_session";
    const seen = await this.runtime
      .status(a.runtime_ref)
      .catch(() => undefined);
    return seen?.ok
      ? `${seen.value.process}/${seen.value.agent}`
      : (seen?.error.code ?? "unavailable");
  }

  async tick(
    project: ProjectId,
    snapshot: (
      a: Assignment,
      p: ProjectId,
    ) => Promise<NonNullable<HostOpsExecution["snapshot"]>>,
  ) {
    const state = this.store.uow.read((tx) => loadCommandState(tx, project));
    this.handoffWaiting(project, state);
    for (const { assignment: a, plan } of this.plans(state)) {
      if (this.signal.aborted) return;
      if (unfinishedBellAttempts(this.store.database, project, a.id).length)
        continue;
      let observation = await this.observe(a);
      let launch: HostOpsExecution["snapshot"];
      if (plan.stage === "restart") {
        try {
          launch = await snapshot(a, project);
        } catch {
          // Retried on the next patrol; the planner escalates once the
          // first actual failure is a full grace old.
          this.failed(project, a, plan, "launch_snapshot_unavailable");
          continue;
        }
      }
      const failure = this.failures.get(this.key(project, a));
      if (plan.stage === "escalate" && failure)
        observation = `${observation}; ${failure.reason}`;
      if (this.signal.aborted) return;
      this.apply(project, a, plan, observation, launch);
    }
  }

  private hostOps(state: CommandState, a: Assignment) {
    return state.assignments.find(
      (o) =>
        o.scope === "standing" &&
        o.role_id === "host_ops" &&
        o.status === "active" &&
        !o.external &&
        o.id !== a.id,
    );
  }

  private notify(
    project: ProjectId,
    event: Event,
    recipient: NotificationRecipient,
    kind = "run_attention",
  ) {
    recordNotification(this.store.database, {
      project_id: project,
      event_id: event.id,
      ...(event.card_id ? { card_id: event.card_id } : {}),
      seq: event.seq,
      kind,
      at: event.created_at,
      recipient,
    });
  }

  /** An escalation recorded without host operations is delivered once one is on duty. */
  private handoffWaiting(project: ProjectId, initial: CommandState) {
    if (!waitingStandingPmStallHandoffs(initial).length) return;
    this.store.uow.run((tx) => {
      const state = loadCommandState(tx, project);
      for (const escalation of waitingStandingPmStallHandoffs(state)) {
        const pm = state.assignments.find(
          (v) =>
            v.id ===
            (escalation.payload as { assignment_id?: string }).assignment_id,
        );
        const ops = pm && this.hostOps(state, pm);
        if (!ops) continue;
        const effect = deliverStandingPmStallHandoff(
          state,
          system(project),
          { escalation_id: escalation.id, host_ops_id: ops.id },
          { clock: this.clock, ids: tx.ids },
        );
        if (!effect.ok) continue;
        persistEffect(tx, project, effect.value);
        // Bound to the new handoff (it references the escalation): reading
        // the earlier waiting notice does not acknowledge this assignment.
        this.notify(project, effect.value.data, {
          kind: "assignment",
          assignment_id: ops.id,
        });
      }
    });
  }

  private apply(
    project: ProjectId,
    a: Assignment,
    plan: StandingPmStallPlan,
    observation: string,
    launch: HostOpsExecution["snapshot"],
  ) {
    this.store.uow.run((tx) => {
      const fresh = loadCommandState(tx, project);
      const owner = fresh.assignments.find((v) => v.id === a.id);
      // Maintenance timestamps may move; the session and status may not.
      const same = (v: Assignment) =>
        JSON.stringify([
          v.status,
          v.role_version,
          v.session_ref,
          v.runtime_ref,
        ]);
      if (
        !owner ||
        same(owner) !== same(a) ||
        unfinishedBellAttempts(this.store.database, project, a.id).length
      )
        return;
      const params = {
        assignment_id: a.id,
        notes: this.notes(fresh, owner),
        policy: this.policy,
        observation,
        context: this.context(project, owner),
      };
      const ports = { clock: this.clock, ids: tx.ids };
      if (plan.stage === "redeliver") {
        const effect = recordStandingPmStallRedelivery(
          fresh,
          system(project),
          params,
          ports,
        );
        if (!effect.ok) return;
        persistEffect(tx, project, effect.value);
        // A deliverable reminder through the normal dispatcher and guards. It
        // points at the PM's unread streams; original events and ACK cursors
        // stay as they are, and handed-off rows keep their handoff.
        this.notify(
          project,
          effect.value.data.event,
          { kind: "assignment", assignment_id: a.id },
          "assignment",
        );
        // Failed rows also go back to pending, due now.
        const ids = new Set(effect.value.data.plan.notification_ids);
        for (const n of params.notes)
          if (ids.has(n.id) && n.status === "delivery_failed")
            moveNotification(
              this.store.database,
              {
                project_id: project,
                id: n.id,
                event: "retry",
                patch: { next_attempt_at: this.clock.now() },
                at: this.clock.now(),
              },
              this.clock.now,
            );
        return;
      }
      if (plan.stage === "restart") {
        if (!launch) return;
        const effect = beginStandingPmStallRestart(
          fresh,
          system(project),
          { ...params, snapshot: launch },
          ports,
        );
        if (effect.ok) {
          persistEffect(tx, project, effect.value);
          this.failures.delete(this.key(project, a));
        } else if (effect.error.code !== "stale_target")
          // The intent itself was refused: an actual failure to begin.
          this.failed(
            project,
            owner,
            plan,
            `restart_refused:${effect.error.code}`,
          );
        return;
      }
      const ops = this.hostOps(fresh, owner);
      const effect = escalateStandingPmStall(
        fresh,
        system(project),
        { ...params, ...(ops ? { host_ops_id: ops.id } : {}) },
        ports,
      );
      if (!effect.ok) return;
      persistEffect(tx, project, effect.value);
      this.failures.delete(this.key(project, a));
      const event = effect.value.data.event;
      // Host operations own the follow-up. Without one the escalation stays
      // waiting (delivered when one comes on duty); an existing other PM
      // context is informed. The human only sees the Needs You notice.
      if (ops)
        this.notify(project, event, {
          kind: "assignment",
          assignment_id: ops.id,
        });
      else {
        const other = recoveryPm(owner);
        if (standingResolver(this.store)(project, other, fresh))
          this.notify(project, event, { kind: other });
      }
    });
  }
}
