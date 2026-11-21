import {
  type Assignment,
  associatedHarnessActivity,
  type Clock,
  type CommandState,
  currentHarnessActivity,
  DEFAULT_INBOX_STALL_AFTER_MS,
  eventsOfType,
  type HarnessActivity,
  lastInactiveStopActivity,
  lastRunActivity,
  type ProjectId,
  type Run,
  unreceivedBell,
} from "@cardigan/domain";
import type { HarnessActivityInspection } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import {
  alertAudience,
  dispatchAlert,
  hostOpsAlertRecipient,
} from "./dispatch-alert.js";
import type { StandingResolver } from "./dispatch-inbox.js";

interface Options {
  store: Store;
  clock: Clock;
  graceMs: number;
  inboxStallAfterMs?: number;
  standing?: StandingResolver;
  harnessActivity?: (
    project: ProjectId,
    assignment: Assignment["id"],
  ) => HarnessActivity | undefined;
  inspectHarnessActivity?: (
    project: ProjectId,
    target?: Assignment["id"],
    localOnly?: boolean,
  ) => Promise<ReadonlyMap<Assignment["id"], HarnessActivityInspection>>;
  inspectionTimeoutMs?: number;
  onError?: (error: unknown) => void;
}
const missingWorkerSource = (state: CommandState, run: Run) =>
  eventsOfType(state.events, "run_remote_activity_missing").some(
    (e) => (e.payload as { run_id?: string }).run_id === run.id,
  );

type Target = { assignment: Assignment; run: Run };
type Check = "completed" | "read_failed" | "timeout" | "unavailable";

// The initial alert and an eventual host handoff have separate durable identities.
function alertState(state: CommandState, run: Run) {
  let alerted = false;
  for (const event of state.events) {
    if (event.type !== "run_inactive" && event.type !== "run_activity_unknown")
      continue;
    const payload = event.payload as {
      run_id?: string;
      activity_forwarded_to?: string;
    };
    if (payload.run_id !== run.id) continue;
    if (payload.activity_forwarded_to) return "forwarded";
    alerted = true;
  }
  return alerted ? "alerted" : "new";
}

/** Bounded diagnostic recheck before a Run's existing, durable one-shot alert. */
export class InactivityAlerts {
  private readonly polls = new Map<
    string,
    { targets: Map<Run["id"], Target>; cancel: () => void }
  >();
  private closed = false;
  private readonly timeoutMs: number;
  private readonly stallMs: number;
  constructor(private readonly options: Options) {
    this.stallMs = options.inboxStallAfterMs ?? DEFAULT_INBOX_STALL_AFTER_MS;
    if (!Number.isSafeInteger(this.stallMs) || this.stallMs < 1)
      throw new Error("Invalid inbox stall threshold");
    this.timeoutMs = options.inspectionTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 2_147_483_647
    )
      throw new Error("Invalid inactivity inspection timeout");
  }

  close() {
    this.closed = true;
    for (const poll of this.polls.values()) poll.cancel();
    this.polls.clear();
  }
  pending(project: ProjectId, run: Run["id"]) {
    return (
      this.polls.has(`${project}/${run}`) ||
      (this.polls.get(project)?.targets.has(run) ?? false)
    );
  }
  private due(
    state: CommandState,
    a: Assignment,
    run: Run,
    at: string,
    sample?: HarnessActivity,
  ) {
    return (
      a.status === "active" &&
      !a.external &&
      run.status === "running" &&
      !unreceivedBell(run)?.retry_at &&
      Date.parse(at) -
        (lastInactiveStopActivity(state, run, a, at, sample) ??
          lastRunActivity(run, a)) >=
        this.options.graceMs
    );
  }
  tick(tx: StoreTransactionContext, state: CommandState, at: string) {
    if (this.closed) return;
    const project = state.project_id;
    const targets = new Map<Run["id"], Target>();
    for (const run of state.runs) {
      if (run.status !== "running") continue;
      const assignment = state.assignments.find(
        (a) => a.id === run.assignment_id,
      );
      const sample = this.options.harnessActivity?.(project, run.assignment_id);
      if (
        assignment?.scope === "work_item" &&
        assignment.status === "active" &&
        !assignment.external &&
        Date.parse(at) - lastRunActivity(run, assignment) >= this.stallMs
      ) {
        const item = state.work_items.find(
          (w) =>
            w.id === assignment.work_item_id &&
            w.assignment_id === assignment.id,
        );
        if (
          item?.status === "in_progress" &&
          !eventsOfType(state.events, "run_inbox_stalled").some(
            (e) => (e.payload as { run_id?: string }).run_id === run.id,
          )
        ) {
          const backlog = this.options.store.listNotifications({
            project_id: project,
            assignment_id: assignment.id,
            statuses: ["pending", "delivery_failed"],
          });
          if (backlog.length) {
            const ended = associatedHarnessActivity(
              state,
              assignment,
              at,
              sample,
            )?.turn_ended;
            dispatchAlert(tx, this.options.store, state, at, {
              type: "run_inbox_stalled",
              reason: `工作项运行中，已至少 ${Math.ceil(this.stallMs / 60_000)} 分钟没有 MCP 活动，仍有通知待送达${ended ? "。最近的会话记录显示回合已结束，不能据此确认当前空闲" : ""}`,
              audience: "ops",
              assignment,
              run_id: run.id,
              card_id: item.card_id,
              notification_ids: backlog.map((n) => n.id),
            });
          }
        }
      }
      if (!assignment || !this.due(state, assignment, run, at, sample))
        continue;
      const prior = alertState(state, run);
      if (assignment.machine_id !== "local") {
        // The patrol will supply a new sample if a source becomes reachable.
        const missing = missingWorkerSource(state, run);
        if (
          (missing && this.options.harnessActivity && !sample) ||
          (prior !== "new" &&
            (missing ||
              associatedHarnessActivity(state, assignment, at, sample)))
        )
          continue;
      } else if (
        prior === "forwarded" ||
        (prior === "alerted" &&
          (run.harness !== "claude-code" ||
            !hostOpsAlertRecipient(state, assignment) ||
            associatedHarnessActivity(state, assignment, at, sample)))
      )
        continue;
      if (!this.options.inspectHarnessActivity) {
        this.alert(
          tx,
          state,
          assignment,
          run,
          at,
          {
            status: sample ? "stale" : "missing",
            ...(sample ? { activity: sample } : {}),
          },
          "unavailable",
        );
      } else if (assignment.machine_id !== "local") {
        // Each SSH read has its own deadline. A slow worker must not time out
        // a healthy peer or the existing local project-wide recheck.
        this.inspect(
          project,
          new Map([[run.id, { assignment, run }]]),
          `${project}/${run.id}`,
          assignment.id,
        );
      } else targets.set(run.id, { assignment, run });
    }
    if (!targets.size) return;
    const mixed = state.assignments.some(
      (a) => a.status === "active" && !a.external && a.machine_id !== "local",
    );
    this.inspect(project, targets, project, undefined, mixed);
  }
  private inspect(
    project: ProjectId,
    targets: Map<Run["id"], Target>,
    key: string,
    target?: Assignment["id"],
    localOnly = false,
  ) {
    const pending = this.polls.get(key);
    if (pending) {
      // Join the existing deadline without replacing captured session generations.
      for (const [id, target] of targets)
        if (!pending.targets.has(id)) pending.targets.set(id, target);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const finish = (
      samples:
        | ReadonlyMap<Assignment["id"], HarnessActivityInspection>
        | undefined,
      check: Check,
    ) => {
      if (cancelled || this.closed) return;
      cancelled = true;
      clearTimeout(timer);
      this.polls.delete(key);
      this.publish(project, targets.values(), samples, check);
    };
    timer = setTimeout(() => {
      try {
        finish(undefined, "timeout");
      } catch (error) {
        this.options.onError?.(error);
      }
    }, this.timeoutMs);
    timer.unref();
    this.polls.set(key, {
      targets,
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
      },
    });
    // Start outside the caller's write transaction; the host shares any active poll.
    void Promise.resolve()
      .then(() =>
        this.closed
          ? undefined
          : this.options.inspectHarnessActivity?.(project, target, localOnly),
      )
      .then(
        (samples) => finish(samples, "completed"),
        () => finish(undefined, "read_failed"),
      )
      .catch((error) => this.options.onError?.(error));
  }
  // The stop-time read may discover a lost transcript before the patrol cache changes.
  publish(
    project: ProjectId,
    targets: Iterable<Target>,
    samples:
      | ReadonlyMap<Assignment["id"], HarnessActivityInspection>
      | undefined,
    check: Check,
  ) {
    if (this.closed) return;
    this.options.store.uow.run((currentTx) => {
      const current = loadCommandState(currentTx, project);
      const now = this.options.clock.now();
      for (const { assignment: expected, run: expectedRun } of targets) {
        const a = current.assignments.find((a) => a.id === expected.id);
        const run = current.runs.findLast(
          (r) => r.assignment_id === expected.id,
        );
        // A late read cannot settle an alert for a successor session/Run.
        if (
          !a ||
          run?.id !== expectedRun.id ||
          JSON.stringify(a.runtime_ref) !==
            JSON.stringify(expected.runtime_ref) ||
          a.session_ref !== expected.session_ref
        )
          continue;
        this.alert(
          currentTx,
          current,
          a,
          run,
          now,
          samples?.get(a.id) ?? {
            status: check === "read_failed" ? "read_failed" : "missing",
          },
          check,
        );
      }
    });
  }
  private alert(
    tx: StoreTransactionContext,
    state: CommandState,
    a: Assignment,
    run: Run,
    at: string,
    inspection: HarnessActivityInspection,
    check: Check,
  ) {
    const remote = a.machine_id !== "local";
    const needsEvidence = remote || run.harness === "claude-code";
    const unknown = !["fresh", "stale"].includes(inspection.status);
    const sample =
      inspection.status === "read_failed" || (needsEvidence && unknown)
        ? undefined
        : inspection.activity;
    if (!this.due(state, a, run, at, sample)) return;
    const activity = currentHarnessActivity(state, a, at, sample);
    const associated = needsEvidence
      ? associatedHarnessActivity(state, a, at, sample)
      : activity;
    let status = inspection.status;
    if (activity) status = "fresh";
    else if (needsEvidence && !unknown)
      status = associated ? "stale" : "unassociated";
    else if (sample && status === "fresh") {
      const age = Date.parse(at) - Date.parse(sample.updated_at);
      status =
        age < 0 || age > sample.stale_after_ms ? "stale" : "unassociated";
    }
    const prior = alertState(state, run);
    if (
      remote &&
      (!associated || associated.source !== `${run.harness}:session_metadata`)
    ) {
      if (!missingWorkerSource(state, run))
        dispatchAlert(tx, this.options.store, state, at, {
          assignment: a,
          run_id: run.id,
          card_id: state.work_items.find((w) => w.id === a.work_item_id)
            ?.card_id,
          type: "run_remote_activity_missing",
          reason: "远程活动来源缺失",
          activity_source: "远程活动来源缺失",
          activity_status: status,
          activity_check: check,
          audience: "activity_log",
        });
      return;
    }
    const forward =
      !remote && needsEvidence && status !== "stale" && status !== "fresh";
    if (prior === "forwarded" || (prior === "alerted" && !forward)) return;
    dispatchAlert(tx, this.options.store, state, at, {
      assignment: a,
      type: prior === "new" ? "run_inactive" : "run_activity_unknown",
      reason: "mcp_inactivity",
      activity_source: associated?.source ?? "活动来源缺失",
      activity_status: status,
      notifyHostOps: forward,
      activity_check: check,
      mark: prior === "new",
      audience:
        prior === "new"
          ? alertAudience(a, state, this.options.standing)
          : "host_ops_only",
      run_id: run.id,
      card_id: state.work_items.find((w) => w.id === a.work_item_id)?.card_id,
    });
  }
}
