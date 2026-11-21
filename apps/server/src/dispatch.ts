import { randomUUID } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type {
  Assignment,
  Clock,
  CommandState,
  DispatchRunParams,
  Notification,
  ProjectId,
  Run,
  RunId,
  Runtime,
} from "@cardigan/domain";
import {
  abortDispatch,
  assignmentCardHeld,
  assignmentDependenciesAllowStart,
  canDispatchRun,
  cardDependencyDispatchOrder,
  compareDispatchOrder,
  DEFAULT_INACTIVE_CANCEL_AFTER_MS,
  decisionFollowupPrompt,
  dispatchRecoveryFailed,
  dispatchRun,
  dispatchRunKind,
  dispatchTier,
  expireMergeSnoozes,
  type HarnessActivity,
  hasRunTarget,
  hostOpsPending,
  idleWakeGuard,
  isRunCapacityExempt,
  isStandingPm,
  launchSettings,
  newPmNotification,
  obsoleteDispatchAttention,
  pendingPrecheckConflict,
  pmNotificationState,
  providerAdmission,
  queueRun,
  refreshRunTargetWait,
  refreshTestReviewLimits,
  remainingResourceRatio,
  remindDecisionFollowups,
  remindSuggestionProgress,
  resolveDispatchAttention,
  reviewRunWakeDisposition,
  runnableQueuedRun,
  runsOf,
  standingRunDormant,
  stoppedByHuman,
  unreadableCommentTrigger,
  unreceivedBell,
} from "@cardigan/domain";
import {
  armBellReceipt,
  assignmentResourceKeys,
  bindRepairAttempt,
  crossRepairSendBoundary,
  deferIfTargetWait,
  deferTargetAttempt,
  deferTargetInTransaction,
  effectiveRunLimit,
  failAutomaticContextRun,
  type HarnessActivityInspection,
  HostLaunchError,
  hasEarlierCapacityWait,
  IDLE_ROLE_UPGRADE_INTERVAL_MS,
  type MachineLeases,
  type ReadProjectQuota,
  type ReadResourceLimits,
  type ResourceAccess,
  type ResourceAdmission,
  RunPreflightDeferred,
  RunPreparationDeferred,
  RunTargetDeferred,
  RuntimeTargetError,
  recordWakeRefusal,
  redactFailureLine,
  runCapacitySnapshot,
  settleTestReviewLimits,
  testReviewRunPrompt,
  tryHostOpsLock,
  upgradeIdleAssignmentRoles,
  WORKTREE_LAUNCH_LEASE_MS,
  wakeIsCurrent,
} from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { payloadString } from "@cardigan/router";
import {
  type BellAttempt,
  beginBellAttempt,
  beginLaunchAttempt,
  confirmReviewNotSent,
  finishBellAttempt,
  getRoleVersion,
  moveNotification,
  PROJECT_EVENT_STREAM,
  type ReadRepositories,
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
  withdrawBellAttempt,
} from "@cardigan/store";
import { checkBellReceipts } from "./bell-receipt.js";
import {
  CANDIDATE_FEED,
  type Candidate,
  CandidateIndex,
  notificationBlocked,
} from "./candidate-index.js";
import {
  DECISION_FOLLOWUP_FEED,
  DecisionFollowupSchedule,
} from "./decision-followup-schedule.js";
import {
  alertAudience,
  type DeliveryFailure,
  type DeliveryStage,
  deliveryAttemptFailed,
  deliveryFailure,
  deliveryFailureLine,
  dispatchAlert,
  unfinishedRun,
  wakeFailure,
} from "./dispatch-alert.js";
import { InactiveRunReaper } from "./dispatch-inactive.js";
import { InactivityAlerts } from "./dispatch-inactivity-alerts.js";
import {
  acknowledgeInbox,
  dispatcherClock,
  memoStanding,
  notificationBell,
  notificationOwner,
  resolveObsoletePmNotifications,
  resolveUnreadableNotifications,
  retireCancelledQueueNotes,
  routeProjectEvents,
  type StandingResolver,
  UNSETTLED_NOTIFICATION_STATUSES,
} from "./dispatch-inbox.js";
import { dispatchRecovery, retryDispatchedRuns } from "./dispatch-retry.js";
import { dispatchStateLoader, type StateLoader } from "./dispatch-state.js";
import type { MergeGit } from "./git.js";
import { patrolHostOps } from "./host-ops-patrol.js";
import { escalatePmMergeStalls } from "./pm-merge-stall-attention.js";
import { orderPmCandidates } from "./pm-notification-order.js";
import { recoverPmSession } from "./pm-recovery.js";
import { QueuedRunPatrol } from "./queued-run-patrol.js";
import { escalateReviewLimitWaits } from "./review-limit-attention.js";
import { runSystemReviewLimits, runSystemRules } from "./system-rules.js";
import { profileSpan, profileSpanSync } from "./tick-profile.js";

/** The model/CLI snapshot a queued Run records; C-106 adds harness and effort. */
export type LaunchSnapshot = Pick<
  Run,
  | "model"
  | "agent_cli_version"
  | "launch_profile_ref"
  | "launch_fingerprint"
  | "harness"
  | "effort"
>;

export interface DispatcherOptions {
  /** Passive standing-PM observation; inactivity cancellation keeps its existing policy. */
  readonly providerFailureThreshold?: number;
  readonly providerCooldownMs?: number;
  readonly pmRecoveryIntervalMs?: number;
  readonly proveReviewLimit?: NonNullable<MergeGit["proveReviewLimit"]>;
  readonly recoverLaunches?: (project: ProjectId) => Promise<void>;
  readonly harnessActivity?: (
    project: ProjectId,
    assignment: Assignment["id"],
  ) => HarnessActivity | undefined;
  readonly inspectHarnessActivity?: (
    project: ProjectId,
    stopTarget?: Assignment["id"],
    localOnly?: boolean,
  ) => Promise<ReadonlyMap<Assignment["id"], HarnessActivityInspection>>;
  readonly inactivityInspectionTimeoutMs?: number;
  readonly hostOpsTick?: () => Promise<void>;
  readonly baselineForWait?: (
    project: ProjectId,
  ) => Promise<{ branch: string; sha: string } | undefined>;
  readonly frameworkWaitReminderMs?: number;
  /** Maximum automatic baseline synchronizations per work item and precheck HEAD. */
  readonly baselineConflictMaxResumes?: number;
  readonly authorPrecheckFailureLimit?: number;
  readonly mergeShadowTick?: (project: ProjectId) => Promise<void>;
  readonly hostOpsPatrolIntervalMs?: number;
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
  readonly leases?: MachineLeases;
  readonly projectQuota?: ReadProjectQuota;
  readonly resourceLimits?: ReadResourceLimits;
  readonly runLimitMaximum?: (machine: string) => number;
  readonly inactivityGraceMs?: number;
  readonly dispatchTimeoutMs?: number;
  readonly deliveryRetryBaseMs?: number;
  readonly queuedRecheckAfterMs?: number;
  readonly inboxStallAfterMs?: number;
  readonly inactiveCancelAfterMs?: number | null;
  /** Snapshot for a NEW terminal; an existing session keeps its previous Run's snapshot. */
  readonly snapshot: (
    assignment: Assignment,
    project: ProjectId,
  ) => Promise<LaunchSnapshot>;
  /**
   * P2a-10 A: fingerprint of the MCP tools/list this deploy serves to the
   * Assignment. A live session whose recorded fingerprint differs is replaced
   * on its next natural wake. Absent (or undefined) disables the check.
   */
  readonly toolCatalog?: (
    assignment: Assignment,
    project: ProjectId,
  ) => string | undefined;
  /** M3.5 host adapter: provision and dispatch THIS queued Run with bell as first prompt.
   * Never queue another Run. Own token/terminal compensation on startup failure. */
  readonly startRun: (input: {
    project: ProjectId;
    assignment: Assignment;
    run: Run;
    bell: string;
    resourceAccess?: ResourceAccess;
    resourceGate?: () => boolean;
    resourcePreflight?: () => Promise<boolean>;
    snapshot?: LaunchSnapshot;
    replacement?: DispatchRunParams["replacement"];
  }) => Promise<void>;
  /** Prepare Git after claiming an idle Run; append current baseline to its prompt. */
  readonly beforeWake?: (input: {
    project: ProjectId;
    assignment: Assignment;
  }) => Promise<string | undefined> | Promise<void>;
  /** Server log for a failed bell delivery (sanitized, one line). */
  readonly onError?: (error: unknown) => void;
}
const sameRef = (a: Assignment, b: Assignment) =>
  JSON.stringify(a.runtime_ref) === JSON.stringify(b.runtime_ref);
const covered = (n: Notification, s: CommandState, owner: Assignment["id"]) =>
  s.cursors.some(
    (c) =>
      c.assignment_id === owner &&
      c.card_id === (n.card_id ?? PROJECT_EVENT_STREAM) &&
      c.acked_seq >= n.seq,
  );
interface Job {
  resourceAccess?: ResourceAccess;
  attempt: BellAttempt;
  run: Run;
  assignment: Assignment;
  bell: string;
}

/**
 * The dispatch priority of an Assignment's card. C-244: the work item is found
 * once instead of inside the card predicate (same first matches, no C × W scan).
 */
function cardPriority(state: CommandState, a: Assignment): number {
  const card = state.work_items.find((w) => w.id === a.work_item_id)?.card_id;
  return state.cards.find((c) => c.id === card)?.priority ?? 0;
}

// C-247: the RuntimeMonitor may mark a leftover Run unknown before the first
// tick (runtime_not_found, exit event, snapshot without the terminal); an
// unstarted unknown Run is still a dispatch that never began working.
const startupCandidate = (r: Run) =>
  (r.status === "dispatched" || r.status === "unknown") &&
  !r.started_at &&
  !r.dispatch_stop &&
  !r.inactivity_stop &&
  (!r.launch_publication ||
    ["started", "exited"].includes(r.launch_publication.phase));

export class Dispatcher {
  private readonly pmRecoveryChecks = new Map<ProjectId, number>();
  readonly clock: Clock;
  private loadState: StateLoader = loadCommandState;
  private serial: Promise<void> = Promise.resolve();
  /** C-244: per project; survives ticks, a restart starts empty and re-evaluates once. */
  private readonly followups = new Map<ProjectId, DecisionFollowupSchedule>();
  private readonly nextRoleUpgrade = new Map<ProjectId, number>();
  /** C-244: candidate lists per project, kept across ticks (memory only). */
  private candidateIndex: CandidateIndex | undefined;
  private readonly leaseMs: number;
  private readonly retryBaseMs: number;
  private readonly maxRetries: number;
  private readonly inactivityGraceMs: number;
  private readonly dispatchTimeoutMs: number;
  private readonly deliveryRetryBaseMs: number;
  private readonly inactive: InactiveRunReaper;
  private readonly queuedRunPatrol: QueuedRunPatrol;
  private readonly inactivityAlerts: InactivityAlerts;
  /** C-247: set once shutdown begins; no Run is claimed, woken or launched after it. */
  private closing = false;
  /**
   * C-247: Runs a previous server process left dispatched without
   * run_started. Collected on the first tick; each entry stays until the
   * terminal is confirmed gone (recovered), confirmed alive (left to the
   * dispatch timeout) or another path took the Run over.
   */
  private startup: Map<ProjectId, Set<RunId>> | undefined;
  constructor(readonly options: DispatcherOptions) {
    this.queuedRunPatrol = new QueuedRunPatrol(options);
    this.clock = options.clock ?? dispatcherClock;
    this.leaseMs = options.deliveryLeaseMs ?? 60_000;
    this.retryBaseMs = options.retryBaseMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.inactivityGraceMs = options.inactivityGraceMs ?? 15 * 60_000;
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? 10 * 60_000;
    this.deliveryRetryBaseMs = options.deliveryRetryBaseMs ?? 30_000;
    // Reject invalid source settings before deriving the cancellation grace.
    if (
      !Number.isSafeInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      this.maxRetries > 30 ||
      ![
        options.providerFailureThreshold ?? 1,
        options.providerCooldownMs ?? 1,
        this.retryBaseMs,
        this.inactivityGraceMs,
        this.dispatchTimeoutMs,
        this.deliveryRetryBaseMs,
        this.deliveryRetryBaseMs * 2 ** Math.max(0, this.maxRetries - 1),
        this.retryDelay(this.maxRetries + 1),
      ].every((n) => Number.isSafeInteger(n) && n > 0)
    )
      throw new Error("Invalid dispatcher retry/watchdog settings");
    if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0)
      throw new Error("Invalid delivery lease");
    const cancelAfterMs =
      options.inactiveCancelAfterMs === undefined
        ? Math.max(DEFAULT_INACTIVE_CANCEL_AFTER_MS, this.inactivityGraceMs)
        : options.inactiveCancelAfterMs;
    if (
      cancelAfterMs !== null &&
      (!Number.isSafeInteger(cancelAfterMs) || cancelAfterMs < 1)
    )
      throw new Error("Invalid inactive Run cancellation grace");
    this.inactivityAlerts = new InactivityAlerts({
      ...options,
      clock: this.clock,
      graceMs: this.inactivityGraceMs,
      ...(options.inactivityInspectionTimeoutMs !== undefined
        ? { inspectionTimeoutMs: options.inactivityInspectionTimeoutMs }
        : {}),
    });
    this.inactive = new InactiveRunReaper({
      inspectionPending: (project, run) =>
        this.inactivityAlerts.pending(project, run),
      store: options.store,
      runtime: options.runtime,
      clock: this.clock,
      afterMs: cancelAfterMs,
      onError: (error) => options.onError?.(error),
      onUnknown: (project, assignment, run, row) =>
        this.inactivityAlerts.publish(
          project,
          [{ assignment, run }],
          new Map([[assignment.id, row]]),
          !options.inspectHarnessActivity
            ? "unavailable"
            : row.status === "read_failed"
              ? "read_failed"
              : "completed",
        ),
      ...(options.inspectHarnessActivity
        ? { inspectHarnessActivity: options.inspectHarnessActivity }
        : {}),
      ...(options.harnessActivity
        ? { harnessActivity: options.harnessActivity }
        : {}),
      loadState: (tx, project) => this.loadState(tx, project),
      alert: (tx, state, assignment, run, reason) => {
        if (
          state.events.some(
            (e) =>
              e.type === reason &&
              payloadString(e.payload, "run_id") === run.id,
          )
        )
          return;
        const audience = isStandingPm(assignment)
          ? assignment.standing_mode === "office"
            ? "human_only"
            : "human"
          : alertAudience(assignment, state, options.standing);
        dispatchAlert(tx, options.store, state, this.clock.now(), {
          assignment,
          type: reason,
          reason,
          audience,
          run_id: run.id,
          mark: reason === "inactive_stop_unconfirmed",
          card_id: state.work_items.find(
            (w) => w.id === assignment.work_item_id,
          )?.card_id,
        });
      },
    });
  }
  /**
   * C-247: stop claiming new work synchronously so a shutdown
   * signal takes effect before the current tick reaches its next delivery. A
   * delivery already past its claim finishes; one not yet woken or launched
   * withdraws its intent and leaves the Run queued for the next process.
   * Await the result before closing resources used by in-flight worker stops.
   */
  close(): Promise<void> {
    this.closing = true;
    this.inactivityAlerts.close();
    return this.inactive.close();
  }
  /** Calls on one instance serialize; cross-process attempts are guarded in SQLite. */
  // Keep the legacy argument for callers; scheduling always spans all projects.
  tick(_project?: ProjectId): Promise<void> {
    const next = this.serial.then(async () => {
      this.loadState = dispatchStateLoader(this.options.store);
      try {
        if (this.closing) return;
        await profileSpan("startup_check", () => this.startupCheck());
        await profileSpan("host_ops", async () => this.options.hostOpsTick?.());
        // Route every project before choosing any winner. Project enumeration is
        // not a scheduling priority, even when a caller requests a project tick.
        const candidates: Candidate[] = [];
        await profileSpan("route", async () => {
          for (const project of this.options.store.listProjects())
            candidates.push(...(await this.project(project.id)));
        });
        await profileSpan("inactive", () =>
          this.inactive.tick(
            this.options.store.listProjects().map((p) => p.id),
          ),
        );
        const preferred = (c: Candidate) =>
          Number(
            this.options.leases?.config.preferred(c.assignment.machine_id) ===
              c.project,
          );
        candidates.sort(
          (a, b) =>
            preferred(b) - preferred(a) ||
            compareDispatchOrder(a.order, b.order),
        );
        await profileSpan("deliver", async () => {
          for (const candidate of orderPmCandidates(candidates, (c) =>
            this.state(c.project),
          )) {
            if (this.closing) break;
            await this.deliver(
              candidate.project,
              candidate.notes,
              candidate.assignment,
            );
          }
        });
      } finally {
        this.loadState = loadCommandState;
      }
    });
    this.serial = next.catch(() => {});
    return next;
  }
  private state(project: ProjectId) {
    return this.options.store.uow.read((tx) => this.loadState(tx, project));
  }
  private owner(n: Notification, state: CommandState) {
    return notificationOwner(n, state, this.options.standing);
  }
  private async project(project: ProjectId): Promise<Candidate[]> {
    const { store, standing } = this.options;
    // C-221: sub-spans of `route`; timing only. Synchronous steps stay
    // synchronous (no added await), so step order and interleaving are unchanged.
    const step = <T>(name: string, run: () => T) =>
      profileSpanSync(`route.${name}`, run);
    await this.options.leases?.reconcile(project, () => this.clock.now());
    step("patrol_host_ops", () =>
      patrolHostOps(
        store,
        project,
        this.clock,
        this.options.hostOpsPatrolIntervalMs,
        this.loadState,
      ),
    );
    // C-244: only decisions whose row changed since the last committed pass,
    // unsettled ones, and waits whose 30-minute delay is over are evaluated
    // (DecisionFollowupSchedule); the schedule learns the answers and the feed
    // position only after the transaction commits.
    step("decision_followups", () => {
      let schedule = this.followups.get(project);
      if (!schedule) {
        schedule = new DecisionFollowupSchedule();
        this.followups.set(project, schedule);
      }
      const plan = schedule;
      const { planned, statuses } = store.uow.run((tx) => {
        const changes = store.changesSince(
          project,
          DECISION_FOLLOWUP_FEED,
          plan.cursor,
        );
        const state = step("decision_followups.state", () =>
          this.loadState(tx, project),
        );
        const at = this.clock.now();
        const planned = plan.plan(state, changes, at);
        const statuses = step("decision_followups.evaluate", () =>
          plan.evaluate(state, planned, at),
        );
        const due = new Set(
          [...statuses]
            .filter(([, status]) => status.kind === "due")
            .map(([q]) => q.id),
        );
        if (due.size)
          step("decision_followups.persist", () =>
            persistEffect(
              tx,
              project,
              unwrap(
                remindDecisionFollowups(
                  state,
                  { kind: "system", project_id: project },
                  { clock: { now: () => at }, ids: tx.ids },
                  { decision_ids: due },
                ),
              ),
            ),
          );
        return { planned, statuses };
      });
      plan.record(planned, statuses);
    });
    await profileSpan("route.merge_shadow", async () =>
      this.options.mergeShadowTick?.(project),
    );
    step("suggestion_progress", () =>
      store.uow.run((tx) => {
        const state = this.loadState(tx, project);
        persistEffect(
          tx,
          project,
          unwrap(
            remindSuggestionProgress(
              state,
              { kind: "system", project_id: project },
              { clock: this.clock, ids: tx.ids },
            ),
          ),
        );
      }),
    );
    const now = Date.parse(this.clock.now());
    if (now >= (this.nextRoleUpgrade.get(project) ?? 0)) {
      this.nextRoleUpgrade.set(project, now + IDLE_ROLE_UPGRADE_INTERVAL_MS);
      try {
        await profileSpan("route.role_upgrade", () =>
          upgradeIdleAssignmentRoles(
            store,
            project,
            this.options.runtime,
            this.clock,
          ),
        );
      } catch {
        try {
          this.options.onError?.(
            new Error(
              "Idle role upgrade maintenance failed; dispatch continues",
            ),
          );
        } catch {
          /* Reporting cannot interrupt unrelated routing. */
        }
      }
    }
    // Awaiting an already-resolved promise does not run timers or socket IO.
    // These boundaries hold no transaction; all consumers recheck revisions.
    await yieldToLoop();
    let waitBaseline: { branch: string; sha: string } | undefined;
    const waitState = this.state(project);
    if (
      waitState.work_items.some((w) => {
        if (!["in_progress", "blocked", "waiting_decision"].includes(w.status))
          return false;
        return !!pendingPrecheckConflict(waitState.events, w, project);
      }) ||
      waitState.work_items.some(
        (w) => w.reported_blocker?.resume_when?.kind === "baseline_updated",
      ) ||
      waitState.runs.some(
        (r) =>
          r.wait_for?.condition.kind === "baseline_updated" &&
          !r.wait_for.resumed_by,
      )
    ) {
      try {
        waitBaseline = await this.options.baselineForWait?.(project);
      } catch {
        /* A failed Git observation never resolves a wait; retry next tick. */
      }
    }
    step("system_rules", () =>
      runSystemRules(
        store,
        project,
        this.clock,
        this.loadState,
        waitBaseline,
        this.options,
      ),
    );
    await yieldToLoop();
    const pmRecoveryAt = Date.parse(this.clock.now());
    if (
      !this.closing &&
      pmRecoveryAt >= (this.pmRecoveryChecks.get(project) ?? 0)
    ) {
      this.pmRecoveryChecks.set(
        project,
        pmRecoveryAt + (this.options.pmRecoveryIntervalMs ?? 30_000),
      );
      await recoverPmSession(
        store,
        project,
        this.options.runtime,
        this.clock,
        (state, assignment) =>
          !this.closing &&
          (!standing || standing(project, "pm_ops", state) === assignment.id),
        this.loadState,
      );
    }
    const proveReviewLimit = this.options.proveReviewLimit;
    if (proveReviewLimit)
      await profileSpan("route.system_review_limits", () =>
        runSystemReviewLimits(
          store,
          project,
          this.clock,
          proveReviewLimit,
          this.loadState,
        ),
      );
    step("route_events", () =>
      routeProjectEvents(store, project, {
        clock: this.clock,
        loadState: this.loadState,
      }),
    );
    step("unreadable", () =>
      resolveUnreadableNotifications(
        store,
        project,
        this.clock,
        this.loadState,
      ),
    );
    step("ack_inbox", () =>
      acknowledgeInbox(store, project, standing, this.clock, this.loadState),
    );
    try {
      await this.options.recoverLaunches?.(project);
    } catch (error) {
      this.options.onError?.(error);
    }
    await profileSpan("route.bell_attempts", async () => {
      for (const attempt of unfinishedBellAttempts(store.database, project)) {
        const assignment = this.state(project).assignments.find(
          (a) => a.id === attempt.assignment_id,
        );
        if (
          attempt.lease_until <= this.clock.now() &&
          assignment?.status !== "suspended" &&
          !assignment?.external
        ) {
          const unlock = await tryHostOpsLock(
            store,
            project,
            attempt.assignment_id,
            "launch",
          );
          if (!unlock) continue;
          try {
            this.settle(attempt, false, "interrupted_delivery");
          } finally {
            await unlock();
          }
        }
      }
    });
    await checkBellReceipts(
      this.options,
      project,
      this.state(project),
      this.loadState,
      this.clock,
      this.dispatchTimeoutMs,
      () => this.closing,
    );
    await profileSpan("route.retry_dispatched", () =>
      retryDispatchedRuns(
        {
          ...this.options,
          clock: this.clock,
          loadState: this.loadState,
          closing: () => this.closing,
        },
        project,
        {
          timeoutMs: this.dispatchTimeoutMs,
          retryBaseMs: this.deliveryRetryBaseMs,
          maxRetries: this.maxRetries,
          leaseMs: this.leaseMs,
        },
        (attempt, sent, reason, bell, failure) =>
          this.settle(attempt, sent, reason, bell, failure),
      ),
    );
    // Recovery and escalation are durable events, including CLI starts without an inbox row.
    step("route_events", () =>
      routeProjectEvents(store, project, {
        clock: this.clock,
        loadState: this.loadState,
      }),
    );
    step("maintenance", () => this.maintenance(project));
    resolveObsoletePmNotifications(
      store,
      project,
      this.clock,
      this.loadState,
      standing,
    );
    return step("candidates", () => this.candidates(project));
  }
  private candidates(project: ProjectId): Candidate[] {
    const { store } = this.options;
    // C-244: maintained across passes from the Store's row change feed; only
    // what depends on a changed row is evaluated again (CandidateIndex).
    this.candidateIndex ??= new CandidateIndex(this.options.standing);
    const index = this.candidateIndex;
    return store.uow.read((tx) =>
      index.candidates(project, {
        changes: (cursor) =>
          profileSpanSync("route.candidates.changes", () =>
            store.changesSince(project, CANDIDATE_FEED, cursor),
          ),
        state: () =>
          profileSpanSync("route.candidates.state", () =>
            this.loadState(tx, project),
          ),
        notifications: (ids) =>
          profileSpanSync("route.candidates.notifications", () =>
            store.listNotifications({
              project_id: project,
              status: "pending",
              ...(ids ? { ids } : {}),
            }),
          ),
        claimed: () =>
          new Set(
            unfinishedBellAttempts(store.database, project).flatMap(
              (a) => a.notification_ids,
            ),
          ),
      }),
    );
  }
  private queued(state: CommandState, a: Assignment) {
    // Domain resumption can queue work before (or independently of) the
    // pending notification. That Run is the work to dispatch, not a busy flag.
    // A standing owner can leave held work queued while servicing another card.
    return runnableQueuedRun(a, state);
  }
  private busy(state: CommandState, a: Assignment, continuing?: RunId) {
    if (a.role_upgrade || a.idle_retirement?.phase === "stopping") return true;
    if (hostOpsPending(state.events, a.id)) return true;
    // C-211: a stopped Assignment waits for the human's start; its bells stay
    // pending and no session is woken, replaced or started for it.
    if (stoppedByHuman(state.events, a.id)) return true;
    const queued = this.queued(state, a);
    // C-244: keyed per Run snapshot; same as scanning runs for `a`.
    return runsOf(state.runs, a.id).some(
      (r) =>
        r.dispatch_stop ||
        r.inactivity_stop ||
        (r.launch_publication &&
          !["started", "exited"].includes(r.launch_publication.phase)) ||
        (unfinishedRun(r) &&
          r.id !== continuing &&
          r.id !== queued?.id &&
          !standingRunDormant(a, r)),
    );
  }
  private async deliver(
    project: ProjectId,
    notes: readonly Notification[],
    expected: Assignment,
  ) {
    if (this.closing) return;
    const state = profileSpanSync("deliver.state", () => this.state(project));
    const a = state.assignments.find((a) => a.id === expected.id);
    if (!a) return;
    const queued = this.queued(state, a);
    if (queued) this.queuedRunPatrol.evaluated(queued, this.clock.now());
    if (a.status === "released") {
      this.reject(project, notes, a, "assignment_released");
      return;
    }
    // A finished harness turn is not a finished business Run. Only new inbox
    // work can continue it; never turn queued-only work into a second launch.
    const running =
      notes.length && a.runtime_ref
        ? runsOf(state.runs, a.id).find((r) => r.status === "running")
        : undefined;
    const continuing =
      running && notes.every((n) => !n.run_id || n.run_id === running.id)
        ? running
        : undefined;
    // A pending inbox note cannot become a second, unmetered initial wake.
    if (running && unreceivedBell(running)) return;
    if (
      a.external ||
      a.status !== "active" ||
      this.busy(state, a, continuing?.id) ||
      !assignmentDependenciesAllowStart(state, a) ||
      assignmentCardHeld(a, state) ||
      !hasRunTarget(a, state)
    )
      return;
    if (a.snapshot_retry && a.snapshot_retry.ready_at > this.clock.now())
      return;
    // A previously enqueued Run already has its snapshot. Skip remote IO while
    // it cannot compete; the authoritative check remains inside claim().
    if (
      !this.options.leases?.configured(project, a.machine_id) &&
      queued?.queue_reason === "concurrency_limit" &&
      !this.options.store.uow.read((tx) =>
        this.availableResources(tx, state, a, queued),
      )
    )
      return;
    let live = false;
    let guard: ReturnType<typeof idleWakeGuard>;
    let replacement: DispatchRunParams["replacement"];
    if (a.runtime_ref) {
      const runtimeRef = a.runtime_ref;
      const observed = await profileSpan("deliver.runtime_status", () =>
        this.options.runtime.status(runtimeRef).catch(() => undefined),
      );
      if (observed?.ok && observed.value.process === "alive") {
        guard = idleWakeGuard(observed.value);
        if (!guard) return; // A server-side finish never proves the CLI turn has ended.
      } else if (continuing) return;
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
    const prior = state.runs
      .filter(
        (r) =>
          r.assignment_id === a.id &&
          r.started_at &&
          r.role_version === a.role_version,
      )
      .sort((x, y) => Number(y.id.slice(2)) - Number(x.id.slice(2)))[0];
    let snapshot: LaunchSnapshot;
    let replaceProfile = false;
    // P2a-10 A (finding 40): the Harness lists MCP tools once per session, so
    // a session started under an older deploy keeps the old tools/list. Only a
    // recorded fingerprint that differs from this deploy's counts; legacy Runs
    // without one never trigger a replacement.
    const catalog = this.catalog(a, project);
    const replaceCatalog =
      live &&
      ((!continuing && this.options.leases?.freshSession(project, a)) ||
        (catalog !== undefined &&
          prior?.tool_catalog !== undefined &&
          prior.tool_catalog !== catalog));
    try {
      if (continuing) snapshot = continuing;
      else if (
        queued?.recovery_policy &&
        queued.recovery_policy.root_run_id !== queued.id
      ) {
        snapshot = queued;
      } else if (a.employee_id || (live && prior?.launch_profile_ref)) {
        snapshot = await this.options.snapshot(a, project);
        replaceProfile =
          live &&
          snapshot.launch_profile_ref !== undefined &&
          (prior?.launch_profile_ref !== snapshot.launch_profile_ref ||
            prior.model !== snapshot.model ||
            (snapshot.launch_fingerprint !== undefined
              ? prior.launch_fingerprint !== snapshot.launch_fingerprint
              : prior.effort !== snapshot.effort ||
                prior.harness !== snapshot.harness));
        if (replaceProfile) {
          live = false;
          if (a.runtime_ref)
            replacement = {
              previous: a.runtime_ref,
              reason: "launch_profile_changed",
            };
        } else if (live && prior && !replaceCatalog) snapshot = prior;
      } else if (queued) snapshot = queued;
      else if (live && !replaceCatalog) {
        if (!prior) {
          this.reject(project, notes, a, "missing_session_snapshot");
          return;
        }
        snapshot = prior;
      } else snapshot = await this.options.snapshot(a, project);
    } catch (error) {
      if (this.closing) return;
      const versionProbe =
        error instanceof HostLaunchError && error.step === "cli version";
      const cause = versionProbe ? error.cause : error;
      // hc returned before executing --version. Do not retry general CLI or
      // adapter errors, even if their diagnostic mentions a queue timeout.
      const versionNotExecuted =
        versionProbe &&
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "runtime_queue_timeout";
      if (
        !this.reject(
          project,
          notes,
          a,
          "snapshot_unavailable",
          queued?.id,
          versionNotExecuted ||
            (cause instanceof RuntimeTargetError && cause.transient),
        )
      )
        return;
      this.options.onError?.(
        new Error(
          `bell delivery rejected: project=${project} asg=${a.id} reason=snapshot_unavailable message=${redactFailureLine(error instanceof Error ? error.message : String(error))}`,
        ),
      );
      return;
    }
    if (!continuing && replaceCatalog && !replaceProfile && a.runtime_ref) {
      // Same replacement path as a lost runtime: resume_or_replace force-
      // releases the live terminal and starts a fresh CLI session, so the new
      // session lists the current tools.
      live = false;
      replacement = { previous: a.runtime_ref, reason: "tool_catalog_changed" };
    }
    // A reused session keeps the catalog it listed; a new one lists this deploy's.
    const sessionCatalog = live ? prior?.tool_catalog : catalog;
    // C-247: runtime status and snapshot IO were awaited; shutdown may have begun.
    if (this.closing) return;
    const inspection =
      !continuing && this.options.leases?.configured(project, a.machine_id)
        ? await this.options.leases?.inspect(project, a)
        : undefined;
    if (this.closing) return;
    let job: Job | undefined;
    try {
      job = profileSpanSync("deliver.claim", () =>
        this.claim(
          project,
          notes,
          a,
          snapshot,
          live,
          sessionCatalog,
          inspection,
          continuing,
        ),
      );
    } catch (error) {
      if (a.role_id === "independent_reviewer")
        settleTestReviewLimits(this.options.store, project, this.clock);
      if (
        error &&
        !(error instanceof Error) &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
      ) {
        this.reject(
          project,
          notes,
          a,
          `dispatch_rejected:${error.code}`,
          queued?.id,
        );
        return;
      }
      throw error;
    }
    if (!job) return;
    const leases = this.options.leases;
    const preflight =
      job.resourceAccess?.target && leases && !continuing
        ? () =>
            leases.canPublish(
              project,
              a,
              job.run,
              () => this.clock.now(),
              job.resourceAccess,
            )
        : undefined;
    let sent = false,
      reason = "delivery_failed",
      failure: DeliveryFailure | undefined,
      stage: DeliveryStage = "delivery_call";
    let unlockWake: (() => Promise<void>) | undefined;
    try {
      const runtimeRef = job.assignment.runtime_ref;
      if (live && runtimeRef) {
        unlockWake = await tryHostOpsLock(
          this.options.store,
          project,
          job.assignment.id,
          "launch",
        );
        if (!unlockWake) throw new RunPreparationDeferred();
        stage = "before_wake";
        const baseline = continuing
          ? undefined
          : await profileSpan("deliver.before_wake", async () =>
              this.options.beforeWake?.({
                project,
                assignment: job.assignment,
              }),
            );
        if (
          !continuing &&
          deferIfTargetWait(this.options.store, job.attempt, this.clock)
        ) {
          return;
        }
        if (this.withdrawOnClose(job, queued?.queue_reason)) return;
        if (preflight && !(await preflight())) {
          this.options.store.uow.run(() =>
            withdrawBellAttempt(
              this.options.store.database,
              project,
              job.attempt.id,
            ),
          );
          return;
        }
        if (!profileSpanSync("deliver.activate", () => this.activate(job)))
          return;
        const scope = () =>
          job.assignment.role_id === "independent_reviewer"
            ? this.options.store.uow.read((tx) =>
                testReviewRunPrompt(
                  loadCommandState(tx, project),
                  job.assignment.id,
                  job.run.id,
                ),
              )
            : undefined;
        const reviewPrompt = scope();
        stage = "wake";
        const result = await profileSpan("deliver.wake", () =>
          this.options.runtime.wake(
            runtimeRef,
            [job.bell, baseline, reviewPrompt].filter(Boolean).join("\n"),
            {
              ...guard,
              ...(preflight ? { resource_preflight: preflight } : {}),
              before_send: () =>
                !this.withdrawOnClose(job, queued?.queue_reason) &&
                scope() === reviewPrompt &&
                (continuing ||
                  !this.options.leases?.startBlocked(
                    project,
                    a,
                    job.run,
                    this.clock.now(),
                    job.resourceAccess,
                  )) &&
                (job.attempt.review_wake
                  ? crossRepairSendBoundary(
                      this.options.store,
                      job.attempt,
                      job.assignment,
                      this.clock,
                    ) === "send"
                  : this.activate(job)) &&
                (job.run.status !== "queued" ||
                  armBellReceipt(
                    this.options.store,
                    project,
                    job.run.id,
                    runtimeRef,
                    undefined,
                    job.attempt.review_wake,
                  )),
            },
          ),
        );
        if (result.ok && result.value.withdrawn) {
          recordWakeRefusal(
            this.options.store,
            job.attempt,
            job.assignment,
            this.clock.now(),
          );
          return;
        }
        if (result.ok && !result.value.sent && job.attempt.review_wake) {
          const unsent = job.attempt;
          this.options.store.uow.run(() =>
            confirmReviewNotSent(this.options.store.database, unsent),
          );
        }
        sent = result.ok && result.value.sent;
        if (!result.ok) ({ reason, failure } = wakeFailure(result.error));
      } else {
        if (this.withdrawOnClose(job, queued?.queue_reason)) return;
        if (replaceProfile && job.assignment.runtime_ref) {
          const released = await this.options.runtime.release(
            job.assignment.runtime_ref,
            { force: true },
          );
          if (!released.ok)
            throw new Error(
              "Previous launch profile session could not be released",
            );
        }
        await profileSpan("deliver.start_run", () =>
          this.options.startRun({
            project,
            assignment: job.assignment,
            run: job.run,
            bell: job.bell,
            snapshot,
            ...(job.resourceAccess
              ? { resourceAccess: job.resourceAccess }
              : {}),
            ...(preflight ? { resourcePreflight: preflight } : {}),
            ...(this.options.leases
              ? {
                  resourceGate: () =>
                    !this.options.leases?.startBlocked(
                      project,
                      a,
                      job.run,
                      this.clock.now(),
                      job.resourceAccess,
                    ),
                }
              : {}),
            ...(replacement ? { replacement } : {}),
          }),
        );
        const actual = this.state(project).runs.find(
          (r) => r.id === job?.run.id,
        );
        sent =
          !!actual &&
          ["dispatched", "acked", "running", "completed"].includes(
            actual.status,
          );
        if (
          !sent &&
          actual?.status === "queued" &&
          deferIfTargetWait(this.options.store, job.attempt, this.clock)
        ) {
          return;
        }
        reason = "startup_did_not_dispatch";
      }
    } catch (error) {
      if (
        !live &&
        error instanceof RunPreflightDeferred &&
        this.deferPreflight(job, queued?.queue_reason)
      )
        return;
      if (error instanceof RunPreparationDeferred) {
        const attempt = job.attempt;
        this.options.store.uow.run(() =>
          withdrawBellAttempt(this.options.store.database, project, attempt.id),
        );
        return;
      }
      // Only pre-delivery waits can withdraw an intent. A failed wake is still
      // ambiguous and must retain its attempt and normal retry semantics.
      if (stage !== "wake" && error instanceof RunTargetDeferred) {
        deferTargetAttempt(this.options.store, job.attempt, this.clock);
        return;
      }
      if (
        stage !== "wake" &&
        (stage === "before_wake" ||
          (this.state(project).runs.find((r) => r.id === job.run.id)?.status ===
            "queued" &&
            !(error instanceof HostLaunchError))) &&
        deferIfTargetWait(this.options.store, job.attempt, this.clock)
      )
        return;
      if (live && stage !== "wake" && !this.activate(job)) return;
      ({ reason, failure } = deliveryFailure(stage, error));
    } finally {
      await unlockWake?.();
    }
    if (failure)
      this.options.onError?.(
        new Error(
          deliveryFailureLine({
            project,
            assignment: job.assignment.id,
            run: job.run.id,
            reason,
            failure,
          }),
        ),
      );
    this.settle(job.attempt, sent, reason, job.bell, failure);
  }
  private catalog(a: Assignment, project: ProjectId): string | undefined {
    try {
      return this.options.toolCatalog?.(a, project);
    } catch (error) {
      // A fingerprint failure must not block delivery; it only skips the check.
      this.options.onError?.(
        new Error(
          `tool catalog unavailable: project=${project} asg=${a.id} message=${redactFailureLine(error instanceof Error ? error.message : String(error))}`,
        ),
      );
      return undefined;
    }
  }
  private waitForRuntime(project: ProjectId, expected: Assignment) {
    this.options.store.uow.run((tx) => {
      const state = this.loadState(tx, project);
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
  private availableResources(
    tx: ReadRepositories,
    state: CommandState,
    a: Assignment,
    run: Run,
  ) {
    const project = state.project_id;
    const capacity = runCapacitySnapshot(
      this.options.store,
      tx,
      this.options.resourceLimits,
      this.options.projectQuota,
    );
    const slots = capacity.resourcesForMachine(a.machine_id);
    const keys = assignmentResourceKeys(tx, project, a);
    if (!capacity.withinProjectQuota(project, a, keys)) return undefined;
    const trigger = state.events.find((e) => e.id === run.trigger_event_id);
    const order = {
      ...dispatchTier(state, a, run, trigger),
      priority: cardPriority(state, a),
      ...cardDependencyDispatchOrder(state, a),
      project_id: project,
      assignment_id: a.id,
      created_at: trigger?.created_at ?? a.created_at,
      trigger_event_id: run.trigger_event_id,
    };
    const earlier = hasEarlierCapacityWait(
      tx,
      capacity.queue,
      order,
      a.machine_id,
      slots,
      this.clock.now(),
      (p, owner) =>
        !this.options.leases?.waitingElsewhere(
          p,
          owner,
          this.clock.now(),
          tx,
        ) &&
        capacity.withinProjectQuota(p, owner) &&
        hasRunTarget(owner, {
          work_items: tx.work_items.list(p),
          deliveries: tx.deliveries.list(p),
        }),
      this.options.leases?.config.preferred(a.machine_id),
    );
    if (
      remainingResourceRatio(keys, slots) <= 0 ||
      (!isRunCapacityExempt(a) && earlier) ||
      !canDispatchRun(
        effectiveRunLimit(
          this.options.store,
          a.machine_id,
          this.options.runLimit,
          this.options.runLimitMaximum,
        ),
        capacity.occupied.get(a.machine_id) ?? 0,
        isRunCapacityExempt(a),
      )
    )
      return undefined;
    return keys;
  }
  private claim(
    project: ProjectId,
    notes: readonly Notification[],
    expected: Assignment,
    snapshot: LaunchSnapshot,
    live: boolean,
    catalog: string | undefined,
    inspection: ResourceAdmission | undefined,
    continuing?: Run,
  ): Job | undefined {
    const { store } = this.options;
    return store.uow.run((tx) => {
      let state = this.loadState(tx, project);
      const a = state.assignments.find((a) => a.id === expected.id);
      if (
        a?.status !== "active" ||
        a.external ||
        !sameRef(a, expected) ||
        a.snapshot_retry?.ready_at !== expected.snapshot_retry?.ready_at
      )
        return;
      if (
        continuing &&
        (a.session_ref !== expected.session_ref ||
          a.last_mcp_activity_at !== expected.last_mcp_activity_at ||
          !wakeIsCurrent(state, expected, continuing.id) ||
          !state.runs.some(
            (r) => r.id === continuing.id && r.status === "running",
          ))
      )
        return;
      if (
        !assignmentDependenciesAllowStart(state, a) ||
        assignmentCardHeld(a, state, this.queued(state, a)?.trigger_event_id) ||
        (a.scope === "standing" &&
          notes.some((n) =>
            state.cards.some((c) => c.id === n.card_id && !!c.hold),
          ))
      )
        return;
      // A delivery may have been superseded while runtime/snapshot IO was in flight.
      // Keep notifications pending without allocating a Run or a bell attempt.
      if (!hasRunTarget(a, state)) {
        const waiting = this.queued(state, a);
        if (waiting)
          persistEffect(
            tx,
            project,
            unwrap(
              refreshRunTargetWait(
                state,
                { kind: "system", project_id: project },
                { run_id: waiting.id },
                { ids: tx.ids, clock: this.clock },
              ),
            ),
          );
        return;
      }
      if (
        a.scope === "standing" &&
        a.role_id === "pm" &&
        a.standing_mode === "ops"
      ) {
        const fresh = new CandidateIndex(this.options.standing)
          .candidates(project, {
            changes: () => undefined,
            state: () => state,
            notifications: () =>
              store.listNotifications({
                project_id: project,
                status: "pending",
              }),
            claimed: () =>
              new Set(
                unfinishedBellAttempts(store.database, project).flatMap(
                  (attempt) => attempt.notification_ids,
                ),
              ),
          })
          .filter((c) => c.assignment.id === a.id);
        if (
          fresh.some((c) => c.notes.some((n) => newPmNotification(state, n)))
        ) {
          fresh.sort((left, right) =>
            compareDispatchOrder(left.order, right.order),
          );
          const first = orderPmCandidates(fresh, () => state)[0];
          if (
            first &&
            (first.notes.length !== notes.length ||
              first.notes.some((n) => !notes.some((old) => old.id === n.id)))
          )
            return;
        }
      }
      const requested = new Set(notes.map((n) => n.id));
      // C-216: fetch only the requested pending rows instead of decoding the
      // project's whole notification history on every claim.
      const ready = store
        .listNotifications({
          project_id: project,
          status: "pending",
          ids: [...requested],
        })
        .filter(
          (n) =>
            this.owner(n, state) === a.id &&
            !covered(n, state, a.id) &&
            !notificationBlocked(state, n.event_id, a.id) &&
            !(
              a.standing_mode === "ops" &&
              newPmNotification(state, n) &&
              pmNotificationState(state, n) === "obsolete"
            ),
        );
      const waiting = this.queued(state, a);
      if (
        (!ready.length &&
          waiting?.queue_reason === undefined &&
          !waiting?.dispatch_target_wait &&
          !waiting?.preparation_retry) ||
        (!ready.length &&
          waiting &&
          notificationBlocked(state, waiting.trigger_event_id, a.id)) ||
        (continuing && !ready.length) ||
        this.busy(state, a, continuing?.id)
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
        continuing ??
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
        const kind = dispatchRunKind(event, a, cause.kind === "review");
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
              ...launchSettings(snapshot),
            },
            ports,
          ),
        );
        persistEffect(tx, project, effect);
        run = effect.data;
        state = this.loadState(tx, project);
      }
      if (!run) return;
      if (
        run.preparation_retry &&
        Date.parse(this.clock.now()) <
          Date.parse(run.preparation_retry.ready_at)
      )
        return;
      if (unreadableCommentTrigger(state, run)) return;
      if (run.status === "queued") {
        const profile =
          snapshot.launch_profile_ref ??
          run.launch_profile_ref ??
          (a.employee_id &&
            tx.employees.get(a.employee_id)?.launch_profile_ref) ??
          getRoleVersion(tx, project, a.role_id, a.role_version)
            ?.launch_profile_ref;
        const probe = providerAdmission(state, profile, at, (r) =>
          unfinishedBellAttempts(store.database, project, r.assignment_id).some(
            (b) => b.run_id === r.id,
          ),
        );
        if (probe === "wait") {
          if (run.queue_reason !== "provider_unavailable")
            tx.runs.put(project, {
              ...run,
              queue_reason: "provider_unavailable",
            });
          return;
        }
        const leases = this.options.leases;
        const keysNeeded = assignmentResourceKeys(tx, project, a);
        const blocked = leases?.blocked(
          project,
          a.machine_id,
          keysNeeded,
          at,
          inspection,
        );
        const keys = blocked
          ? undefined
          : this.availableResources(tx, state, a, run);
        if (!keys) {
          if (leases?.configured(project, a.machine_id))
            leases.wait(
              tx,
              project,
              a,
              run,
              blocked ?? "并发额度或排队顺序",
              at,
              !!blocked,
            );
          if (run.queue_reason !== "concurrency_limit")
            tx.runs.put(project, { ...run, queue_reason: "concurrency_limit" });
          return;
        }
        // A pending launch is reserved by its BellAttempt until dispatchRun
        // commits. It must no longer appear as a capacity wait in read views.
        const cleared = {
          ...run,
          resource_keys: keys,
          ...(probe ? { provider_probe: probe } : {}),
        };
        delete cleared.queue_reason;
        run = cleared;
        tx.runs.put(project, run);
        state = this.loadState(tx, project);
      }
      if (run.status === "queued" && snapshot.launch_profile_ref) {
        const { harness: _harness, effort: _effort, ...rest } = run;
        run = {
          ...rest,
          ...launchSettings(snapshot),
          ...(snapshot.launch_fingerprint
            ? { launch_fingerprint: snapshot.launch_fingerprint }
            : {}),
          model: snapshot.model,
          agent_cli_version: snapshot.agent_cli_version,
          launch_profile_ref: snapshot.launch_profile_ref,
        };
        tx.runs.put(project, run);
        state = this.loadState(tx, project);
      }
      if (
        run.status === "queued" &&
        catalog !== undefined &&
        run.tool_catalog !== catalog
      ) {
        run = { ...run, tool_catalog: catalog };
        tx.runs.put(project, run);
        state = this.loadState(tx, project);
      }
      if (!live && run.status !== "queued")
        throw { code: "finished_run_needs_attention" };
      // §6.2: the bell names the Run, because the Agent needs it for
      // finish_run and heartbeat even when the host started the session.
      const runCard = state.work_items.find(
        (w) => w.id === a.work_item_id,
      )?.card_id;
      const bell = !ready.length
        ? `[bell] ${runCard ? `card=${runCard} wi=${a.work_item_id}` : `project=${project}`} asg=${a.id} run=${run.id} kind=${run.kind}\n→ 请调用 whoami、get_card、get_updates 继续已排队工作`
        : notificationBell(project, a.id, run.id, ready);
      // Set the budget on the durable intent *before* publication copies it.
      // Live wakes (including retries), local starts and no-checkout roles keep the bell lease.
      const worktree =
        !live &&
        a.machine_id !== "local" &&
        runCard &&
        state.cards.find((c) => c.id === runCard)?.repo &&
        getRoleVersion(tx, project, a.role_id, a.role_version)?.worktree;
      const leaseMs =
        worktree === "write" || worktree === "readonly"
          ? Math.max(this.leaseMs, WORKTREE_LAUNCH_LEASE_MS)
          : this.leaseMs;
      const intent = {
        id: randomUUID(),
        project_id: project,
        assignment_id: a.id,
        run_id: run.id,
        notification_ids: ready.map((n) => n.id),
        started_at: at,
        lease_until: new Date(Date.parse(at) + leaseMs).toISOString(),
      };
      const access =
        run.status === "queued" && inspection
          ? this.options.leases?.acquire(
              tx,
              project,
              a,
              run,
              run.resource_keys ?? [],
              inspection,
              at,
            )
          : undefined;
      let attempt = ready.length
        ? beginBellAttempt(store.database, intent)
        : beginLaunchAttempt(store.database, intent);
      if (run.status === "queued" && run.bell_delivery?.run_id !== run.id) {
        const card = cause ? cause.card_id : runCard;
        run = {
          ...run,
          bell_delivery: { run_id: run.id, ...(card ? { card_id: card } : {}) },
        };
        tx.runs.put(project, run);
        state = this.loadState(tx, project);
      }
      // Keep producer/standing dispatch timing unchanged. Only verification
      // needs to remain queued until asynchronous target preparation finishes.
      if (
        live &&
        run.status === "queued" &&
        !this.options.leases?.configured(project, a.machine_id) &&
        state.work_items.find((w) => w.id === a.work_item_id)?.kind !== "verify"
      ) {
        const effect = unwrap(
          dispatchRun(state, actor, { run_id: run.id }, ports),
        );
        persistEffect(tx, project, effect);
        attempt = bindRepairAttempt(store, state, effect.data, attempt);
      } else if (live) attempt = bindRepairAttempt(store, state, run, attempt);

      const followup = decisionFollowupPrompt(
        state,
        [...new Set([run.trigger_event_id, ...ready.map((n) => n.event_id)])],
        a.id,
      );
      return {
        ...(access ? { resourceAccess: access } : {}),
        attempt,
        run,
        assignment: a,
        bell: [bell, followup].filter(Boolean).join("\n"),
      };
    });
  }
  /**
   * C-247: during shutdown, give back a claimed delivery that has not crossed
   * dispatch. Nothing was sent, so the reservation is withdrawn and the Run
   * stays queued with its notifications pending. A Run the claim already
   * dispatched (an idle producer session) is completed by the wake instead,
   * so no Run is left dispatched without a delivery attempt. A wait marker the
   * claim cleared is restored, because a Run without notifications is only
   * picked up again through it.
   */
  private withdrawOnClose(
    job: Job,
    waited: Run["queue_reason"] | undefined,
  ): boolean {
    if (!this.closing) return false;
    const { store } = this.options;
    const project = job.attempt.project_id;
    return store.uow.run((tx) => {
      const run = tx.runs.get(project, job.run.id);
      if (
        run?.status !== "queued" ||
        !withdrawBellAttempt(store.database, project, job.attempt.id)
      )
        return false;
      if (waited && run.queue_reason === undefined)
        tx.runs.put(project, { ...run, queue_reason: waited });
      return true;
    });
  }
  /** C-247: the startup check; see `startup`. */
  private async startupCheck() {
    const { store } = this.options;
    if (!this.startup) {
      this.startup = new Map();
      for (const { id: project } of store.listProjects()) {
        const ids = this.state(project)
          .runs.filter((r) => startupCandidate(r))
          .map((r) => r.id);
        if (ids.length) this.startup.set(project, new Set(ids));
      }
    }
    for (const [project, ids] of this.startup) {
      for (const id of [...ids]) {
        if (this.closing) return;
        if ((await this.checkStartupRun(project, id)) !== "retry")
          ids.delete(id);
      }
      if (!ids.size) this.startup.delete(project);
    }
  }
  private async checkStartupRun(
    project: ProjectId,
    id: RunId,
  ): Promise<"recovered" | "left" | "retry"> {
    const { store, runtime } = this.options;
    const state = this.state(project);
    const run = state.runs.find((r) => r.id === id);
    const a = state.assignments.find((a) => a.id === run?.assignment_id);
    // Started, finished, fenced or escalated meanwhile: its owner handles it.
    if (
      !run ||
      !startupCandidate(run) ||
      a?.status !== "active" ||
      a.external ||
      !a.runtime_ref ||
      hostOpsPending(state.events, a.id) ||
      state.events.some(
        (e) =>
          e.type === "run_dispatch_stalled" &&
          payloadString(e.payload, "run_id") === run.id,
      )
    )
      return "left";
    // An in-flight delivery decides first; its lease expiry is settled by routing.
    if (
      unfinishedBellAttempts(store.database, project).some(
        (t) => t.assignment_id === a.id,
      )
    )
      return "retry";
    const observed = await runtime.status(a.runtime_ref).catch(() => undefined);
    if (
      observed?.ok
        ? observed.value.process === "exited"
        : observed?.error.code === "runtime_not_found"
    ) {
      const stopped = await dispatchRecovery(
        {
          ...this.options,
          store,
          runtime,
          clock: this.clock,
          loadState: (tx, p) => this.loadState(tx, p),
        },
        project,
        {
          timeoutMs: this.dispatchTimeoutMs,
          maxRetries: this.maxRetries,
          leaseMs: this.leaseMs,
        },
      ).stopRun(run.id, "server_restart");
      // C-247: the stop re-observes before fencing and never force-closes; a
      // terminal seen again (still starting) withdraws the fence, and the next
      // tick decides with a fresh observation.
      return stopped === "not_exited" ? "retry" : "recovered";
    }
    // A live terminal may still be starting: the dispatch timeout stays in
    // charge. Unknown or unreachable status is asked again next tick.
    return observed?.ok && observed.value.process === "alive"
      ? "left"
      : "retry";
  }
  /** The lease reserves a queued Run during preparation; dispatch immediately before wake. */
  private activate(job: Job): boolean {
    const { store } = this.options;
    const project = job.attempt.project_id;
    return store.uow.run((tx) => {
      if (
        !unfinishedBellAttempts(store.database, project).some(
          (a) => a.id === job.attempt.id,
        )
      )
        return false;
      let state = loadCommandState(tx, project);
      if (
        job.assignment.role_id === "independent_reviewer" &&
        state.deliveries.some((v) => v.test_review)
      ) {
        const limits = unwrap(
          refreshTestReviewLimits(
            state,
            { kind: "system", project_id: project },
            { clock: this.clock, ids: tx.ids },
          ),
        );
        persistEffect(tx, project, limits);
        if (
          job.assignment.scope === "work_item" &&
          limits.data.includes(job.assignment.work_item_id)
        ) {
          withdrawBellAttempt(store.database, project, job.attempt.id);
          return false;
        }
        state = loadCommandState(tx, project);
      }
      const run = state.runs.find((r) => r.id === job.run.id);
      const owner = state.assignments.find((a) => a.id === job.assignment.id);
      if (
        owner &&
        run &&
        reviewRunWakeDisposition(state, owner, run) === "paused"
      ) {
        deferTargetInTransaction(store, tx, state, job.attempt, this.clock);
        return false;
      }
      // The producer was dispatched before asynchronous lock/preparation IO.
      // Recheck its authority immediately before sending: a human stop or a
      // replaced/finished session must not receive this stale bell.
      if (
        !run ||
        !owner ||
        !wakeIsCurrent(state, job.assignment, job.run.id) ||
        !this.wakeStatusCurrent(state, job, owner, run)
      ) {
        withdrawBellAttempt(store.database, project, job.attempt.id);
        return false;
      }
      if (
        (run.status === "queued" &&
          assignmentCardHeld(owner, state, run.trigger_event_id)) ||
        !hasRunTarget(owner, state)
      ) {
        if (withdrawBellAttempt(store.database, project, job.attempt.id))
          persistEffect(
            tx,
            project,
            unwrap(
              refreshRunTargetWait(
                state,
                { kind: "system", project_id: project },
                { run_id: run.id, withdrawn_attempt_id: job.attempt.id },
                { ids: tx.ids, clock: this.clock },
              ),
            ),
          );
        return false;
      }
      const denied =
        job.run.status !== "running" &&
        this.options.leases?.startBlocked(
          project,
          owner,
          run,
          this.clock.now(),
          job.resourceAccess,
          tx,
        );
      if (denied) {
        this.options.leases?.wait(
          tx,
          project,
          owner,
          run,
          denied,
          this.clock.now(),
        );
        withdrawBellAttempt(store.database, project, job.attempt.id);
        if (run.status === "queued")
          tx.runs.put(project, { ...run, queue_reason: "concurrency_limit" });
        return false;
      }
      if (run?.status === "queued")
        persistEffect(
          tx,
          project,
          unwrap(
            dispatchRun(
              state,
              { kind: "system", project_id: project },
              { run_id: run.id },
              { ids: tx.ids, clock: this.clock },
            ),
          ),
        );
      return true;
    });
  }
  private wakeStatusCurrent(
    state: CommandState,
    job: Job,
    owner: Assignment,
    run: Run,
  ) {
    if (job.run.status !== "running")
      return (
        ["queued", "dispatched"].includes(run.status) ||
        (run.status === "completed" && job.run.status === "completed")
      );
    if (
      this.closing ||
      run.status !== "running" ||
      run.heartbeat_at !== job.run.heartbeat_at ||
      owner.last_mcp_activity_at !== job.assignment.last_mcp_activity_at ||
      this.busy(state, owner, run.id) ||
      !assignmentDependenciesAllowStart(state, owner) ||
      assignmentCardHeld(owner, state, run.trigger_event_id)
    )
      return false;
    const notes = this.options.store.listNotifications({
      project_id: state.project_id,
      ids: job.attempt.notification_ids,
    });
    return (
      notes.length === job.attempt.notification_ids.length &&
      notes.every(
        (n) =>
          n.status === "pending" &&
          !covered(n, state, owner.id) &&
          !notificationBlocked(state, n.event_id, owner.id) &&
          !state.cards.some((c) => c.id === n.card_id && !!c.hold),
      )
    );
  }
  private settle(
    attempt: BellAttempt,
    sent: boolean,
    reason: string,
    bell?: string,
    failure?: DeliveryFailure,
  ) {
    const { store } = this.options,
      { project_id: project, continuation } = attempt;
    store.uow.run((tx) => {
      const at = this.clock.now();
      // A FIFO/slot timeout is proven pre-send. Keep the notification's failed
      // attempt and backoff without recording an ambiguous external send.
      const recorded =
        !sent && continuation && failure?.category === "runtime_queue_timeout"
          ? withdrawBellAttempt(store.database, project, attempt.id)
          : finishBellAttempt(
              store.database,
              project,
              attempt.id,
              sent ? "sent" : "failed",
              at,
            );
      if (!recorded) return;
      const owner = tx.assignments.get(project, attempt.assignment_id);
      if (owner?.snapshot_retry) {
        const { snapshot_retry: _retry, ...cleared } = owner;
        tx.assignments.put(project, cleared);
      }
      let state = this.loadState(tx, project);
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
        state = this.loadState(tx, project);
      }
      const run = state.runs.find((r) => r.id === attempt.run_id);
      const notes = store.listNotifications({
        project_id: project,
        ids: attempt.notification_ids,
      });
      // Only a positively settled first send arms replay. A lost transport ACK,
      // shared-review withdrawal or legacy row stays with the existing recovery policy.
      if (
        sent &&
        !continuation &&
        run?.bell_delivery &&
        run.bell_delivery.run_id === run.id &&
        !run.bell_delivery.sent_at &&
        run.bell_delivery.runtime_ref
      ) {
        tx.runs.put(project, {
          ...run,
          bell_delivery: { ...run.bell_delivery, sent_at: at },
        });
      }
      let failed = !sent && notes.length === 0;
      for (const n of notes) {
        if (!["pending", "belled", "delivery_failed"].includes(n.status))
          continue;
        const acked = covered(n, state, attempt.assignment_id);
        const failedContinuation = !sent && !acked && continuation === true;
        moveNotification(store.database, {
          project_id: project,
          id: n.id,
          event: acked ? "ack" : sent ? "bell" : "deliver_failed",
          at,
          unbind_continuation: failedContinuation,
          patch: {
            ...(failedContinuation ? {} : { run_id: attempt.run_id }),
            attempts: n.attempts + 1,
            ...(bell ? { bell } : {}),
            ...(failedContinuation || (sent && n.card_id)
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
      if (
        !sent &&
        failAutomaticContextRun(
          store,
          project,
          attempt.run_id,
          reason,
          this.clock,
          tx,
        )
      )
        return;
      // C-56: a dispatched Run is retried with backoff and recovered by
      // dispatch-retry; only escalate failures nobody else will handle.
      const recovering =
        continuation ||
        state.events.some(
          (e) =>
            ["run_preparation_recovered", "run_preparation_stalled"].includes(
              e.type,
            ) && payloadString(e.payload, "run_id") === attempt.run_id,
        ) ||
        run?.status === "dispatched" ||
        run?.status === "running" ||
        (run !== undefined && dispatchRecoveryFailed(state, run));
      // A lost acknowledgement (including a crashed sender) cannot certify a
      // failed physical send. Keep attempt-specific evidence for shared review.
      const unconfirmed =
        !attempt.review_wake &&
        !sent &&
        run?.kind === "rework" &&
        (reason === "interrupted_delivery" ||
          (reason === "wake_failed" &&
            failure?.category !== "runtime_queue_timeout"));
      if (failed && !recovering)
        this.escalate(
          tx,
          project,
          notes,
          attempt.assignment_id,
          reason,
          failure,
        );
      else if (((failed && failure) || unconfirmed) && run) {
        // C-68: keep the real cause on the card without alerting anyone.
        const a = state.assignments.find((x) => x.id === attempt.assignment_id);
        if (a)
          deliveryAttemptFailed(tx, state, at, {
            assignment: a,
            run_id: run.id,
            reason,
            error: failure ?? {
              category: "interrupted_delivery",
              message: "Delivery outcome unknown",
            },
            ...(unconfirmed ? { unconfirmed_attempt_id: attempt.id } : {}),
            notification_ids: attempt.notification_ids,
            card_id:
              notes[0]?.card_id ??
              state.work_items.find((w) => w.id === a.work_item_id)?.card_id,
          });
      }
    });
  }
  private schedulePreflightRetry(
    tx: StoreTransactionContext,
    project: ProjectId,
    owner: Assignment,
  ) {
    const failures = (owner.snapshot_retry?.failures ?? 0) + 1;
    if (failures > this.maxRetries) return false;
    const ready_at = new Date(
      Date.parse(this.clock.now()) +
        this.deliveryRetryBaseMs * 2 ** (failures - 1),
    ).toISOString();
    tx.assignments.put(project, {
      ...owner,
      snapshot_retry: { failures, ready_at },
    });
    return true;
  }
  /** Only an explicitly proven pre-send failure may give back a launch reservation. */
  private deferPreflight(job: Job, previous: Run["queue_reason"]) {
    const { store } = this.options,
      { project_id: project } = job.attempt;
    return store.uow.run((tx) => {
      const run = tx.runs.get(project, job.run.id),
        owner = tx.assignments.get(project, job.assignment.id);
      if (
        run?.status !== "queued" ||
        owner?.status !== "active" ||
        owner.external ||
        !sameRef(owner, job.assignment)
      )
        return false;
      if (
        !unfinishedBellAttempts(store.database, project, owner.id).some(
          (a) => a.id === job.attempt.id,
        )
      )
        return true;
      if (!this.closing && !this.schedulePreflightRetry(tx, project, owner))
        return false;
      withdrawBellAttempt(store.database, project, job.attempt.id);
      tx.runs.put(project, {
        ...run,
        queue_reason: previous ?? "runtime_unavailable",
      });
      return true;
    });
  }
  private reject(
    project: ProjectId,
    notes: readonly Notification[],
    a: Assignment,
    reason: string,
    queuedId?: RunId,
    transient = false,
  ) {
    const { store } = this.options;
    return store.uow.run((tx) => {
      let current = store.listNotifications({
        project_id: project,
        ids: notes.map((n) => n.id),
        status: "pending",
      });
      if (reason === "assignment_released" && current.length)
        current = retireCancelledQueueNotes(
          store,
          this.loadState(tx, project),
          a.id,
          current,
          this.clock.now(),
        );
      const queued = queuedId ? tx.runs.get(project, queuedId) : undefined;
      if (
        queuedId &&
        (queued?.status !== "queued" || queued.assignment_id !== a.id)
      )
        return false;
      if (!current.length && !queued) return false;
      if (reason === "snapshot_unavailable") {
        const owner = tx.assignments.get(project, a.id);
        if (
          owner?.status !== "active" ||
          owner.external ||
          !sameRef(owner, a) ||
          owner.snapshot_retry?.ready_at !== a.snapshot_retry?.ready_at ||
          unfinishedBellAttempts(store.database, project, a.id).length > 0
        )
          return false;
        // Another transaction may have started a Run, paused the card or
        // replaced the target while the failed probe was in flight.
        const state = this.loadState(tx, project);
        if (
          this.queued(state, owner)?.id !== queuedId ||
          this.busy(state, owner) ||
          !assignmentDependenciesAllowStart(state, owner) ||
          assignmentCardHeld(owner, state, queued?.trigger_event_id) ||
          !hasRunTarget(owner, state)
        )
          return false;
        if (transient && this.schedulePreflightRetry(tx, project, owner))
          return false;
        if (owner.snapshot_retry) {
          const { snapshot_retry: _retry, ...cleared } = owner;
          tx.assignments.put(project, cleared);
        }
      }
      if (queued) {
        // Removing only queue_reason leaves target/preparation-only candidates runnable.
        persistEffect(
          tx,
          project,
          unwrap(
            abortDispatch(
              this.loadState(tx, project),
              { kind: "system", project_id: project },
              { run_id: queued.id, reason },
              { ids: tx.ids, clock: this.clock },
            ),
          ),
        );
      }
      for (const n of current)
        moveNotification(store.database, {
          project_id: project,
          id: n.id,
          event: "deliver_failed",
          at: this.clock.now(),
        });
      this.escalate(tx, project, current, a.id, reason, undefined, queuedId);
      return true;
    });
  }
  private escalate(
    tx: StoreTransactionContext,
    project: ProjectId,
    notes: readonly Notification[],
    assignment: Assignment["id"],
    reason: string,
    failure?: DeliveryFailure,
    runId?: RunId,
  ) {
    const state = this.loadState(tx, project);
    const a = state.assignments.find((a) => a.id === assignment);
    if (!a) return;
    const launch = runId
      ? state.runs.find((r) => r.id === runId && r.assignment_id === a.id)
      : state.runs.findLast((r) => r.assignment_id === a.id);
    if (
      launch &&
      failAutomaticContextRun(
        this.options.store,
        project,
        launch.id,
        reason,
        this.clock,
        tx,
      )
    )
      return;
    dispatchAlert(tx, this.options.store, state, this.clock.now(), {
      assignment: a,
      type: "bell_delivery_failed",
      reason,
      audience: alertAudience(a, state, this.options.standing, notes),
      card_id:
        notes[0]?.card_id ??
        state.work_items.find((w) => w.id === a.work_item_id)?.card_id,
      notification_ids: notes.map((n) => n.id),
      run_id: runId ?? notes[0]?.run_id,
      ...(failure ? { error: failure } : {}),
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
    // C-244: sub-spans of `route.maintenance`; timing only, no added await.
    const step = <T>(name: string, run: () => T) =>
      profileSpanSync(`route.maintenance.${name}`, run);
    store.uow.run((tx) => {
      const at = this.clock.now();
      const prior = this.loadState(tx, project);
      const expired = unwrap(
        expireMergeSnoozes(
          prior,
          { kind: "system", project_id: project },
          { clock: { now: () => at }, ids: tx.ids },
        ),
      );
      persistEffect(tx, project, expired);
      const state = expired.changes.length
        ? this.loadState(tx, project)
        : prior;
      persistEffect(
        tx,
        project,
        unwrap(
          resolveDispatchAttention(
            state,
            { kind: "system", project_id: project },
            { clock: this.clock, ids: tx.ids },
          ),
        ),
      );
      step("obsolete", () => {
        for (const n of store.listNotifications({
          // C-244: acked/resolved rows are never obsolete attention.
          project_id: project,
          statuses: UNSETTLED_NOTIFICATION_STATUSES,
        })) {
          if (obsoleteDispatchAttention(state, n))
            moveNotification(store.database, {
              project_id: project,
              id: n.id,
              event: "resolve",
              at,
            });
        }
      });
      step("review_limit", () =>
        escalateReviewLimitWaits(tx, store, state, at),
      );
      step("merge_stalls", () => escalatePmMergeStalls(tx, store, state, at));
      const attempts = unfinishedBellAttempts(store.database, project);
      // C-244: this loop writes notifications and alert events only; tokens
      // and Assignments stay as read, so one standing resolution per kind.
      const standingOnce = memoStanding(standing);
      step("queued_patrol", () =>
        this.queuedRunPatrol.sweep(tx, state, at, attempts),
      );
      step("belled", () => {
        for (const n of store.listNotifications({
          project_id: project,
          statuses: ["belled", "delivery_failed"],
        })) {
          if (
            (!n.card_id && n.status === "belled") ||
            !n.next_attempt_at ||
            n.next_attempt_at > at
          )
            continue;
          const owner = notificationOwner(n, state, standingOnce),
            a = state.assignments.find((a) => a.id === owner);
          if (
            a?.status !== "active" ||
            a.external ||
            !hasRunTarget(a, state) ||
            (n.status === "delivery_failed"
              ? !!n.run_id &&
                !runsOf(state.runs, a.id).some(
                  (r) => r.id === n.run_id && r.status === "running",
                )
              : runsOf(state.runs, a.id).some(unfinishedRun)) ||
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
      });
      step("inactive_runs", () => this.inactivityAlerts.tick(tx, state, at));
    });
  }
}
