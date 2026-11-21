import {
  type Assignment,
  associatedHarnessActivity,
  type Clock,
  type CommandState,
  DEFAULT_INBOX_STALL_AFTER_MS,
  eventsOfType,
  type HarnessActivity,
  lastInactiveStopActivity,
  lastRunActivity,
  type ProjectId,
  type Run,
} from "@cardigan/domain";
import type { HarnessActivityInspection } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { HerdrRuntime } from "@cardigan/runtime-herdr";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { alertAudience, dispatchAlert } from "./dispatch-alert.js";
import type { StandingResolver } from "./dispatch-inbox.js";
import {
  type TerminalEvidence,
  TerminalHistory,
} from "./dispatch-terminal-evidence.js";

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
  runtime: Partial<Pick<HerdrRuntime, "terminalActivity">>;
  inspectionTimeoutMs?: number;
  onError?: (error: unknown) => void;
}
function recorded(state: CommandState, run: Run, type: string) {
  return eventsOfType(state.events, type).some(
    (e) => (e.payload as { run_id?: string }).run_id === run.id,
  );
}
type Target = { assignment: Assignment; run: Run };
type Check = "completed" | "read_failed" | "timeout" | "unavailable";

/** Bounded diagnostic recheck before a Run's existing, durable one-shot alert. */
export class InactivityAlerts {
  private readonly polls = new Map<
    string,
    { targets: Map<Run["id"], Target>; cancel: () => void }
  >();
  private readonly terminals = new TerminalHistory();
  private readonly nextRead = new Map<string, number>();
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
      Date.parse(at) -
        (lastInactiveStopActivity(state, run, a, at, sample) ??
          lastRunActivity(run, a)) >=
        this.options.graceMs
    );
  }
  tick(tx: StoreTransactionContext, state: CommandState, at: string) {
    if (this.closed) return;
    const project = state.project_id;
    const running = new Set<string>(
      state.runs.filter((r) => r.status === "running").map((r) => r.id),
    );
    this.terminals.retain(project, running);
    for (const key of this.nextRead.keys())
      if (
        key.startsWith(`${project}/`) &&
        !running.has(key.slice(project.length + 1))
      )
        this.nextRead.delete(key);
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
      const key = `${project}/${run.id}`;
      if (
        recorded(state, run, "run_inactive") ||
        Date.parse(at) < (this.nextRead.get(key) ?? 0)
      )
        continue;
      if (
        !this.options.inspectHarnessActivity &&
        !this.options.runtime.terminalActivity
      ) {
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
      } else if (
        assignment.machine_id !== "local" ||
        this.options.runtime.terminalActivity
      ) {
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
    let terminal: TerminalEvidence | undefined;
    let partial:
      | ReadonlyMap<Assignment["id"], HarnessActivityInspection>
      | undefined;
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
      this.publish(
        project,
        targets.values(),
        samples ?? partial,
        check,
        terminal,
      );
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
      .then(async () => {
        if (this.closed) return;
        const single = target && targets.values().next().value;
        const read = this.options.runtime.terminalActivity;
        const transcript = this.options
          .inspectHarnessActivity?.(project, target, localOnly)
          ?.then((samples) => {
            partial = samples;
          });
        const output =
          single?.assignment.runtime_ref && read
            ? read
                .call(
                  this.options.runtime,
                  single.assignment.runtime_ref,
                  project,
                  single.assignment.id,
                )
                .then((result) => {
                  if (!cancelled && !this.closed)
                    terminal = this.terminals.observe(
                      project,
                      single.run,
                      single.assignment,
                      Date.parse(this.options.clock.now()),
                      result,
                    );
                })
            : undefined;
        const results = await Promise.allSettled([transcript, output]);
        finish(
          partial,
          results[0]?.status === "rejected" ? "read_failed" : "completed",
        );
      })
      .catch((error) => this.options.onError?.(error));
  }
  private publish(
    project: ProjectId,
    targets: Iterable<Target>,
    samples:
      | ReadonlyMap<Assignment["id"], HarnessActivityInspection>
      | undefined,
    check: Check,
    terminal?: TerminalEvidence,
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
        this.nextRead.set(
          `${project}/${run.id}`,
          Date.parse(now) + Math.min(30_000, this.options.graceMs),
        );
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
          terminal,
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
    terminal?: TerminalEvidence,
  ) {
    if (!this.due(state, a, run, at) || recorded(state, run, "run_inactive"))
      return;
    const now = Date.parse(at);
    // A failed/slow terminal recheck cannot erase output just witnessed for this Run.
    if (
      !terminal &&
      this.terminals.interrupted(
        state.project_id,
        run,
        a,
        now,
        this.options.graceMs,
      )
    )
      return;
    const associated = (sample: HarnessActivity | undefined, kind: string) =>
      run.harness && sample?.source !== `${run.harness}:${kind}`
        ? undefined
        : associatedHarnessActivity(state, a, at, sample);
    const activity = ["fresh", "stale"].includes(inspection.status)
      ? associated(inspection.activity, "session_metadata")
      : undefined;
    const file = associated(inspection.fileActivity, "transcript_mtime");
    const progress = activity?.error
      ? activity.last_progress_at &&
        associated(
          { ...activity, updated_at: activity.last_progress_at },
          "session_metadata",
        )
      : activity;
    const evidence = [progress, file]
      .filter((v): v is HarnessActivity => !!v)
      .sort((l, r) => Date.parse(r.updated_at) - Date.parse(l.updated_at))[0];
    if (
      (evidence &&
        now - Date.parse(evidence.updated_at) < this.options.graceMs) ||
      (terminal && now - terminal.observedSince < this.options.graceMs)
    )
      return;
    const card_id = state.work_items.find(
      (w) => w.id === a.work_item_id,
    )?.card_id;
    if (!evidence && !terminal && !activity?.error) {
      const remote = a.machine_id !== "local";
      const type = remote
        ? "run_remote_activity_missing"
        : "run_local_activity_missing";
      const reason = remote ? "远程活动来源缺失" : "本机活动来源缺失";
      if (!recorded(state, run, type))
        dispatchAlert(tx, this.options.store, state, at, {
          assignment: a,
          run_id: run.id,
          card_id,
          type,
          reason,
          activity_source: reason,
          activity_status:
            inspection.status === "fresh" || inspection.status === "stale"
              ? "unassociated"
              : inspection.status,
          activity_check: check,
          audience: "activity_log",
        });
      return;
    }
    const since =
      inspection.foreground && Date.parse(inspection.foreground.since);
    const fg =
      inspection.foreground &&
      (file || activity) &&
      typeof since === "number" &&
      since <= now &&
      since >= Date.parse(run.started_at ?? a.created_at)
        ? { command: inspection.foreground.command, since }
        : terminal?.foreground;
    dispatchAlert(tx, this.options.store, state, at, {
      assignment: a,
      type: "run_inactive",
      reason: fg
        ? `前台命令 ${fg.command} 已运行至少 ${Math.floor((now - fg.since) / 60_000)} 分钟，无近期输出`
        : "mcp_inactivity",
      activity_source:
        evidence?.source ?? activity?.source ?? "terminal_output",
      activity_status: "stale",
      notifyHostOps: true,
      activity_check: check,
      mark: true,
      audience: alertAudience(a, state, this.options.standing),
      run_id: run.id,
      card_id,
    });
  }
}
