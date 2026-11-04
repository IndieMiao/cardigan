import { randomUUID } from "node:crypto";
import type {
  Assignment,
  Clock,
  CommandState,
  Event,
  Notification,
  ProjectId,
  Run,
  Runtime,
} from "@cardigan/domain";
import { dispatchRun, queueRun } from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  mergeNotifications,
  type NotificationKind,
  summarizeNotifications,
} from "@cardigan/router";
import {
  type BellAttempt,
  beginBellAttempt,
  finishBellAttempt,
  moveNotification,
  recordNotification,
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
} from "@cardigan/store";
import {
  acknowledgeInbox,
  dispatcherClock,
  notificationOwner,
  routeProjectEvents,
  type StandingResolver,
} from "./dispatch-inbox.js";

export interface DispatcherOptions {
  readonly store: Store;
  readonly runtime: Runtime;
  readonly clock?: Clock;
  readonly standing?: StandingResolver;
  readonly deliveryLeaseMs?: number;
  /** Snapshot for a NEW terminal; an existing session keeps its previous Run's snapshot. */
  readonly snapshot: (
    assignment: Assignment,
  ) => Promise<Pick<Run, "model" | "agent_cli_version">>;
  /** M3.5 host adapter: provision and dispatch THIS queued Run with bell as first prompt.
   * Never queue another Run. Own token/terminal compensation on startup failure. */
  readonly startRun: (input: {
    project: ProjectId;
    assignment: Assignment;
    run: Run;
    bell: string;
  }) => Promise<void>;
}
const unfinished = (r: Run) =>
  !["completed", "failed", "cancelled"].includes(r.status);
const sameRef = (a: Assignment, b: Assignment) =>
  JSON.stringify(a.runtime_ref) === JSON.stringify(b.runtime_ref);
const covered = (n: Notification, s: CommandState, owner: Assignment["id"]) =>
  n.card_id !== undefined &&
  s.cursors.some(
    (c) =>
      c.assignment_id === owner &&
      c.card_id === n.card_id &&
      c.acked_seq >= n.seq,
  );
interface Job {
  attempt: BellAttempt;
  run: Run;
  assignment: Assignment;
  bell: string;
}

export class Dispatcher {
  readonly clock: Clock;
  private serial: Promise<void> = Promise.resolve();
  private readonly leaseMs: number;
  constructor(readonly options: DispatcherOptions) {
    this.clock = options.clock ?? dispatcherClock;
    this.leaseMs = options.deliveryLeaseMs ?? 60_000;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0)
      throw new Error("Invalid delivery lease");
  }
  /** Calls on one instance serialize; cross-process attempts are guarded in SQLite. */
  tick(project?: ProjectId): Promise<void> {
    const next = this.serial.then(async () => {
      for (const id of project
        ? [project]
        : this.options.store.listProjects().map((p) => p.id))
        await this.project(id);
    });
    this.serial = next.catch(() => {});
    return next;
  }
  private state(project: ProjectId) {
    return this.options.store.uow.read((tx) => loadCommandState(tx, project));
  }
  private owner(n: Notification, state: CommandState) {
    return notificationOwner(n, state, this.options.standing);
  }
  private async project(project: ProjectId) {
    const { store, standing } = this.options;
    routeProjectEvents(store, project, { clock: this.clock });
    acknowledgeInbox(store, project, standing, this.clock);
    for (const attempt of unfinishedBellAttempts(store.database, project))
      if (attempt.lease_until <= this.clock.now())
        this.settle(attempt, false, "interrupted_delivery");
    const claimed = new Set(
      unfinishedBellAttempts(store.database, project).flatMap(
        (a) => a.notification_ids,
      ),
    );
    const state = this.state(project),
      groups = new Map<string, Notification[]>();
    for (const n of store.listNotifications({
      project_id: project,
      status: "pending",
    })) {
      if (claimed.has(n.id)) continue;
      const owner = this.owner(n, state);
      if (!owner) continue;
      const key = `${owner}/${n.card_id ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), n]);
    }
    for (const group of groups.values()) await this.deliver(project, group);
  }
  private queued(
    state: CommandState,
    a: Assignment,
    notes: readonly Notification[],
  ) {
    return state.runs.find(
      (r) =>
        r.assignment_id === a.id &&
        r.status === "queued" &&
        notes.some(
          (n) => n.run_id === r.id || n.event_id === r.trigger_event_id,
        ),
    );
  }
  private busy(
    state: CommandState,
    a: Assignment,
    notes: readonly Notification[],
  ) {
    const queued = this.queued(state, a, notes);
    return state.runs.some(
      (r) => r.assignment_id === a.id && unfinished(r) && r.id !== queued?.id,
    );
  }
  private async deliver(project: ProjectId, notes: readonly Notification[]) {
    const state = this.state(project),
      first = notes[0];
    if (!first) return;
    const id = this.owner(first, state),
      a = state.assignments.find((a) => a.id === id);
    if (!a) return;
    if (a.status === "released") {
      this.reject(project, notes, a, "assignment_released");
      return;
    }
    if (a.status !== "active" || this.busy(state, a, notes)) return;
    let live = false;
    if (a.runtime_ref) {
      const observed = await this.options.runtime.status(a.runtime_ref);
      if (observed.ok) {
        if (observed.value.process === "unknown") return;
        live = observed.value.process === "alive";
      } else if (observed.error.code !== "runtime_not_found") return;
    }
    const queued = this.queued(state, a, notes);
    const prior = state.runs
      .filter(
        (r) =>
          r.assignment_id === a.id &&
          r.started_at &&
          r.role_version === a.role_version,
      )
      .sort((x, y) => Number(y.id.slice(2)) - Number(x.id.slice(2)))[0];
    let snapshot: Pick<Run, "model" | "agent_cli_version">;
    try {
      if (queued) snapshot = queued;
      else if (live) {
        if (!prior) {
          this.reject(project, notes, a, "missing_session_snapshot");
          return;
        }
        snapshot = prior;
      } else snapshot = await this.options.snapshot(a);
    } catch {
      this.reject(project, notes, a, "snapshot_unavailable");
      return;
    }
    let job: Job | undefined;
    try {
      job = this.claim(project, notes, a, snapshot, live);
    } catch (error) {
      if (
        error &&
        !(error instanceof Error) &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
      ) {
        this.reject(project, notes, a, `dispatch_rejected:${error.code}`);
        return;
      }
      throw error;
    }
    if (!job) return;
    let sent = false,
      reason = "delivery_failed";
    try {
      if (live && job.assignment.runtime_ref) {
        const result = await this.options.runtime.wake(
          job.assignment.runtime_ref,
          job.bell,
        );
        sent = result.ok && result.value.sent;
        if (!result.ok) reason = `wake_failed:${result.error.code}`;
      } else {
        await this.options.startRun({
          project,
          assignment: job.assignment,
          run: job.run,
          bell: job.bell,
        });
        const actual = this.state(project).runs.find(
          (r) => r.id === job?.run.id,
        );
        sent =
          !!actual &&
          ["dispatched", "acked", "running", "completed"].includes(
            actual.status,
          );
        reason = "startup_did_not_dispatch";
      }
    } catch {
      reason = "delivery_call_failed";
    }
    this.settle(job.attempt, sent, reason, job.bell);
  }
  private claim(
    project: ProjectId,
    notes: readonly Notification[],
    expected: Assignment,
    snapshot: Pick<Run, "model" | "agent_cli_version">,
    live: boolean,
  ): Job | undefined {
    const { store } = this.options;
    return store.uow.run((tx) => {
      let state = loadCommandState(tx, project);
      const a = state.assignments.find((a) => a.id === expected.id);
      if (a?.status !== "active" || !sameRef(a, expected)) return;
      const all = store.listNotifications({ project_id: project }),
        requested = new Set(notes.map((n) => n.id));
      const ready = all.filter(
        (n) =>
          requested.has(n.id) &&
          n.status === "pending" &&
          this.owner(n, state) === a.id &&
          !covered(n, state, a.id),
      );
      if (!ready.length || this.busy(state, a, ready)) return;
      if (
        unfinishedBellAttempts(store.database, project).some(
          (r) =>
            r.assignment_id === a.id ||
            r.notification_ids.some((id) => requested.has(id)),
        )
      )
        return;
      const cause = ready.find((n) => !n.run_id) ?? ready[0];
      if (!cause) return;
      let run =
        this.queued(state, a, ready) ??
        state.runs.find(
          (r) =>
            r.assignment_id === a.id &&
            (r.id === cause.run_id || r.trigger_event_id === cause.event_id),
        );
      const at = this.clock.now(),
        ports = { clock: { now: () => at }, ids: tx.ids },
        actor = { kind: "system" as const, project_id: project };
      if (!run) {
        const event = state.events.find((e) => e.id === cause.event_id);
        const kind =
          event?.type === "review_submitted" && cause.kind === "review"
            ? "rework"
            : event?.type === "decision_resolved" && a.scope === "work_item"
              ? "decision_resumed"
              : "followup";
        const effect = unwrap(
          queueRun(
            state,
            actor,
            {
              assignment_id: a.id,
              trigger_event_id: cause.event_id,
              kind,
              model: snapshot.model,
              agent_cli_version: snapshot.agent_cli_version,
            },
            ports,
          ),
        );
        persistEffect(tx, project, effect);
        run = effect.data;
        state = loadCommandState(tx, project);
      }
      if (!live && run.status !== "queued")
        throw { code: "finished_run_needs_attention" };
      if (live && run.status === "queued")
        persistEffect(
          tx,
          project,
          unwrap(dispatchRun(state, actor, { run_id: run.id }, ports)),
        );
      const kinds = ready.map((n) => ({
        seq: n.seq,
        kind: n.kind as NotificationKind,
        summary: "",
      }));
      const bell = cause.card_id
        ? mergeNotifications({
            card_id: cause.card_id,
            assignment_id: a.id,
            notifications: kinds,
          })?.text
        : `[bell] project=${project} asg=${a.id} seq=${Math.min(...ready.map((n) => n.seq))}..${Math.max(...ready.map((n) => n.seq))} summary=${JSON.stringify(summarizeNotifications(kinds))}\n→ 请调用 get_updates 读取项目更新`;
      if (!bell) throw new Error("Missing bell");
      const attempt: BellAttempt = {
        id: randomUUID(),
        project_id: project,
        assignment_id: a.id,
        run_id: run.id,
        notification_ids: ready.map((n) => n.id),
        started_at: at,
        lease_until: new Date(Date.parse(at) + this.leaseMs).toISOString(),
        finished_at: null,
        outcome: null,
      };
      beginBellAttempt(store.database, attempt);
      return { attempt, run, assignment: a, bell };
    });
  }
  private settle(
    attempt: BellAttempt,
    sent: boolean,
    reason: string,
    bell?: string,
  ) {
    const { store } = this.options,
      project = attempt.project_id;
    store.uow.run((tx) => {
      const at = this.clock.now();
      if (
        !finishBellAttempt(
          store.database,
          project,
          attempt.id,
          sent ? "sent" : "failed",
          at,
        )
      )
        return;
      const state = loadCommandState(tx, project),
        ids = new Set(attempt.notification_ids);
      const notes = store
        .listNotifications({ project_id: project })
        .filter((n) => ids.has(n.id));
      let failed = false;
      for (const n of notes) {
        if (!["pending", "belled", "delivery_failed"].includes(n.status))
          continue;
        const acked = covered(n, state, attempt.assignment_id);
        if (!acked && !["pending", "belled"].includes(n.status)) continue;
        moveNotification(store.database, {
          project_id: project,
          id: n.id,
          event: acked ? "ack" : sent ? "bell" : "deliver_failed",
          at,
          patch: {
            run_id: attempt.run_id,
            attempts: n.attempts + 1,
            ...(bell ? { bell } : {}),
            ...(sent && n.card_id
              ? {
                  next_attempt_at: new Date(
                    Date.parse(at) + 60_000,
                  ).toISOString(),
                }
              : {}),
          },
        });
        failed ||= !sent && !acked;
      }
      if (failed)
        this.escalate(tx, project, notes, attempt.assignment_id, reason);
    });
  }
  private reject(
    project: ProjectId,
    notes: readonly Notification[],
    a: Assignment,
    reason: string,
  ) {
    const { store } = this.options;
    store.uow.run((tx) => {
      const ids = new Set(notes.map((n) => n.id)),
        current = store
          .listNotifications({ project_id: project })
          .filter((n) => ids.has(n.id) && n.status === "pending");
      if (!current.length) return;
      for (const n of current)
        moveNotification(store.database, {
          project_id: project,
          id: n.id,
          event: "deliver_failed",
          at: this.clock.now(),
        });
      this.escalate(tx, project, current, a.id, reason);
    });
  }
  private escalate(
    tx: StoreTransactionContext,
    project: ProjectId,
    notes: readonly Notification[],
    assignment: Assignment["id"],
    reason: string,
  ) {
    if (notes.every((n) => n.recipient.kind === "pm_ops")) return; // Never recursively escalate a broken Ops bell to itself.
    const card_id = notes[0]?.card_id;
    const event: Event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project, card_id),
      ...(card_id ? { card_id } : {}),
      type: "bell_delivery_failed",
      actor: { kind: "system", project_id: project },
      payload: {
        assignment_id: assignment,
        reason,
        notification_ids: notes.map((n) => n.id),
      },
      created_at: this.clock.now(),
    };
    tx.events.append(project, event);
    recordNotification(this.options.store.database, {
      project_id: project,
      event_id: event.id,
      card_id,
      seq: event.seq,
      recipient: { kind: "pm_ops" },
      kind: "escalation",
      at: event.created_at,
    });
  }
}
