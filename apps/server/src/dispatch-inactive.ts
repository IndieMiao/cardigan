import type {
  Assignment,
  Clock,
  CommandState,
  ProjectId,
  Run,
  Runtime,
} from "@cardigan/domain";
import {
  claimInactiveRunStop,
  finishInactiveRunStop,
  type HarnessActivity,
  inactiveRunDue,
  lastInactiveStopActivity,
  startInactiveRunStop,
} from "@cardigan/domain";
import type { HarnessActivityInspection } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import type { StateLoader } from "./dispatch-state.js";
import { runStopWorkflow } from "./dispatch-stop.js";

interface ReaperOptions {
  loadState?: StateLoader;
  store: Store;
  runtime: Runtime;
  clock: Clock;
  afterMs: number | null;
  inspectionPending?: (project: ProjectId, run: Run["id"]) => boolean;
  inspectHarnessActivity?: (
    project: ProjectId,
    assignment: Assignment["id"],
  ) => Promise<ReadonlyMap<Assignment["id"], HarnessActivityInspection>>;
  onError?: (error: unknown) => void;
  onUnknown?: (
    project: ProjectId,
    assignment: Assignment,
    run: Run,
    inspection: HarnessActivityInspection,
  ) => void;
  harnessActivity?: (
    project: ProjectId,
    assignment: Assignment["id"],
  ) => HarnessActivity | undefined;
  alert(
    tx: StoreTransactionContext,
    state: CommandState,
    assignment: Assignment,
    run: Run,
    reason: string,
  ): void;
}

/** Q-86: supply inactivity eligibility and settlement to the shared stop workflow. */
export class InactiveRunReaper {
  private readonly remoteStops = new Map<string, Promise<void>>();
  private closed = false;
  constructor(private readonly options: ReaperOptions) {}
  async close() {
    this.closed = true;
    await Promise.all(this.remoteStops.values());
  }
  async tick(projects: readonly ProjectId[]) {
    const afterMs = this.options.afterMs;
    if (afterMs === null) return;
    for (const project of projects) {
      const state = this.options.store.uow.read((tx) =>
        (this.options.loadState ?? loadCommandState)(tx, project),
      );
      const owners = new Map(state.assignments.map((a) => [a.id, a]));
      for (const run of state.runs) {
        if (this.closed) return;
        // Terminal history cannot become inactive; unfinished stop fences still settle.
        if (!run.inactivity_stop && run.status !== "running") continue;
        if (
          !run.inactivity_stop &&
          this.options.inspectionPending?.(project, run.id)
        )
          continue;
        const a = owners.get(run.assignment_id);
        const cached = () =>
          this.options.harnessActivity?.(project, run.assignment_id);
        const now = this.options.clock.now();
        if (
          !a ||
          a.external ||
          (!run.inactivity_stop &&
            !inactiveRunDue(
              run,
              a,
              now,
              afterMs,
              lastInactiveStopActivity(state, run, a, now, cached()),
            ))
        )
          continue;
        if (a.machine_id === "local") {
          await this.reap(project, a, run, afterMs, cached);
          continue;
        }
        // Neither stop-time read (nor a slow runtime status) owns the global tick.
        const key = `${project}/${run.id}`;
        if (this.remoteStops.has(key)) continue;
        const pending = this.reap(project, a, run, afterMs, cached)
          .catch((error) => this.options.onError?.(error))
          .finally(() => this.remoteStops.delete(key));
        this.remoteStops.set(key, pending);
      }
    }
  }
  private async reap(
    project: ProjectId,
    a: Assignment,
    run: Run,
    afterMs: number,
    cached: () => HarnessActivity | undefined,
  ) {
    let inspected: HarnessActivity | undefined;
    const refresh = async () => {
      inspected = undefined;
      if (this.closed) return;
      let row: HarnessActivityInspection | undefined;
      try {
        row = (await this.options.inspectHarnessActivity?.(project, a.id))?.get(
          a.id,
        );
      } catch {
        row = { status: "read_failed" };
      }
      if (this.closed) return;
      if (row?.status === "stale" || row?.status === "fresh")
        inspected = row.activity;
      else
        this.options.onUnknown?.(project, a, run, row ?? { status: "missing" });
    };
    const needsInspection =
      run.harness === "claude-code" || a.machine_id !== "local";
    if (needsInspection) await refresh();
    if (this.closed) return;
    const sample = () =>
      this.closed ? undefined : needsInspection ? inspected : cached();
    const actor = { kind: "system" as const, project_id: project };
    await runStopWorkflow(this.options, project, {
      claim: (s, p) =>
        claimInactiveRunStop(
          s,
          actor,
          { run_id: run.id, after_ms: afterMs, harness_activity: sample() },
          p,
        ),
      ...(needsInspection ? { beforeStart: refresh } : {}),
      fence: (r) => r.inactivity_stop,
      start: (s, p, r, stop) =>
        startInactiveRunStop(
          s,
          actor,
          {
            run_id: r.id,
            attempt_id: stop.attempt_id,
            after_ms: afterMs,
            harness_activity: sample(),
          },
          p,
        ),
      finish: (s, p, r, stop, exited) =>
        exited
          ? finishInactiveRunStop(
              s,
              actor,
              {
                run_id: r.id,
                attempt_id: stop.attempt_id,
                runtime_ref: stop.runtime_ref,
                exited,
              },
              p,
            )
          : undefined,
      afterSettle: (tx, s, current, _stop, effect) => {
        const a = s.assignments.find((a) => a.id === current.assignment_id);
        if (!a || (effect && !effect.data)) return;
        this.options.alert(
          tx,
          s,
          a,
          current,
          effect ? "inactive_stop_confirmed" : "inactive_stop_unconfirmed",
        );
      },
    });
  }
}
