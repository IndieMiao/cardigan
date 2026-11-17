import {
  type Assignment,
  type Clock,
  type CommandState,
  currentHarnessActivity,
  type HarnessActivity,
  harnessActivityTime,
  lastRunActivity,
  type ProjectId,
  type Run,
} from "@cardigan/domain";
import type { HarnessActivityInspection } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { alertAudience, dispatchAlert } from "./dispatch-alert.js";
import type { StandingResolver } from "./dispatch-inbox.js";

interface Options {
  store: Store;
  clock: Clock;
  graceMs: number;
  standing?: StandingResolver;
  harnessActivity?: (
    project: ProjectId,
    assignment: Assignment["id"],
  ) => HarnessActivity | undefined;
  inspectHarnessActivity?: (
    project: ProjectId,
  ) => Promise<ReadonlyMap<Assignment["id"], HarnessActivityInspection>>;
  inspectionTimeoutMs?: number;
  onError?: (error: unknown) => void;
}
type Target = { assignment: Assignment; run: Run };
type Check = "completed" | "read_failed" | "timeout" | "unavailable";

/** Bounded diagnostic recheck before a Run's existing, durable one-shot alert. */
export class InactivityAlerts {
  private readonly polls = new Map<
    ProjectId,
    { targets: Map<Run["id"], Target>; cancel: () => void }
  >();
  private closed = false;
  private readonly timeoutMs: number;
  constructor(private readonly options: Options) {
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
    return this.polls.get(project)?.targets.has(run) ?? false;
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
      Date.parse(at) -
        lastRunActivity(
          run,
          a,
          harnessActivityTime(currentHarnessActivity(state, a, at, sample)),
        ) >=
        this.options.graceMs &&
      !state.events.some(
        (e) =>
          e.type === "run_inactive" &&
          (e.payload as { run_id?: string }).run_id === run.id,
      )
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
      if (!assignment || !this.due(state, assignment, run, at, sample))
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
      } else targets.set(run.id, { assignment, run });
    }
    if (!targets.size) return;
    const pending = this.polls.get(project);
    if (pending) return;
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
      this.polls.delete(project);
      this.options.store.uow.run((currentTx) => {
        const current = loadCommandState(currentTx, project);
        const now = this.options.clock.now();
        for (const {
          assignment: expected,
          run: expectedRun,
        } of targets.values()) {
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
    };
    timer = setTimeout(() => {
      try {
        finish(undefined, "timeout");
      } catch (error) {
        this.options.onError?.(error);
      }
    }, this.timeoutMs);
    timer.unref();
    this.polls.set(project, {
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
          : this.options.inspectHarnessActivity?.(project),
      )
      .then(
        (samples) => finish(samples, "completed"),
        () => finish(undefined, "read_failed"),
      )
      .catch((error) => this.options.onError?.(error));
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
    const sample =
      inspection.status === "read_failed" ? undefined : inspection.activity;
    if (!this.due(state, a, run, at, sample)) return;
    const activity = currentHarnessActivity(state, a, at, sample);
    dispatchAlert(tx, this.options.store, state, at, {
      assignment: a,
      type: "run_inactive",
      reason: "mcp_inactivity",
      activity_source: activity?.source ?? "活动来源缺失",
      activity_status: activity
        ? "fresh"
        : sample && inspection.status === "fresh"
          ? Date.parse(at) - Date.parse(sample.updated_at) >
              sample.stale_after_ms ||
            Date.parse(at) < Date.parse(sample.updated_at)
            ? "stale"
            : "unassociated"
          : inspection.status,
      activity_check: check,
      mark: true,
      audience: alertAudience(a, state, this.options.standing),
      run_id: run.id,
      card_id: state.work_items.find((w) => w.id === a.work_item_id)?.card_id,
    });
  }
}
