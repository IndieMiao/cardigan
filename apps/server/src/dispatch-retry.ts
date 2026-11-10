import { randomUUID } from "node:crypto";
import {
  type Assignment,
  type Clock,
  type CommandEffect,
  claimDispatchStop,
  dispatchedAt,
  dispatchRecoveryFailed,
  dispatchRecoveryQueuedAt,
  type ProjectId,
  type RunId,
  type Runtime,
  recoverDispatch,
  startDispatchStop,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  type BellAttempt,
  beginDispatchRetry,
  listBellAttempts,
  moveNotification,
  recordNotification,
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
} from "@cardigan/store";

import { runStopWorkflow } from "./dispatch-stop.js";

/** Retry only unstarted Runs. Claims and recovery decisions share the SQLite write lock. */
export async function retryDispatchedRuns(
  options: {
    store: Store;
    runtime: Runtime;
    clock: Clock;
    beforeWake?: (input: {
      project: ProjectId;
      assignment: Assignment;
    }) => Promise<string | undefined> | Promise<void>;
  },
  project: ProjectId,
  policy: {
    timeoutMs: number;
    retryBaseMs: number;
    maxRetries: number;
    leaseMs: number;
  },
  settle: (
    attempt: BellAttempt,
    sent: boolean,
    reason: string,
    bell: string,
  ) => void,
) {
  const { store, runtime, clock } = options;
  const read = () => store.uow.read((tx) => loadCommandState(tx, project));
  const actor = { kind: "system" as const, project_id: project };
  const finishRecovery = (
    tx: StoreTransactionContext,
    runId: RunId,
    failures: number,
  ) => {
    const state = loadCommandState(tx, project);
    const run = state.runs.find((r) => r.id === runId);
    if (!run) return;
    const effect = unwrap(
      recoverDispatch(
        state,
        actor,
        {
          run_id: runId,
          timeout_ms: policy.timeoutMs,
          failed_attempts: failures,
          max_failures: policy.maxRetries + 1,
        },
        { clock, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, effect);
    recordStall(run, effect);
  };
  const recordStall = (
    run: { id: RunId; assignment_id: Assignment["id"] },
    effect: CommandEffect<unknown>,
  ) => {
    const alert = effect.events.find((e) => e.type === "run_dispatch_stalled");
    if (!alert) return;
    const n = recordNotification(store.database, {
      project_id: project,
      event_id: alert.id,
      card_id: alert.card_id,
      seq: alert.seq,
      recipient: { kind: "assignment", assignment_id: run.assignment_id },
      kind: "run_attention",
      at: clock.now(),
    }).notification;
    moveNotification(store.database, {
      project_id: project,
      id: n.id,
      event: "needs_attention",
      at: clock.now(),
      patch: { run_id: run.id },
    });
  };
  const stopRun = async (
    runId: RunId,
    reason: "dispatch_timeout" | "delivery_retry_exhausted",
  ) => {
    await runStopWorkflow({ store, runtime, clock }, project, {
      claim: (state, ports) => {
        const run = state.runs.find((r) => r.id === runId);
        if (
          !run ||
          unfinishedBellAttempts(store.database, project).some(
            (t) => t.assignment_id === run.assignment_id,
          )
        )
          return;
        return claimDispatchStop(
          state,
          actor,
          {
            run_id: runId,
            reason,
            lease_ms: policy.leaseMs,
          },
          ports,
        );
      },
      fence: (run) => run.dispatch_stop,
      start: (state, ports, run, stop) =>
        startDispatchStop(
          state,
          actor,
          {
            run_id: run.id,
            attempt_id: stop.attempt_id,
          },
          ports,
        ),
      finish: (state, ports, run, stop, exited) =>
        recoverDispatch(
          state,
          actor,
          {
            run_id: run.id,
            timeout_ms: policy.timeoutMs,
            failed_attempts: 0,
            max_failures: policy.maxRetries + 1,
            stop_id: stop.attempt_id,
            ...(exited
              ? { stopped_runtime: stop.runtime_ref }
              : { stop_failed: true }),
          },
          ports,
        ),
      afterSettle: (_tx, _state, run, _stop, effect) => {
        if (effect) recordStall(run, effect);
      },
    });
  };
  const candidates = read();
  for (const candidate of candidates.runs) {
    // External identities have no managed terminal, including stale recovery records.
    if (
      candidates.assignments.find((a) => a.id === candidate.assignment_id)
        ?.external
    )
      continue;
    if (candidate.dispatch_stop) {
      // Resume the original target even after monitor changed status or a host cancelled it.
      await stopRun(candidate.id, candidate.dispatch_stop.reason);
      continue;
    }
    if (dispatchRecoveryFailed(candidates, candidate)) {
      store.uow.run((tx) => finishRecovery(tx, candidate.id, 0));
      continue;
    }
    if (!["dispatched", "queued"].includes(candidate.status)) continue;
    const inspect = (state = read()) => {
      const run = state.runs.find((r) => r.id === candidate.id);
      const a = state.assignments.find((a) => a.id === run?.assignment_id);
      const attempts = listBellAttempts(store.database, project);
      if (
        !run ||
        (run.status !== "dispatched" &&
          !(run.status === "queued" && dispatchRecoveryQueuedAt(state, run))) ||
        run.started_at ||
        run.dispatch_stop ||
        run.inactivity_stop ||
        // C-54 owns capacity waits; a healthy queued recovery must wait its turn.
        ("queue_reason" in run && run.queue_reason === "concurrency_limit") ||
        a?.status !== "active" ||
        attempts.some(
          (t) => t.assignment_id === a.id && t.finished_at === null,
        ) ||
        state.events.some(
          (e) =>
            e.type === "run_dispatch_stalled" &&
            typeof e.payload === "object" &&
            e.payload !== null &&
            "run_id" in e.payload &&
            e.payload.run_id === run.id,
        )
      )
        return;
      const history = attempts.filter((t) => t.run_id === run.id);
      const last = history.at(-1);
      const failures =
        last?.outcome === "failed"
          ? history.slice(
              history.findLastIndex((t) => t.outcome === "sent") + 1,
            ).length
          : 0;
      const at = clock.now(),
        started =
          dispatchedAt(state, run) ?? dispatchRecoveryQueuedAt(state, run);
      const recover =
        (started && Date.parse(at) - Date.parse(started) >= policy.timeoutMs) ||
        failures >= policy.maxRetries + 1;
      const retry =
        run.status === "dispatched" &&
        last?.outcome === "failed" &&
        last.finished_at &&
        Date.parse(at) >=
          Date.parse(last.finished_at) +
            policy.retryBaseMs * 2 ** Math.max(0, failures - 1);
      return { state, run, a, failures, recover, retry, at, last };
    };
    const observed = inspect();
    if (!observed) continue;
    if (observed.recover) {
      const used = observed.state.events.some(
        (e) =>
          e.type === "run_dispatch_recovered" &&
          typeof e.payload === "object" &&
          e.payload !== null &&
          "assignment_id" in e.payload &&
          e.payload.assignment_id === observed.a.id,
      );
      if (used)
        store.uow.run((tx) => {
          const current = inspect(loadCommandState(tx, project));
          if (current?.recover)
            finishRecovery(tx, current.run.id, current.failures);
        });
      else
        await stopRun(
          observed.run.id,
          observed.failures >= policy.maxRetries + 1
            ? "delivery_retry_exhausted"
            : "dispatch_timeout",
        );
      continue;
    }
    if (!observed.retry || !observed.a.runtime_ref) continue;
    const status = await runtime.status(observed.a.runtime_ref);
    if (!status.ok || status.value.process !== "alive") continue;
    const job = store.uow.run((tx) => {
      const current = inspect(loadCommandState(tx, project));
      if (
        !current?.retry ||
        current.recover ||
        JSON.stringify(current.a.runtime_ref) !==
          JSON.stringify(observed.a.runtime_ref) ||
        current.last?.id !== observed.last?.id
      )
        return;
      const notes = store
        .listNotifications({ project_id: project })
        .filter(
          (n) =>
            n.run_id === current.run.id &&
            ["pending", "belled", "delivery_failed"].includes(n.status),
        );
      const item = current.state.work_items.find(
        (w) => w.id === current.a.work_item_id,
      );
      const cause = current.state.events.find(
        (e) => e.id === current.run.trigger_event_id,
      );
      const bell =
        notes.find((n) => n.bell)?.bell ??
        `[bell] ${item ? `card=${item.card_id} wi=${item.id}` : `project=${project}`} asg=${current.a.id} run=${current.run.id} seq=${cause?.seq ?? 0} kind=${current.run.kind}\n→ 请调用 get_updates 读取详情`;
      const attempt: BellAttempt = {
        id: randomUUID(),
        project_id: project,
        assignment_id: current.a.id,
        run_id: current.run.id,
        notification_ids: notes.map((n) => n.id),
        started_at: current.at,
        lease_until: new Date(
          Date.parse(current.at) + policy.leaseMs,
        ).toISOString(),
        finished_at: null,
        outcome: null,
      };
      beginDispatchRetry(store.database, attempt);
      return { ...current, attempt, bell };
    });
    if (!job?.a.runtime_ref) continue;
    let sent = false,
      reason = "delivery_call_failed";
    try {
      const baseline = await options.beforeWake?.({
        project,
        assignment: job.a,
      });
      // MCP can start the Run while status/Git preparation is awaited; do not ring it again.
      if (read().runs.find((r) => r.id === job.run.id)?.status !== "dispatched")
        sent = true;
      else {
        const result = await runtime.wake(
          job.a.runtime_ref,
          [job.bell, baseline].filter(Boolean).join("\n"),
        );
        sent = result.ok && result.value.sent;
        reason = result.ok
          ? "delivery_failed"
          : `wake_failed:${result.error.code}`;
      }
    } catch {
      /* Only stable reason codes enter the audit record. */
    }
    settle(job.attempt, sent, reason, job.bell);
  }
}
