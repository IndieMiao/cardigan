import { randomUUID } from "node:crypto";
import {
  type Assignment,
  type Clock,
  type CommandEffect,
  type CommandState,
  c3ExitCandidate,
  claimDispatchStop,
  DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS,
  dispatchedAt,
  dispatchRecoveryFailed,
  dispatchRecoveryQueuedAt,
  dispatchRecoveryUsed,
  dispatchTargetWaitMs,
  type HarnessActivity,
  hasRunTarget,
  hostOpsPending,
  idleWakeGuard,
  mcpSessionMissing,
  type ProjectId,
  providerStartFailed,
  type Run,
  type RunId,
  type Runtime,
  recoverDispatch,
  recoveryChainUsed,
  refreshRunTargetWait,
  repairWakeTarget,
  resumableReviewWithdrawal,
  retirementOwnsSession,
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
  armBellReceipt,
  bindRepairAttempt,
  crossRepairSendBoundary,
  deferIfTargetWait,
  failAutomaticContextRun,
  type HarnessActivityInspection,
  type MachineLeases,
  refreshTargetWait,
  testReviewRunPrompt,
  tryHostOpsLock,
  wakeIsCurrent,
} from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { payloadString } from "@cardigan/router";
import {
  type BellAttempt,
  beginDispatchRetry,
  confirmReviewNotSent,
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
  dispatchAlert,
  recordHostOpsAlert,
  wakeFailure,
} from "./dispatch-alert.js";
import { notificationBell, type StandingResolver } from "./dispatch-inbox.js";
import type { StateLoader } from "./dispatch-state.js";
import { runStopWorkflow } from "./dispatch-stop.js";
import {
  keptPromptBinding,
  recordTurnWait,
  settleRefusedWake,
} from "./dispatch-turn-guard.js";
import {
  legacyRepairAuthority,
  legacyRepairWake,
} from "./legacy-repair-wake.js";

interface ProviderWatch {
  inspectHarnessActivity?: (
    project: ProjectId,
    target: Assignment["id"],
  ) => Promise<ReadonlyMap<Assignment["id"], HarnessActivityInspection>>;
  providerFailureThreshold?: number;
  providerCooldownMs?: number;
  /** C-600: how long a verified new session may take to list the Card tools. */
  mcpHandshakeTimeoutMs?: number;
}
async function providerSample(
  options: ProviderWatch,
  project: ProjectId,
  id: Assignment["id"],
) {
  try {
    const row = (await options.inspectHarnessActivity?.(project, id))?.get(id);
    return row && (row.status === "fresh" || row.status === "stale")
      ? row.startupFailure
      : undefined;
  } catch {
    return undefined;
  }
}
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
  options: ProviderWatch & {
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
    initialSample?: HarnessActivity,
  ) => {
    if (failAutomaticContextRun(store, project, runId, reason, clock))
      return "not_exited" as const;
    // On restart/confirmed exit, preserve provider attribution instead of spending
    // a generic recovery. Leave an early exit to the dispatch timeout path.
    if (
      options.inspectHarnessActivity &&
      ["server_restart", "runtime_exited"].includes(reason)
    ) {
      const state = store.uow.read((tx) => loadState(tx, project));
      const run = state.runs.find((r) => r.id === runId);
      if (run?.launch_profile_ref && !run.started_at && !run.dispatch_stop) {
        initialSample = await providerSample(
          options,
          project,
          run.assignment_id,
        );
        if (providerStartFailed(state, run, initialSample, clock.now(), 0)) {
          if (
            !providerStartFailed(
              state,
              run,
              initialSample,
              clock.now(),
              policy.timeoutMs,
            )
          )
            return "provider_wait" as const;
          reason = "provider_unavailable";
        }
      }
    }
    const owner =
      reason === "provider_unavailable"
        ? store.uow.read((tx) => tx.runs.get(project, runId)?.assignment_id)
        : undefined;
    let sample =
      initialSample ??
      (owner && (await providerSample(options, project, owner)));
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
            provider_sample: sample,
            timeout_ms: policy.timeoutMs,
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
      ...(owner
        ? {
            beforeStart: async () => {
              sample = await providerSample(options, project, owner);
            },
          }
        : {}),
      start: (state, ports, run, stop) =>
        startDispatchStop(
          state,
          actor,
          {
            run_id: run.id,
            attempt_id: stop.attempt_id,
            provider_sample: sample,
            timeout_ms: policy.timeoutMs,
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
            ...(options.providerFailureThreshold
              ? { provider_failure_threshold: options.providerFailureThreshold }
              : {}),
            ...(options.providerCooldownMs
              ? { provider_cooldown_ms: options.providerCooldownMs }
              : {}),
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
  options: ProviderWatch & {
    leases?: MachineLeases;
    standing?: StandingResolver;
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
    resumedRetirement?: Assignment,
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
      (run.status === "unknown" &&
        !run.started_at &&
        !!run.launch_profile_ref) ||
      run.status === "dispatched" ||
      run.status === "queued" ||
      (!run.started_at &&
        run.failure_reason !== "provider_unavailable" &&
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
    if (
      owner &&
      options.inspectHarnessActivity &&
      candidate.launch_profile_ref &&
      !candidate.started_at &&
      ["dispatched", "unknown"].includes(candidate.status)
    ) {
      const since = dispatchedAt(candidates, candidate);
      if (
        since &&
        Date.parse(clock.now()) -
          Date.parse(since) -
          dispatchTargetWaitMs(candidate, clock.now()) >=
          policy.timeoutMs &&
        !runTargetWaitReason(candidates, owner, candidate)
      ) {
        const sample = await providerSample(options, project, owner.id);
        if (options.closing?.()) return;
        if (
          providerStartFailed(
            read(),
            candidate,
            sample,
            clock.now(),
            policy.timeoutMs,
          )
        ) {
          await stopRun(candidate.id, "provider_unavailable", sample);
          continue;
        }
      }
    }
    // C-600: this launch's harness never listed the Card tools — a tool call
    // came from something else, or nothing arrived within the handshake
    // deadline. Stop that terminal without waiting for the dispatch timeout;
    // recovery rebuilds the session once, then settles and reports.
    if (
      owner &&
      candidate.status === "dispatched" &&
      !candidate.started_at &&
      owner.mcp_handshake === "pending" &&
      owner.mcp_session_key_sha256
    ) {
      const since = dispatchedAt(candidates, candidate);
      const now = clock.now();
      if (
        since &&
        Date.parse(now) -
          Date.parse(since) -
          dispatchTargetWaitMs(candidate, now) >=
          // Never later than the ordinary dispatch timeout, which would
          // otherwise rebuild the session first for an unnamed reason.
          Math.min(
            options.mcpHandshakeTimeoutMs ?? DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS,
            policy.timeoutMs,
          )
      )
        store.advanceMcpHandshake(
          project,
          owner.id,
          "deadline",
          owner.mcp_session_key_sha256,
        );
    }
    const current = owner && read().assignments.find((a) => a.id === owner.id);
    if (
      current &&
      candidate.status === "dispatched" &&
      !candidate.started_at &&
      mcpSessionMissing(current)
    ) {
      await stopRun(candidate.id, "mcp_unavailable");
      continue;
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
        // Give a confirmed send to the receipt monitor. After handoff, allow the
        // original timeout policy a fresh window; obsolete targets only retire.
        (run.bell_delivery?.run_id === run.id &&
          run.bell_delivery.sent_at &&
          a &&
          reviewRunWakeDisposition(state, a, run) !== "obsolete" &&
          (!run.bell_delivery.escalated_at ||
            Date.parse(clock.now()) -
              Date.parse(run.bell_delivery.escalated_at) <
              policy.timeoutMs)) ||
        run.dispatch_stop ||
        run.inactivity_stop ||
        stoppedByHuman(state.events, candidate.assignment_id) ||
        hostOpsPending(state.events, candidate.assignment_id) ||
        // C-54 owns capacity waits; a healthy queued recovery must wait its turn.
        run.queue_reason === "concurrency_limit" ||
        run.queue_reason === "provider_unavailable" ||
        a?.status !== "active" ||
        !hasRunTarget(a, state) ||
        unfinishedBellAttempts(store.database, project, a.id).length > 0 ||
        state.events.some(
          (e) =>
            payloadString(e.payload, "run_id") === run.id &&
            (e.type === "run_dispatch_stalled" ||
              // Handoff stops replays, not the exit-confirmed retirement of stale work.
              (e.type === "bell_wake_escalated" &&
                payloadString(e.payload, "reason") === "first_write_guard" &&
                reviewRunWakeDisposition(state, a, run) !== "obsolete" &&
                !unreadableCommentTrigger(state, run))),
        )
      )
        return;
      const history = listBellAttempts(store.database, project, run.id);
      const last = history.at(-1);
      const at = clock.now(),
        started =
          dispatchedAt(state, run) ?? dispatchRecoveryQueuedAt(state, run);
      // An unfinished claim excludes its peers; any settled attempt supersedes
      // the withdrawal proof. Empty legacy history alone authorizes nothing.
      const fromWithdrawal = resumableReviewWithdrawal(state, a, run);
      const withdrawn = !last && fromWithdrawal;
      const binding = last?.review_wake;
      const target = repairWakeTarget(state, run);
      const sameTarget =
        !!binding &&
        target?.id === binding.delivery_id &&
        target.subject.value === binding.target_sha &&
        target.status !== "superseded" &&
        !state.deliveries.some((d) => d.supersedes === target.id);
      const disposition = reviewRunWakeDisposition(state, a, run);
      const shared =
        sameTarget &&
        !disposition &&
        state.decisions.some(
          (q) => q.review_limit_group?.delivery_id === binding.delivery_id,
        );
      const refusedClaim =
        !disposition &&
        !run.bell_delivery?.sent_at &&
        last?.outcome === "failed" &&
        (run.bell_delivery?.refused_attempt_id === last.id ||
          (sameTarget && binding?.refused_at && !binding.sending_at));
      const refusedFirstWrite = !shared && refusedClaim;
      // Keep every receipt for audit. A positive refusal for this shared target
      // neither spends nor resets the ordinary failure budget since the last send.
      let failures = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        const attempt = history[i];
        if (attempt?.outcome !== "failed") break;
        const receipt = attempt.review_wake;
        if (
          shared &&
          receipt?.refused_at &&
          !receipt.sending_at &&
          receipt.delivery_id === binding.delivery_id &&
          receipt.target_sha === binding.target_sha
        )
          continue;
        failures++;
      }
      const legacy =
        !withdrawn && !disposition && target
          ? legacyRepairWake(state, a, run, target, history)
          : undefined;
      const reconcile = legacy === "reconcile" ? target : undefined;
      const unconfirmed = !!reconcile || (shared && !!binding?.sending_at);
      // A wait finishing is not a send. Only an actual boundary (or a legacy
      // result) starts the restored ack window. Clear failures still back off.
      const noSendYet =
        refusedFirstWrite ||
        withdrawn ||
        legacy === "unsent" ||
        (!reconcile &&
          shared &&
          last?.outcome === "failed" &&
          !binding.sending_at);
      const retryablePublication =
        !unconfirmed &&
        run.status === "dispatched" &&
        !run.started_at &&
        (!last || last.outcome === "failed");
      const readmit =
        retryablePublication &&
        !disposition &&
        (!binding || sameTarget) &&
        options.leases?.readmissionReason(project, a, run, tx);
      const resourceWait =
        retryablePublication &&
        !readmit &&
        options.leases?.publicationWait(project, run);
      const ackSince = reconcile
        ? last?.finished_at
        : shared
          ? (binding.sending_at ??
            (last?.outcome === "sent" ? last.finished_at : undefined))
          : fromWithdrawal
            ? last?.finished_at
            : last?.outcome === "sent" &&
                options.leases?.configured(project, a.machine_id)
              ? last.finished_at
              : undefined;
      const unreadable = unreadableCommentTrigger(state, run);
      const timedOut =
        started &&
        Date.parse(at) - Date.parse(started) - dispatchTargetWaitMs(run, at) >=
          policy.timeoutMs;
      const recover =
        !resourceWait &&
        ((timedOut &&
          (!noSendYet || readmit || unreadable) &&
          (!ackSince ||
            Date.parse(at) - Date.parse(ackSince) >= policy.timeoutMs)) ||
          (!refusedFirstWrite &&
            !unconfirmed &&
            failures >= policy.maxRetries + 1));
      const retry =
        run.status === "dispatched" &&
        last?.outcome === "failed" &&
        last.finished_at &&
        Date.parse(at) >=
          Date.parse(last.finished_at) +
            policy.retryBaseMs *
              2 **
                (shared && binding?.refused_at ? 0 : Math.max(0, failures - 1));
      // C-120: an obsolete cross-card bell cannot be retried as an empty launch.
      // Timeout recovery safely stops its terminal, then cancels without requeueing.
      return {
        state,
        run,
        a,
        failures,
        recover,
        reconcile,
        readmit,
        noSendYet,
        refusedNotes: refusedClaim ? last.notification_ids : [],
        legacyRetry: legacy === "unsent",
        withdrawn,
        retry:
          (withdrawn ||
            refusedFirstWrite ||
            ((retry || resourceWait) && !unconfirmed)) &&
          !unreadable &&
          (!binding || sameTarget) &&
          !disposition,
        at,
        last,
      };
    };
    const observed = inspect();
    if (!observed) continue;
    if (observed.recover) {
      if (observed.reconcile) {
        store.uow.run((tx) => {
          const fresh = inspect(loadState(tx, project), tx);
          if (!fresh?.recover || !fresh.reconcile) return;
          const { state, run, a, reconcile: target, at } = fresh;
          dispatchAlert(tx, store, state, at, {
            assignment: a,
            run_id: run.id,
            card_id: state.work_items.find((w) => w.id === target.work_item_id)
              ?.card_id,
            type: "run_dispatch_stalled",
            reason: "legacy_repair_ack_unknown",
            audience: "ops",
            notifyHostOps: true,
            review: {
              delivery_id: target.id,
              target_sha: target.subject.value,
              body: `旧版返工通知 ${run.id}（${target.id} / ${target.subject.value}）无法确认送达。请核对原会话与回执；未证实未发前不要补投。`,
            },
          });
        });
        continue;
      }
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
    if (observed.readmit) {
      // A missing original grant cannot become healthy by polling a mount.
      // Keep the reason visible but leave the bounded stop/exit recovery armed.
      store.uow.run((tx) => {
        const fresh = inspect(loadState(tx, project), tx);
        if (fresh?.readmit)
          options.leases?.wait(
            tx,
            project,
            fresh.a,
            fresh.run,
            fresh.readmit,
            fresh.at,
          );
      });
      continue;
    }
    if (
      !observed.retry ||
      !observed.a.runtime_ref ||
      options.leases?.startBlocked(
        project,
        observed.a,
        observed.run,
        clock.now(),
      )
    )
      continue;
    // C-247: no new delivery once shutdown began; the next process retries.
    if (options.closing?.()) continue;
    const status = await runtime
      .status(observed.a.runtime_ref)
      .catch(() => undefined);
    const binding = keptPromptBinding(
      project,
      observed.a,
      observed.run.harness,
    );
    const prompt =
      binding &&
      (await runtime
        .observe_prompt?.(observed.a.runtime_ref, binding)
        .catch(() => undefined));
    const guard = binding
      ? prompt?.ok && prompt.value
        ? { prompt_binding: binding }
        : undefined
      : status?.ok
        ? idleWakeGuard(status.value)
        : undefined;
    if (options.closing?.()) continue;
    const job = store.uow.run((tx) => {
      const current = inspect(loadState(tx, project), tx);
      if (
        !current?.retry ||
        // Only a proven non-write needs a guard deadline in place of ACK recovery.
        (!guard && !current.noSendYet) ||
        current.recover ||
        JSON.stringify(current.a.runtime_ref) !==
          JSON.stringify(observed.a.runtime_ref) ||
        current.last?.id !== observed.last?.id
      )
        return;
      // A refused first claim never settled its inbox rows. Reclaim exactly
      // those IDs alongside Run-owned rows, not unrelated newer comments.
      const refusedNotes = new Set(current.refusedNotes);
      const candidates = store
        .listNotifications({
          project_id: project,
          statuses: ["pending", "belled", "delivery_failed"],
        })
        .filter(
          (n) =>
            n.run_id === current.run.id ||
            (!n.run_id &&
              n.status === "pending" &&
              (refusedNotes.has(n.id) ||
                // A pause withdrew the original claim before it could bind the note.
                (current.withdrawn &&
                  n.event_id === current.run.trigger_event_id &&
                  n.recipient.kind === "assignment" &&
                  n.recipient.assignment_id === current.a.id)) &&
              (n.recipient.kind !== "assignment" ||
                n.recipient.assignment_id === current.a.id)),
        );
      const item = current.state.work_items.find(
        (w) => w.id === current.a.work_item_id,
      );
      const cause = current.state.events.find(
        (e) => e.id === current.run.trigger_event_id,
      );
      // An absent card on an existing receipt means project stream. It is
      // not a missing value to fill with the recipient's work-item card.
      const receipt = current.run.bell_delivery;
      const source = (
        receipt?.run_id === current.run.id
          ? receipt
          : (candidates[0] ?? cause ?? item)
      )?.card_id;
      const notes = candidates.filter((n) => n.card_id === source);
      if (!guard) {
        // A proven non-write is deliberately exempt from normal dispatch timeout recovery.
        recordTurnWait(tx, store, current.state, current.at, {
          owner: current.a,
          turn: current.run,
          reason: "first_write_guard",
          observation: status?.ok
            ? `${status.value.process}/${status.value.agent}`
            : (status?.error.code ?? "unavailable"),
          notes,
          timeoutMs: policy.timeoutMs,
          standing: options.standing,
        });
        return;
      }
      // Retain any stored decision instructions on ordinary retries. For a
      // refused claim, render the original pending rows, not a prior address.
      const storedBell = refusedNotes.size
        ? undefined
        : notes.find((n) => n.bell)?.bell;
      const address = source ? `card=${source}` : `project=${project}`;
      const bell =
        storedBell ??
        (notes.length
          ? notificationBell(project, current.a.id, current.run.id, notes)
          : `[bell] ${address} asg=${current.a.id} run=${current.run.id} seq=${cause?.seq ?? 0} kind=${current.run.kind}\n→ 请调用 get_updates 读取详情`);
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
      return {
        ...current,
        attempt: bindRepairAttempt(store, current.state, current.run, attempt),
        bell,
      };
    });
    if (!job?.a.runtime_ref || !guard) continue;
    const unlock = await tryHostOpsLock(store, project, job.a.id, "launch");
    if (!unlock) {
      store.uow.run(() =>
        withdrawBellAttempt(store.database, project, job.attempt.id),
      );
      continue;
    }
    let resumedRetirement: Assignment | undefined;
    let sent = false,
      reason = "delivery_call_failed",
      failure: DeliveryFailure | undefined,
      stage: DeliveryStage = "before_wake";
    const currentWakeRun = () =>
      store.uow.run((tx) => {
        const state = loadCommandState(tx, project);
        const run = state.runs.find((r) => r.id === job.run.id);
        if (
          !run ||
          !wakeIsCurrent(state, job.a, job.run.id) ||
          (job.withdrawn && !resumableReviewWithdrawal(state, job.a, run)) ||
          !unfinishedBellAttempts(store.database, project).some(
            (attempt) => attempt.id === job.attempt.id,
          )
        ) {
          withdrawBellAttempt(store.database, project, job.attempt.id);
          return undefined;
        }
        return run;
      });
    try {
      // C-68: beforeWake already retries lock/network failures for a few
      // seconds; this loop only spaces whole deliveries (no double retry).
      const baseline = await options.beforeWake?.({
        project,
        assignment: job.a,
      });
      if (deferIfTargetWait(store, job.attempt, clock)) {
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
        const leases = options.leases;
        const preflight =
          leases &&
          (leases.configured(project, job.a.machine_id) ||
            leases.hasProbeTarget(project, job.run))
            ? () =>
                leases.canPublish(project, job.a, job.run, () => clock.now())
            : undefined;
        if (preflight && !(await preflight())) {
          store.uow.run(() =>
            withdrawBellAttempt(store.database, project, job.attempt.id),
          );
          continue;
        }
        if (preflight && currentWakeRun()?.status !== "dispatched") {
          store.uow.run(() =>
            withdrawBellAttempt(store.database, project, job.attempt.id),
          );
          continue;
        }
        const addressed = job.a.runtime_ref;
        const retirementHeld = retirementOwnsSession(job.a);
        const arm = () =>
          !job.run.bell_delivery ||
          armBellReceipt(
            store,
            project,
            job.run.id,
            addressed,
            undefined,
            job.attempt.review_wake,
          );
        const result = await runtime.wake(
          addressed,
          [job.bell, baseline, reviewPrompt].filter(Boolean).join("\n"),
          {
            ...guard,
            ...(addressed.machine_id !== "local"
              ? { session_run: { assignment_id: job.a.id, run_id: job.run.id } }
              : {}),
            ...(retirementHeld && !guard.prompt_binding
              ? {
                  retirement_owner: {
                    project_id: project,
                    assignment_id: job.a.id,
                  },
                }
              : {}),
            ...(preflight ? { resource_preflight: preflight } : {}),
            before_send: () => {
              if (
                options.leases?.startBlocked(
                  project,
                  job.a,
                  job.run,
                  clock.now(),
                )
              )
                return false;
              if (job.attempt.review_wake)
                return (
                  !options.closing?.() &&
                  scope() === reviewPrompt &&
                  crossRepairSendBoundary(
                    store,
                    job.attempt,
                    job.a,
                    clock,
                    job.withdrawn,
                    job.legacyRetry ? legacyRepairAuthority : undefined,
                  ) === "send" &&
                  arm()
                );
              if (deferIfTargetWait(store, job.attempt, clock)) {
                return false;
              }
              return (
                !options.closing?.() &&
                currentWakeRun()?.status === "dispatched" &&
                scope() === reviewPrompt &&
                arm()
              );
            },
          },
        );
        if (result.ok && result.value.withdrawn) {
          settleRefusedWake(
            store,
            job.attempt,
            job.a,
            clock.now(),
            `alive/${guard.if_idle ? "idle" : "done"} (send withdrawn)`,
            policy.timeoutMs,
            options.standing,
          );
          continue;
        }
        if (result.ok && !result.value.sent && job.attempt.review_wake)
          store.uow.run(() =>
            confirmReviewNotSent(store.database, job.attempt),
          );
        sent = result.ok && result.value.sent;
        // A Run that advanced before wake can settle its bell, but only an
        // actual guarded send may resolve the wait captured at retry claim.
        if (
          sent &&
          retirementHeld &&
          (guard.prompt_binding || job.a.idle_retirement?.dispatch_wait)
        )
          resumedRetirement = job.a;
        if (result.ok) reason = "delivery_failed";
        else ({ reason, failure } = wakeFailure(result.error));
      }
    } catch (error) {
      if (
        stage === "before_wake" &&
        deferIfTargetWait(store, job.attempt, clock)
      )
        continue;
      if (stage === "before_wake" && !currentWakeRun()) continue;
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
    settle(job.attempt, sent, reason, job.bell, failure, resumedRetirement);
  }
}
