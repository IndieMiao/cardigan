import { randomUUID } from "node:crypto";
import type {
  Assignment,
  Clock,
  CommandState,
  DispatchRunParams,
  Notification,
  ProjectId,
  Run,
  Runtime,
} from "@cardigan/domain";
import {
  abortDispatch,
  canDispatchRun,
  compareDispatchOrder,
  DEFAULT_RUN_LIMIT,
  decisionFollowupBlocked,
  decisionFollowupPrompt,
  dispatchRun,
  isStandingPm,
  queueRun,
  remindDecisionFollowups,
} from "@cardigan/domain";
import { runCapacitySnapshot } from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  mergeNotifications,
  type NotificationKind,
  payloadString,
  summarizeNotifications,
} from "@cardigan/router";
import {
  type BellAttempt,
  beginBellAttempt,
  beginLaunchAttempt,
  finishBellAttempt,
  moveNotification,
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
} from "@cardigan/store";
import {
  alertAudience,
  dispatchAlert,
  unfinishedRun,
} from "./dispatch-alert.js";
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
  readonly retryBaseMs?: number;
  /** Retries after the initial send; zero disables retries. */
  readonly maxRetries?: number;
  /** Loaded once by the host; the decision reads the supplied limit on every claim. */
  readonly runLimit?: (machine: string) => number;
  readonly inactivityGraceMs?: number;
  /** Snapshot for a NEW terminal; an existing session keeps its previous Run's snapshot. */
  readonly snapshot: (
    assignment: Assignment,
    project: ProjectId,
  ) => Promise<Pick<Run, "model" | "agent_cli_version" | "launch_profile_ref">>;
  /** M3.5 host adapter: provision and dispatch THIS queued Run with bell as first prompt.
   * Never queue another Run. Own token/terminal compensation on startup failure. */
  readonly startRun: (input: {
    project: ProjectId;
    assignment: Assignment;
    run: Run;
    bell: string;
    replacement?: DispatchRunParams["replacement"];
  }) => Promise<void>;
  /** Prepare Git after claiming an idle Run; append current baseline to its prompt. */
  readonly beforeWake?: (input: {
    project: ProjectId;
    assignment: Assignment;
  }) => Promise<string | undefined> | Promise<void>;
}
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
interface Candidate {
  project: ProjectId;
  notes: Notification[];
  assignment: Assignment;
  order: {
    project_id: string;
    assignment_id: string;
    created_at: string;
    trigger_event_id: string;
  };
}
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
  private readonly retryBaseMs: number;
  private readonly maxRetries: number;
  private readonly inactivityGraceMs: number;
  constructor(readonly options: DispatcherOptions) {
    this.clock = options.clock ?? dispatcherClock;
    this.leaseMs = options.deliveryLeaseMs ?? 60_000;
    this.retryBaseMs = options.retryBaseMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.inactivityGraceMs = options.inactivityGraceMs ?? 15 * 60_000;
    if (
      !Number.isSafeInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      this.maxRetries > 30 ||
      ![
        this.retryBaseMs,
        this.inactivityGraceMs,
        this.retryDelay(this.maxRetries + 1),
      ].every((n) => Number.isSafeInteger(n) && n > 0)
    )
      throw new Error("Invalid dispatcher retry/watchdog settings");
    if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0)
      throw new Error("Invalid delivery lease");
  }
  /** Calls on one instance serialize; cross-process attempts are guarded in SQLite. */
  // Keep the legacy argument for callers; scheduling always spans all projects.
  tick(_project?: ProjectId): Promise<void> {
    const next = this.serial.then(async () => {
      // Route every project before choosing any winner. Project enumeration is
      // not a scheduling priority, even when a caller requests a project tick.
      const candidates = this.options.store
        .listProjects()
        .flatMap((p) => this.project(p.id));
      candidates.sort((a, b) => compareDispatchOrder(a.order, b.order));
      for (const candidate of candidates)
        await this.deliver(
          candidate.project,
          candidate.notes,
          candidate.assignment,
        );
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
  private project(project: ProjectId): Candidate[] {
    const { store, standing } = this.options;
    store.uow.run((tx) => {
      const effect = unwrap(
        remindDecisionFollowups(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          { clock: this.clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, project, effect);
    });
    routeProjectEvents(store, project, { clock: this.clock });
    acknowledgeInbox(store, project, standing, this.clock);
    for (const attempt of unfinishedBellAttempts(store.database, project))
      if (
        attempt.lease_until <= this.clock.now() &&
        this.state(project).assignments.find(
          (a) => a.id === attempt.assignment_id,
        )?.status !== "suspended"
      )
        this.settle(attempt, false, "interrupted_delivery");
    this.maintenance(project);
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
      if (!owner || decisionFollowupBlocked(state, n.event_id, owner)) continue;
      const key = `${owner}/${n.card_id ?? ""}/${n.attempts ? n.run_id : ""}`;
      groups.set(key, [...(groups.get(key) ?? []), n]);
    }
    const candidates: Candidate[] = [];
    const add = (assignment: Assignment, notes: Notification[]) => {
      const queued = this.queued(state, assignment);
      const cause = notes.find((n) => !n.run_id) ?? notes[0];
      const trigger = queued?.trigger_event_id ?? cause?.event_id;
      const event = state.events.find((e) => e.id === trigger);
      if (!event) return;
      candidates.push({
        project,
        notes,
        assignment,
        order: {
          project_id: project,
          assignment_id: assignment.id,
          created_at: event.created_at,
          trigger_event_id: event.id,
        },
      });
    };
    for (const notes of groups.values()) {
      notes.sort((a, b) => {
        const left = state.events.find((e) => e.id === a.event_id);
        const right = state.events.find((e) => e.id === b.event_id);
        return (
          (left?.created_at ?? a.created_at).localeCompare(
            right?.created_at ?? b.created_at,
          ) || a.event_id.localeCompare(b.event_id)
        );
      });
      const first = notes[0];
      const assignment =
        first &&
        state.assignments.find((a) => a.id === this.owner(first, state));
      if (assignment) add(assignment, notes);
    }
    // ACK is not cancellation: a Run deferred for capacity still needs dispatch
    // if its trigger notification was acknowledged while it waited.
    for (const assignment of state.assignments)
      if (
        this.queued(state, assignment)?.queue_reason !== undefined &&
        !candidates.some((c) => c.assignment.id === assignment.id)
      )
        add(assignment, []);
    return candidates;
  }
  private queued(state: CommandState, a: Assignment) {
    // Domain resumption can queue work before (or independently of) the
    // pending notification. That Run is the work to dispatch, not a busy flag.
    return state.runs.find(
      (r) => r.assignment_id === a.id && r.status === "queued",
    );
  }
  private busy(state: CommandState, a: Assignment) {
    const queued = this.queued(state, a);
    return state.runs.some(
      (r) =>
        r.assignment_id === a.id && unfinishedRun(r) && r.id !== queued?.id,
    );
  }
  private async deliver(
    project: ProjectId,
    notes: readonly Notification[],
    expected: Assignment,
  ) {
    const state = this.state(project);
    const a = state.assignments.find((a) => a.id === expected.id);
    if (!a) return;
    if (a.status === "released") {
      this.reject(project, notes, a, "assignment_released");
      return;
    }
    if (a.status !== "active" || this.busy(state, a)) return;
    let live = false;
    let replacement: DispatchRunParams["replacement"];
    if (a.runtime_ref) {
      const observed = await this.options.runtime
        .status(a.runtime_ref)
        .catch(() => undefined);
      if (!observed) {
        this.waitForRuntime(project, a);
        return;
      }
      if (observed.ok) {
        if (observed.value.process === "unknown") {
          this.waitForRuntime(project, a);
          return;
        }
        live = observed.value.process === "alive";
      } else if (
        observed.error.code === "runtime_not_found" ||
        observed.error.code === "runtime_unavailable"
      ) {
        replacement = {
          previous: a.runtime_ref,
          reason: observed.error.code,
        };
      } else {
        this.waitForRuntime(project, a);
        return;
      }
    }
    const queued = this.queued(state, a);
    const prior = state.runs
      .filter(
        (r) =>
          r.assignment_id === a.id &&
          r.started_at &&
          r.role_version === a.role_version,
      )
      .sort((x, y) => Number(y.id.slice(2)) - Number(x.id.slice(2)))[0];
    let snapshot: Pick<
      Run,
      "model" | "agent_cli_version" | "launch_profile_ref"
    >;
    let replaceProfile = false;
    try {
      if (a.employee_id) {
        snapshot = await this.options.snapshot(a, project);
        replaceProfile =
          live &&
          snapshot.launch_profile_ref !== undefined &&
          (prior?.launch_profile_ref !== snapshot.launch_profile_ref ||
            prior.model !== snapshot.model);
        if (replaceProfile) {
          live = false;
          if (a.runtime_ref)
            replacement = {
              previous: a.runtime_ref,
              reason: "launch_profile_changed",
            };
        } else if (live && prior) snapshot = prior;
      } else if (queued) snapshot = queued;
      else if (live) {
        if (!prior) {
          this.reject(project, notes, a, "missing_session_snapshot");
          return;
        }
        snapshot = prior;
      } else snapshot = await this.options.snapshot(a, project);
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
        const baseline = await this.options.beforeWake?.({
          project,
          assignment: job.assignment,
        });
        const result = await this.options.runtime.wake(
          job.assignment.runtime_ref,
          [job.bell, baseline].filter(Boolean).join("\n"),
        );
        sent = result.ok && result.value.sent;
        if (!result.ok) reason = `wake_failed:${result.error.code}`;
      } else {
        if (replaceProfile && job.assignment.runtime_ref) {
          const released = await this.options.runtime.release(
            job.assignment.runtime_ref,
            { force: true },
          );
          if (!released.ok)
            throw new Error("Previous employee session could not be released");
        }
        await this.options.startRun({
          project,
          assignment: job.assignment,
          run: job.run,
          bell: job.bell,
          ...(replacement ? { replacement } : {}),
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
  private waitForRuntime(project: ProjectId, expected: Assignment) {
    this.options.store.uow.run((tx) => {
      const state = loadCommandState(tx, project);
      const a = state.assignments.find((a) => a.id === expected.id);
      if (!a || !sameRef(a, expected)) return;
      const run = this.queued(state, a);
      if (!run || run.queue_reason === "runtime_unavailable") return;
      tx.runs.put(project, { ...run, queue_reason: "runtime_unavailable" });
      if (
        !state.events.some(
          (e) =>
            e.type === "queued_runtime_unavailable" &&
            payloadString(e.payload, "run_id") === run.id,
        )
      )
        dispatchAlert(tx, this.options.store, state, this.clock.now(), {
          assignment: a,
          type: "queued_runtime_unavailable",
          reason: "runtime_status_unknown",
          audience: alertAudience(a, state, this.options.standing),
          mark: true,
          card_id: state.work_items.find((w) => w.id === a.work_item_id)
            ?.card_id,
          run_id: run.id,
        });
    });
  }
  private claim(
    project: ProjectId,
    notes: readonly Notification[],
    expected: Assignment,
    snapshot: Pick<Run, "model" | "agent_cli_version" | "launch_profile_ref">,
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
          !covered(n, state, a.id) &&
          !decisionFollowupBlocked(state, n.event_id, a.id),
      );
      const waiting = this.queued(state, a);
      if (
        (!ready.length && waiting?.queue_reason === undefined) ||
        this.busy(state, a)
      )
        return;
      if (
        unfinishedBellAttempts(store.database, project).some(
          (r) =>
            r.assignment_id === a.id ||
            r.notification_ids.some((id) => requested.has(id)),
        )
      )
        return;
      const cause = ready.find((n) => !n.run_id) ?? ready[0];
      if (!cause && !waiting) return;
      let run =
        this.queued(state, a) ??
        state.runs.find(
          (r) =>
            r.assignment_id === a.id &&
            (r.id === cause?.run_id || r.trigger_event_id === cause?.event_id),
        );
      const at = this.clock.now(),
        ports = { clock: { now: () => at }, ids: tx.ids },
        actor = { kind: "system" as const, project_id: project };
      if (!run && cause) {
        const event = state.events.find((e) => e.id === cause.event_id);
        // §6.4: merge conflicts and returned merges wake the coder for a fix Run.
        // The router marks this as run_kind=fix; the trigger event is
        // the only place it survives, because notifications store no run kind.
        const kind =
          event?.type === "work_item_assigned"
            ? // M5.S S6: an Assignment created through MCP gets its first Run
              // from the host, so the assign bell starts an `initial` Run.
              "initial"
            : event?.type === "merge_conflicted" ||
                event?.type === "merge_changes_requested"
              ? "fix"
              : (event?.type === "review_submitted" ||
                    event?.type === "completion_reviewed") &&
                  cause.kind === "review"
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
              ...(snapshot.launch_profile_ref
                ? { launch_profile_ref: snapshot.launch_profile_ref }
                : {}),
            },
            ports,
          ),
        );
        persistEffect(tx, project, effect);
        run = effect.data;
        state = loadCommandState(tx, project);
      }
      if (!run) return;
      if (run.status === "queued") {
        const capacity = runCapacitySnapshot(store, tx);
        const trigger = state.events.find(
          (e) => e.id === run?.trigger_event_id,
        );
        const order = {
          project_id: project,
          assignment_id: a.id,
          created_at: trigger?.created_at ?? a.created_at,
          trigger_event_id: run.trigger_event_id,
        };
        const earlier = capacity.queue.some(
          (entry) =>
            entry.machine_id === a.machine_id &&
            compareDispatchOrder(entry, order) < 0,
        );
        if (
          (!isStandingPm(a) && earlier) ||
          !canDispatchRun(
            this.options.runLimit?.(a.machine_id) ?? DEFAULT_RUN_LIMIT,
            capacity.occupied.get(a.machine_id) ?? 0,
            isStandingPm(a),
          )
        ) {
          if (run.queue_reason !== "concurrency_limit")
            tx.runs.put(project, { ...run, queue_reason: "concurrency_limit" });
          return;
        }
        // A pending launch is reserved by its BellAttempt until dispatchRun
        // commits. It must no longer appear as a capacity wait in read views.
        const cleared = { ...run };
        delete cleared.queue_reason;
        run = cleared;
        tx.runs.put(project, run);
        state = loadCommandState(tx, project);
      }
      if (run.status === "queued" && snapshot.launch_profile_ref) {
        run = {
          ...run,
          model: snapshot.model,
          agent_cli_version: snapshot.agent_cli_version,
          launch_profile_ref: snapshot.launch_profile_ref,
        };
        tx.runs.put(project, run);
        state = loadCommandState(tx, project);
      }
      if (!live && run.status !== "queued")
        throw { code: "finished_run_needs_attention" };
      const kinds = ready.map((n) => ({
        seq: n.seq,
        kind: n.kind as NotificationKind,
        summary: "",
      }));
      // §6.2: the bell names the Run, because the Agent needs it for
      // finish_run and heartbeat even when the host started the session.
      const runCard = state.work_items.find(
        (w) => w.id === a.work_item_id,
      )?.card_id;
      const bell = !ready.length
        ? `[bell] ${runCard ? `card=${runCard} wi=${a.work_item_id}` : `project=${project}`} asg=${a.id} run=${run.id} kind=${run.kind}\n→ 请调用 whoami、get_card、get_updates 继续已排队工作`
        : cause?.card_id
          ? mergeNotifications({
              card_id: cause.card_id,
              assignment_id: a.id,
              run_id: run.id,
              notifications: kinds,
            })?.text
          : `[bell] project=${project} asg=${a.id} run=${run.id} seq=${Math.min(...ready.map((n) => n.seq))}..${Math.max(...ready.map((n) => n.seq))} summary=${JSON.stringify(summarizeNotifications(kinds))}\n→ 请调用 get_updates 读取项目更新`;
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
      if (ready.length) beginBellAttempt(store.database, attempt);
      else beginLaunchAttempt(store.database, attempt);
      if (live && run.status === "queued")
        persistEffect(
          tx,
          project,
          unwrap(dispatchRun(state, actor, { run_id: run.id }, ports)),
        );
      const followup = decisionFollowupPrompt(
        state,
        [...new Set([run.trigger_event_id, ...ready.map((n) => n.event_id)])],
        a.id,
      );
      return {
        attempt,
        run,
        assignment: a,
        bell: [bell, followup].filter(Boolean).join("\n"),
      };
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
      let state = loadCommandState(tx, project);
      // A queued Run has never crossed dispatch/sentinel. Fence it atomically
      // with lease recovery so a late provision cannot dispatch after its slot
      // has been handed to another Run. Dispatched/unknown work stays uncertain.
      if (
        !sent &&
        state.runs.find((r) => r.id === attempt.run_id)?.status === "queued"
      ) {
        persistEffect(
          tx,
          project,
          unwrap(
            abortDispatch(
              state,
              { kind: "system", project_id: project },
              { run_id: attempt.run_id, reason },
              { ids: tx.ids, clock: this.clock },
            ),
          ),
        );
        state = loadCommandState(tx, project);
      }
      const ids = new Set(attempt.notification_ids);
      const notes = store
        .listNotifications({ project_id: project })
        .filter((n) => ids.has(n.id));
      let failed = !sent && notes.length === 0;
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
                    Date.parse(at) + this.retryDelay(n.attempts + 1),
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
      const queued = tx.runs
        .list(project)
        .find(
          (r) =>
            r.assignment_id === a.id &&
            r.status === "queued" &&
            r.queue_reason !== undefined,
        );
      if (!current.length && !queued) return;
      if (queued) {
        const cleared = { ...queued };
        delete cleared.queue_reason;
        tx.runs.put(project, cleared);
      }
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
    const state = loadCommandState(tx, project);
    const a = state.assignments.find((a) => a.id === assignment);
    if (!a) return;
    dispatchAlert(tx, this.options.store, state, this.clock.now(), {
      assignment: a,
      type: "bell_delivery_failed",
      reason,
      audience: alertAudience(a, state, this.options.standing, notes),
      card_id:
        notes[0]?.card_id ??
        state.work_items.find((w) => w.id === a.work_item_id)?.card_id,
      notification_ids: notes.map((n) => n.id),
    });
  }
  private retryDelay(attempts: number) {
    return (
      this.retryBaseMs *
      2 ** Math.max(0, Math.min(attempts - 1, this.maxRetries - 1))
    );
  }
  private maintenance(project: ProjectId) {
    const { store, standing } = this.options;
    store.uow.run((tx) => {
      const state = loadCommandState(tx, project),
        at = this.clock.now();
      const attempts = unfinishedBellAttempts(store.database, project);
      for (const n of store.listNotifications({
        project_id: project,
        status: "belled",
      })) {
        if (!n.card_id || !n.next_attempt_at || n.next_attempt_at > at)
          continue;
        const owner = this.owner(n, state),
          a = state.assignments.find((a) => a.id === owner);
        if (
          a?.status !== "active" ||
          state.runs.some(
            (r) => r.assignment_id === a.id && unfinishedRun(r),
          ) ||
          attempts.some(
            (t) =>
              t.assignment_id === a.id || t.notification_ids.includes(n.id),
          )
        )
          continue;
        const exhausted = n.attempts >= this.maxRetries + 1;
        moveNotification(store.database, {
          project_id: project,
          id: n.id,
          event: exhausted ? "needs_attention" : "retry",
          at,
        });
        if (exhausted)
          dispatchAlert(tx, store, state, at, {
            assignment: a,
            type: "bell_retry_exhausted",
            reason: "ack_retry_limit",
            audience: alertAudience(a, state, standing, [n]),
            card_id: n.card_id,
            run_id: n.run_id,
            notification_ids: [n.id],
          });
      }
      for (const r of state.runs) {
        if (r.status !== "running") continue;
        const a = state.assignments.find((a) => a.id === r.assignment_id);
        if (a?.status !== "active") continue;
        const last = Math.max(
          Date.parse(r.started_at ?? a.created_at),
          Date.parse(a.last_mcp_activity_at ?? a.created_at),
        );
        if (
          Date.parse(at) - last < this.inactivityGraceMs ||
          state.events.some(
            (e) =>
              e.type === "run_inactive" &&
              payloadString(e.payload, "run_id") === r.id,
          )
        )
          continue;
        dispatchAlert(tx, store, state, at, {
          assignment: a,
          type: "run_inactive",
          reason: "mcp_inactivity",
          mark: true,
          audience: alertAudience(a, state, standing),
          run_id: r.id,
          card_id: state.work_items.find((w) => w.id === a.work_item_id)
            ?.card_id,
        });
      }
    });
  }
}
