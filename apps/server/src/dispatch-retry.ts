import { randomUUID } from "node:crypto";
import {
  type Assignment,
  type Clock,
  type CommandEffect,
  type CommandState,
  c3ExitCandidate,
  claimDispatchStop,
  dispatchedAt,
  dispatchRecoveryFailed,
  dispatchRecoveryQueuedAt,
  dispatchRecoveryUsed,
  dispatchTargetWaitMs,
  hasRunTarget,
  hostOpsPending,
  type ProjectId,
  type Run,
  type RunId,
  type Runtime,
  recoverDispatch,
  recoveryChainUsed,
  refreshRunTargetWait,
  retireObsoleteQueuedRun,
  retireRecoveryQueuedRun,
  reviewRunWakeDisposition,
  runTargetWaitReason,
  startDispatchStop,
  stoppedByHuman,
  unreadableCommentTrigger,
  withdrawDispatchStop,
} from "@cardigan/domain";
import {
  deferTargetAttempt,
  failAutomaticContextRun,
  refreshTargetWait,
  testReviewRunPrompt,
  tryHostOpsLock,
  wakeIsCurrent,
} from "@cardigan/host";
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
  withdrawBellAttempt,
} from "@cardigan/store";
import {
  type DeliveryFailure,
  type DeliveryStage,
  deliveryFailure,
  deliveryFailureLine,
  recordHostOpsAlert,
  wakeFailure,
} from "./dispatch-alert.js";
import type { StateLoader } from "./dispatch-state.js";
import { runStopWorkflow } from "./dispatch-stop.js";

export interface DispatchRecoveryPolicy {
  timeoutMs: number;
  maxRetries: number;
  leaseMs: number;
}

/** Immutable event snapshots: index historical recovery failures once, not once per Run. */
const failedRecoveries = new WeakMap<
  CommandState["events"],
  ReadonlySet<unknown>
>();
function failedRecoveryRuns(
  events: CommandState["events"],
): ReadonlySet<unknown> {
  let failed = failedRecoveries.get(events);
  if (!failed) {
    const recovered = new Set<unknown>();
    const aborted = new Set<unknown>();
    for (const event of events) {
      if (typeof event.payload !== "object" || event.payload === null) continue;
      if (
        event.type === "run_dispatch_recovered" &&
        "replacement_run_id" in event.payload
      )
        recovered.add(event.payload.replacement_run_id);
      if (event.type === "run_dispatch_aborted" && "run_id" in event.payload)
        aborted.add(event.payload.run_id);
    }
    failed = new Set([...recovered].filter((id) => aborted.has(id)));
    failedRecoveries.set(events, failed);
  }
  return failed;
}

/**
 * The single stop → exit proof → cancel → requeue path. Shared by timeout
 * recovery and the C-247 startup check so both settle through the same fence,
 * the same domain rules and the same stall escalation.
 */
export function dispatchRecovery(
  options: {
    loadState?: StateLoader;
    store: Store;
    runtime: Runtime;
    clock: Clock;
  },
  project: ProjectId,
  policy: DispatchRecoveryPolicy,
) {
  const { store, runtime, clock, loadState = loadCommandState } = options;
  const actor = { kind: "system" as const, project_id: project };
  const finishRecovery = (
    tx: StoreTransactionContext,
    runId: RunId,
    failures: number,
  ) => {
    // Used recovery budgets also enter here without stopRun. This launch has
    // its own once-only failure policy, independent of historical recoveries.
    if (
      failAutomaticContextRun(
        store,
        project,
        runId,
        "新会话启动超时或投递失败，停止自动恢复。",
        clock,
        tx,
      )
    )
      return;
    const state = loadState(tx, project);
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
    recordStall(state, run, effect);
  };
  const recordStall = (
    state: CommandState,
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
    const assignment = state.assignments.find(
      (a) => a.id === run.assignment_id,
    );
    if (assignment)
      recordHostOpsAlert(store, state, clock.now(), assignment, alert);
  };
  const stopRun = async (
    runId: RunId,
    reason: NonNullable<Run["dispatch_stop"]>["reason"],
  ) => {
    if (failAutomaticContextRun(store, project, runId, reason, clock))
      return "not_exited" as const;
    return runStopWorkflow({ store, runtime, clock, loadState }, project, {
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
      observeOnly: (stop) =>
        ["server_restart", "runtime_exited"].includes(stop.reason),
      // C-247: a started restart stop that still cannot prove exit waits
      // until the ordinary dispatch timeout, then escalates as an unconfirmed
      // stop; it never force-closes the terminal.
      settleUnexited: (run) => {
        const state = store.uow.read((tx) => loadState(tx, project));
        const current = state.runs.find((r) => r.id === run.id) ?? run;
        const since = dispatchedAt(state, current);
        const now = clock.now();
        return (
          !!since &&
          Date.parse(now) -
            Date.parse(since) -
            dispatchTargetWaitMs(current, now) >=
            policy.timeoutMs
        );
      },
      withdraw: (state, ports, run, stop) =>
        withdrawDispatchStop(
          state,
          actor,
          {
            run_id: run.id,
            attempt_id: stop.attempt_id,
            reason: "runtime_not_exited",
          },
          ports,
        ),
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
      afterSettle: (_tx, state, run, _stop, effect) => {
        if (effect) recordStall(state, run, effect);
      },
    });
  };
  return { finishRecovery, stopRun };
}

/** Retry only unstarted Runs. Claims and recovery decisions share the SQLite write lock. */
export async function retryDispatchedRuns(
  options: {
    loadState?: StateLoader;
    store: Store;
    runtime: Runtime;
    clock: Clock;
    beforeWake?: (input: {
      project: ProjectId;
      assignment: Assignment;
    }) => Promise<string | undefined> | Promise<void>;
    /** Sanitized one-line server log for a failed retry (C-68). */
    onError?: (error: unknown) => void;
    /** C-247: true once server shutdown began; no new wake is started. */
    closing?: () => boolean;
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
    failure?: DeliveryFailure,
  ) => void,
) {
  const { store, runtime, clock, loadState = loadCommandState } = options;
  const read = () => store.uow.read((tx) => loadState(tx, project));
  const actor = { kind: "system" as const, project_id: project };
  const { finishRecovery, stopRun } = dispatchRecovery(
    options,
    project,
    policy,
  );
  const candidates = read();
  const failures = failedRecoveryRuns(candidates.events);
  // Include stop fences regardless of status, queued recovery/unreadable work,
  // and failed startup recoveries. Completed/ordinary failed history cannot retry.
  // This only narrows the snapshot's scan; every effect still rechecks in its transaction.
  const runs = candidates.runs.filter(
    (run) =>
      run.dispatch_stop ||
      c3ExitCandidate(candidates, run) ||
      run.status === "dispatched" ||
      run.status === "queued" ||
      (!run.started_at &&
        ["cancelled", "failed"].includes(run.status) &&
        failures.has(run.id)),
  );
  const owners = new Map(candidates.assignments.map((a) => [a.id, a]));
  for (const candidate of runs) {
    if (
      candidate.launch_publication &&
      !["started", "exited"].includes(candidate.launch_publication.phase)
    )
      continue;
    if (hostOpsPending(read().events, candidate.assignment_id)) continue;
    const owner = owners.get(candidate.assignment_id);
    // External identities have no managed terminal, including stale recovery records.
    if (owner?.external) continue;
    if (candidate.dispatch_stop) {
      // Resume the original target even after monitor changed status or a host cancelled it.
      await stopRun(candidate.id, candidate.dispatch_stop.reason);
      continue;
    }
    if (
      candidate.status === "queued" &&
      (unreadableCommentTrigger(candidates, candidate) ||
        (owner &&
          reviewRunWakeDisposition(candidates, owner, candidate) ===
            "obsolete"))
    ) {
      store.uow.run((tx) => {
        if (
          unfinishedBellAttempts(store.database, project).some(
            (a) => a.assignment_id === candidate.assignment_id,
          )
        )
          return;
        persistEffect(
          tx,
          project,
          unwrap(
            retireObsoleteQueuedRun(
              loadState(tx, project),
              actor,
              { run_id: candidate.id },
              { clock, ids: tx.ids },
            ),
          ),
        );
      });
      continue;
    }
    if (
      candidate.status === "queued" &&
      candidate.recovery_policy &&
      candidate.recovery_policy.root_run_id !== candidate.id
    ) {
      store.uow.run((tx) => {
        if (
          unfinishedBellAttempts(
            store.database,
            project,
            candidate.assignment_id,
          ).length
        )
          return;
        persistEffect(
          tx,
          project,
          unwrap(
            retireRecoveryQueuedRun(
              loadState(tx, project),
              actor,
              { run_id: candidate.id },
              { clock, ids: tx.ids },
            ),
          ),
        );
      });
    }
    if (c3ExitCandidate(read(), candidate)) {
      const ref = candidate.recovery_runtime;
      const observed =
        ref && (await runtime.status(ref).catch(() => undefined));
      if (options.closing?.()) continue;
      if (
        observed?.ok
          ? observed.value.process === "exited"
          : observed?.error.code === "runtime_not_found"
      ) {
        await stopRun(candidate.id, "runtime_exited");
        continue;
      }
    }
    if (dispatchRecoveryFailed(candidates, candidate)) {
      store.uow.run((tx) => finishRecovery(tx, candidate.id, 0));
      continue;
    }
    if (!["dispatched", "queued"].includes(candidate.status)) continue;
    if (
      (candidate.dispatch_target_wait?.since ||
        (owner && runTargetWaitReason(candidates, owner, candidate))) &&
      refreshTargetWait(store, project, candidate.id, clock)
    )
      continue;
    const inspect = (state = read(), tx?: StoreTransactionContext) => {
      const run = state.runs.find((r) => r.id === candidate.id);
      const a = state.assignments.find((a) => a.id === run?.assignment_id);
      if (run && a && runTargetWaitReason(state, a, run)) {
        // Persist the pause at the observation, including after awaited status.
        // A restart must not count the intervening target wait as a timeout.
        if (tx)
          persistEffect(
            tx,
            project,
            unwrap(
              refreshRunTargetWait(
                state,
                actor,
                { run_id: run.id },
                { clock, ids: tx.ids },
              ),
            ),
          );
        else refreshTargetWait(store, project, run.id, clock);
        return;
      }
      if (
        !run ||
        (run.status !== "dispatched" &&
          !(run.status === "queued" && dispatchRecoveryQueuedAt(state, run))) ||
        run.started_at ||
        run.dispatch_stop ||
        run.inactivity_stop ||
        stoppedByHuman(state.events, candidate.assignment_id) ||
        hostOpsPending(state.events, candidate.assignment_id) ||
        // C-54 owns capacity waits; a healthy queued recovery must wait its turn.
        ("queue_reason" in run && run.queue_reason === "concurrency_limit") ||
        a?.status !== "active" ||
        !hasRunTarget(a, state) ||
        unfinishedBellAttempts(store.database, project, a.id).length > 0 ||
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
      const history = listBellAttempts(store.database, project, run.id);
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
        (started &&
          Date.parse(at) -
            Date.parse(started) -
            dispatchTargetWaitMs(run, at) >=
            policy.timeoutMs) ||
        failures >= policy.maxRetries + 1;
      const retry =
        run.status === "dispatched" &&
        last?.outcome === "failed" &&
        last.finished_at &&
        Date.parse(at) >=
          Date.parse(last.finished_at) +
            policy.retryBaseMs * 2 ** Math.max(0, failures - 1);
      // C-120: an obsolete cross-card bell cannot be retried as an empty launch.
      // Timeout recovery safely stops its terminal, then cancels without requeueing.
      const unreadable = unreadableCommentTrigger(state, run);
      return {
        state,
        run,
        a,
        failures,
        recover,
        retry: retry && !unreadable && !reviewRunWakeDisposition(state, a, run),
        at,
        last,
      };
    };
    const observed = inspect();
    if (!observed) continue;
    if (observed.recover) {
      const used =
        dispatchRecoveryUsed(observed.state.events, observed.a.id) ||
        recoveryChainUsed(observed.state, observed.run);
      if (
        used &&
        !unreadableCommentTrigger(observed.state, observed.run) &&
        reviewRunWakeDisposition(observed.state, observed.a, observed.run) !==
          "obsolete"
      )
        store.uow.run((tx) => {
          const current = inspect(loadState(tx, project), tx);
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
    // C-247: no new delivery once shutdown began; the next process retries.
    if (options.closing?.()) continue;
    const status = await runtime.status(observed.a.runtime_ref);
    if (!status.ok || status.value.process !== "alive") continue;
    if (options.closing?.()) continue;
    const job = store.uow.run((tx) => {
      const current = inspect(loadState(tx, project), tx);
      if (
        !current?.retry ||
        current.recover ||
        JSON.stringify(current.a.runtime_ref) !==
          JSON.stringify(observed.a.runtime_ref) ||
        current.last?.id !== observed.last?.id
      )
        return;
      const notes = store
        .listNotifications({
          project_id: project,
          statuses: ["pending", "belled", "delivery_failed"],
        })
        .filter((n) => n.run_id === current.run.id);
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
    const unlock = await tryHostOpsLock(store, project, job.a.id, "launch");
    if (!unlock) {
      store.uow.run(() =>
        withdrawBellAttempt(store.database, project, job.attempt.id),
      );
      continue;
    }
    let sent = false,
      reason = "delivery_call_failed",
      failure: DeliveryFailure | undefined,
      stage: DeliveryStage = "before_wake";
    const currentWakeRun = () =>
      store.uow.run((tx) => {
        const state = loadCommandState(tx, project);
        if (
          !wakeIsCurrent(state, job.a, job.run.id) ||
          !unfinishedBellAttempts(store.database, project).some(
            (attempt) => attempt.id === job.attempt.id,
          )
        ) {
          withdrawBellAttempt(store.database, project, job.attempt.id);
          return undefined;
        }
        return state.runs.find((run) => run.id === job.run.id);
      });
    try {
      // C-68: beforeWake already retries lock/network failures for a few
      // seconds; this loop only spaces whole deliveries (no double retry).
      const baseline = await options.beforeWake?.({
        project,
        assignment: job.a,
      });
      if (refreshTargetWait(store, project, job.run.id, clock)) {
        deferTargetAttempt(store, job.attempt, clock);
        continue;
      }
      // C-247: nothing was sent yet, so withdraw the retry and leave it to
      // the next process instead of ringing a terminal the server abandons.
      if (
        options.closing?.() &&
        store.uow.run(() =>
          withdrawBellAttempt(store.database, project, job.attempt.id),
        )
      )
        continue;
      const currentRun = currentWakeRun();
      if (!currentRun) continue;
      const scope = () =>
        job.a.role_id === "independent_reviewer"
          ? store.uow.read((tx) =>
              testReviewRunPrompt(
                loadCommandState(tx, project),
                job.a.id,
                job.run.id,
              ),
            )
          : undefined;
      const reviewPrompt = scope();
      stage = "wake";
      // MCP can start the Run while status/Git preparation is awaited; do not ring it again.
      if (currentRun.status !== "dispatched") sent = true;
      else {
        const result = await runtime.wake(
          job.a.runtime_ref,
          [job.bell, baseline, reviewPrompt].filter(Boolean).join("\n"),
          {
            before_send: () => {
              if (refreshTargetWait(store, project, job.run.id, clock)) {
                deferTargetAttempt(store, job.attempt, clock);
                return false;
              }
              return (
                !options.closing?.() &&
                currentWakeRun()?.status === "dispatched" &&
                scope() === reviewPrompt
              );
            },
          },
        );
        if (result.ok && result.value.withdrawn) {
          store.uow.run(() =>
            withdrawBellAttempt(store.database, project, job.attempt.id),
          );
          continue;
        }
        sent = result.ok && result.value.sent;
        if (result.ok) reason = "delivery_failed";
        else ({ reason, failure } = wakeFailure(result.error));
      }
    } catch (error) {
      if (stage === "before_wake" && !currentWakeRun()) continue;
      if (
        stage === "before_wake" &&
        refreshTargetWait(store, project, job.run.id, clock)
      ) {
        deferTargetAttempt(store, job.attempt, clock);
        continue;
      }
      // The reason stays a stable code; the cause is sanitized (C-68).
      ({ reason, failure } = deliveryFailure(stage, error));
    } finally {
      await unlock();
    }
    if (failure)
      options.onError?.(
        new Error(
          deliveryFailureLine({
            project,
            assignment: job.a.id,
            run: job.run.id,
            reason,
            failure,
          }),
        ),
      );
    settle(job.attempt, sent, reason, job.bell, failure);
  }
}
