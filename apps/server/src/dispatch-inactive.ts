import type {
  Assignment,
  Clock,
  CommandEffect,
  CommandPorts,
  CommandState,
  ProjectId,
  Result,
  Run,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import {
  claimInactiveRunStop,
  finishInactiveRunStop,
  inactiveRunDue,
  startInactiveRunStop,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";

interface ReaperOptions {
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
const exited = (result: Awaited<ReturnType<Runtime["status"]>> | undefined) =>
  result?.ok
    ? result.value.process === "exited"
    : result?.error.code === "runtime_not_found";

/** q(86): stop first, prove exit, then cancel and revoke in one transaction. */
export class InactiveRunReaper {
  constructor(private readonly options: ReaperOptions) {}
  private state(project: ProjectId) {
    return this.options.store.uow.read((tx) => loadCommandState(tx, project));
  }
  private apply<T>(
    project: ProjectId,
    reduce: (
      state: CommandState,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>,
  ): T {
    return this.options.store.uow.run((tx) => {
      const effect = unwrap(
        reduce(loadCommandState(tx, project), {
          ids: tx.ids,
          clock: this.options.clock,
        }),
      );
      persistEffect(tx, project, effect);
      return effect.data;
    });
  }
  async tick(projects: readonly ProjectId[]) {
    const afterMs = this.options.afterMs;
    if (afterMs === null) return;
    for (const project of projects) {
      const state = this.state(project);
      for (const run of state.runs) {
        const a = state.assignments.find((a) => a.id === run.assignment_id);
        if (
          !a ||
          (!run.inactivity_stop &&
            !inactiveRunDue(run, a, this.options.clock.now(), afterMs))
        )
          continue;
        const actor = { kind: "system" as const, project_id: project };
        const claimed = this.apply(project, (s, p) =>
          claimInactiveRunStop(
            s,
            actor,
            { run_id: run.id, after_ms: afterMs },
            p,
          ),
        );
        if (!claimed?.inactivity_stop) continue;
        await this.stop(project, claimed, afterMs);
      }
    }
  }
  private async observe(ref: RuntimeRef) {
    return this.options.runtime.status(ref).catch(() => undefined);
  }
  private async stop(project: ProjectId, run: Run, afterMs: number) {
    const stop = run.inactivity_stop;
    if (!stop) return;
    const actor = { kind: "system" as const, project_id: project };
    const before = await this.observe(stop.runtime_ref);
    // A previously issued stop may complete during a crash/restart or after
    // fresh MCP traffic. Once exit is proven, finish only that fenced Run.
    if (!(stop.stopping && exited(before))) {
      const fresh = this.apply(project, (s, p) =>
        startInactiveRunStop(
          s,
          actor,
          {
            run_id: run.id,
            attempt_id: stop.attempt_id,
            after_ms: afterMs,
          },
          p,
        ),
      );
      if (!fresh) return;
      if (!exited(before)) {
        // Even an error can mean that release took effect. Always check status
        // separately; alive, unknown, timeout and runtime_unavailable are not proof.
        await this.options.runtime
          .release(stop.runtime_ref, { force: true })
          .catch(() => undefined);
        const after = await this.observe(stop.runtime_ref);
        if (!exited(after)) {
          this.options.store.uow.run((tx) => {
            const state = loadCommandState(tx, project);
            const current = state.runs.find((r) => r.id === run.id);
            const a = state.assignments.find((a) => a.id === run.assignment_id);
            if (a && current?.inactivity_stop?.attempt_id === stop.attempt_id)
              this.options.alert(
                tx,
                state,
                a,
                current,
                "inactive_stop_unconfirmed",
              );
          });
          return;
        }
      }
    }
    this.options.store.uow.run((tx) => {
      const state = loadCommandState(tx, project);
      const effect = unwrap(
        finishInactiveRunStop(
          state,
          actor,
          {
            run_id: run.id,
            attempt_id: stop.attempt_id,
            runtime_ref: stop.runtime_ref,
            exited: true,
          },
          { ids: tx.ids, clock: this.options.clock },
        ),
      );
      persistEffect(tx, project, effect);
      if (!effect.data) return;
      for (const token of tx.tokensForAssignment(project, run.assignment_id))
        if (token.revoked_at === null && !tx.revokeToken(token.id))
          throw new Error("Inactive Run token revocation failed");
      const a = state.assignments.find((a) => a.id === run.assignment_id);
      if (a)
        this.options.alert(
          tx,
          state,
          a,
          effect.data,
          "inactive_stop_confirmed",
        );
    });
  }
}
