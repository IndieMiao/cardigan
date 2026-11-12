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
  inactiveRunDue,
  startInactiveRunStop,
} from "@cardigan/domain";
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
  constructor(private readonly options: ReaperOptions) {}
  async tick(projects: readonly ProjectId[]) {
    const afterMs = this.options.afterMs;
    if (afterMs === null) return;
    for (const project of projects) {
      const state = this.options.store.uow.read((tx) =>
        (this.options.loadState ?? loadCommandState)(tx, project),
      );
      for (const run of state.runs) {
        const a = state.assignments.find((a) => a.id === run.assignment_id);
        if (
          !a ||
          a.external ||
          (!run.inactivity_stop &&
            !inactiveRunDue(run, a, this.options.clock.now(), afterMs))
        )
          continue;
        const actor = { kind: "system" as const, project_id: project };
        await runStopWorkflow(this.options, project, {
          claim: (s, p) =>
            claimInactiveRunStop(
              s,
              actor,
              { run_id: run.id, after_ms: afterMs },
              p,
            ),
          fence: (r) => r.inactivity_stop,
          start: (s, p, r, stop) =>
            startInactiveRunStop(
              s,
              actor,
              {
                run_id: r.id,
                attempt_id: stop.attempt_id,
                after_ms: afterMs,
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
  }
}
