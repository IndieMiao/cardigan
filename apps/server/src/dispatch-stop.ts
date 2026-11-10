import type {
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
import { revokeStoppedRunTokens, stopRunRuntime } from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";

interface StopIntent {
  attempt_id: string;
  runtime_ref: RuntimeRef | null;
  stopping: boolean;
}

/** Both recovery policies use the same claim, stop, exit proof and atomic settlement. */
export async function runStopWorkflow<S extends StopIntent>(
  options: { store: Store; runtime: Runtime; clock: Clock },
  project: ProjectId,
  policy: {
    claim(
      state: CommandState,
      ports: CommandPorts,
    ): Result<CommandEffect<Run | undefined>> | undefined;
    fence(run: Run): S | undefined;
    start(
      state: CommandState,
      ports: CommandPorts,
      run: Run,
      stop: S,
    ): Result<CommandEffect<unknown>>;
    finish(
      state: CommandState,
      ports: CommandPorts,
      run: Run,
      stop: S,
      exited: boolean,
    ): Result<CommandEffect<unknown>> | undefined;
    afterSettle?(
      tx: StoreTransactionContext,
      state: CommandState,
      run: Run,
      stop: S,
      effect: CommandEffect<unknown> | undefined,
    ): void;
  },
) {
  const { store, runtime, clock } = options;
  const run = store.uow.run((tx) => {
    const result = policy.claim(loadCommandState(tx, project), {
      ids: tx.ids,
      clock,
    });
    if (!result) return;
    const effect = unwrap(result);
    persistEffect(tx, project, effect);
    return effect.data;
  });
  const stop = run && policy.fence(run);
  if (!run || !stop) return;
  const result = await stopRunRuntime(
    runtime,
    stop.runtime_ref,
    () =>
      store.uow.run((tx) => {
        const effect = unwrap(
          policy.start(
            loadCommandState(tx, project),
            { ids: tx.ids, clock },
            run,
            stop,
          ),
        );
        persistEffect(tx, project, effect);
        return !!effect.data;
      }),
    stop.stopping,
  );
  if (result === "withdrawn") return;
  store.uow.run((tx) => {
    const state = loadCommandState(tx, project);
    const current = state.runs.find((r) => r.id === run.id);
    // A stale external result cannot settle or alert for the new lease owner.
    if (!current || policy.fence(current)?.attempt_id !== stop.attempt_id)
      return;
    const settled = policy.finish(
      state,
      { ids: tx.ids, clock },
      run,
      stop,
      result === "exited",
    );
    const effect = settled && unwrap(settled);
    if (effect) {
      persistEffect(tx, project, effect);
      if (
        effect.events.some(
          (e) =>
            e.type === "run_inactivity_stop_finished" ||
            e.type === "run_dispatch_stop_finished",
        )
      )
        revokeStoppedRunTokens(tx, project, run.assignment_id);
    }
    policy.afterSettle?.(tx, state, current, stop, effect);
  });
}
