import {
  type Assignment,
  type AssignmentId,
  beginIdleSessionRetirement,
  type Clock,
  type CommandEffect,
  type CommandState,
  clearSupersededRetirement,
  confirmKeptShellExit,
  confirmWaitingRetirementExit,
  darwinWorker,
  handoffIdleSessionRetirement,
  hostOpsPending,
  humanStopRecorded,
  needsRetirementHandoff,
  type ProjectId,
  type RetirementDispatchWait,
  type RetirementEvidence,
  type RetirementSettlement,
  type RunId,
  type Runtime,
  type RuntimeErrorCode,
  releaseRetainedRetirement,
  retirementOwnsSession,
  runsOf,
  runtimeErrorCodes,
  sessionMaintenanceCandidate,
  settleIdleSessionRetirement,
  stoppedByHuman,
  supersededRetirement,
  trackRetirementDispatch,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  LIVE_NOTIFICATION_STATUSES,
  recordNotification,
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { tryHostOpsLock } from "./host-ops-lock.js";
import type { sessionMaintenanceScan } from "./session-maintenance.js";

function duration(name: string, fallback: number, max = 2_147_483_647) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/u.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new Error(`Invalid ${name}`);
  return value;
}
export function idleRetirementPolicy() {
  const policy = {
    hangup_ms: duration("CARDIGAN_IDLE_RETIRE_HANGUP_MS", 2000, 30_000),
    terminate_ms: duration("CARDIGAN_IDLE_RETIRE_TERMINATE_MS", 5000, 30_000),
    retry_ms: duration("CARDIGAN_IDLE_RETIRE_RETRY_MS", 60_000),
    retry_max_ms: duration("CARDIGAN_IDLE_RETIRE_RETRY_MAX_MS", 300_000),
  };
  if (policy.retry_max_ms < policy.retry_ms)
    throw new Error("Invalid idle retirement retry range");
  return policy;
}

function revokeRetiredTokens(
  tx: StoreTransactionContext,
  project: ProjectId,
  id: AssignmentId,
) {
  for (const token of tx.tokensForAssignment(project, id))
    if (token.revoked_at === null && !tx.revokeToken(token.id))
      throw new Error("Failed to revoke retired session token");
}

export const boundedRetirementError = (code?: RuntimeErrorCode) =>
  code && runtimeErrorCodes.includes(code) ? code : "unknown";

function persistRetirement<T>(
  store: Store,
  tx: StoreTransactionContext,
  project: ProjectId,
  effect: CommandEffect<T>,
) {
  persistEffect(tx, project, effect);
  for (const event of effect.events.filter(
    (e) => e.type === "session_maintenance_attention",
  ))
    recordNotification(store.database, {
      project_id: project,
      event_id: event.id,
      card_id: event.card_id,
      seq: event.seq,
      recipient: { kind: "pm_ops" },
      kind: "run_attention",
      at: event.created_at,
    });
}

export function recordRetirementDispatch(
  store: Store,
  project: ProjectId,
  expected: Assignment,
  runId: RunId,
  observation: RetirementDispatchWait,
  clock: Clock,
) {
  store.uow.run((tx) => {
    const effect = unwrap(
      trackRetirementDispatch(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        expected,
        runId,
        observation,
        { ids: tx.ids, clock },
      ),
    );
    persistRetirement(store, tx, project, effect);
  });
}

/** A pending Run may reuse this session, but only retirement can clear it.
 * Read under the same locks as maintenance; close only the exact waiting ref. */
export async function observeRetirementForDispatch(
  store: Store,
  project: ProjectId,
  a: Assignment,
  runtime: Runtime,
  clock: Clock,
) {
  const ref = a.runtime_ref;
  if (!ref) return "deferred";
  if (!runtime.observe_retirement) return "unsupported";
  const unlock = await tryHostOpsLock(store, project, a.id);
  if (!unlock) return "deferred";
  try {
    const unlockLaunch = await tryHostOpsLock(store, project, a.id, "launch");
    if (!unlockLaunch) return "deferred";
    try {
      const current = store.uow.read((tx) => tx.assignments.get(project, a.id));
      if (
        current?.idle_retirement?.phase !== "waiting" ||
        current.idle_retirement.started_at !== a.idle_retirement?.started_at ||
        !retirementOwnsSession(current) ||
        JSON.stringify(current.runtime_ref) !== JSON.stringify(ref)
      )
        return "deferred";
      const observed = await runtime
        .observe_retirement(ref, { project_id: project, assignment_id: a.id })
        .catch(() => undefined);
      if (!observed?.ok || observed.value !== "exited")
        return observed?.ok
          ? observed.value === "alive"
            ? "alive"
            : "unknown"
          : boundedRetirementError(observed?.error.code);
      return store.uow.run((tx) => {
        const effect = confirmWaitingRetirementExit(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          a.id,
          ref,
          { ids: tx.ids, clock },
        );
        if (!effect.ok) return "deferred" as const; // Stale proof or a Run already started.
        persistEffect(tx, project, effect.value);
        revokeRetiredTokens(tx, project, a.id);
        return "exited" as const;
      });
    } finally {
      await unlockLaunch();
    }
  } finally {
    await unlock();
  }
}

/** C-667/C-672: a live terminal whose CLI exited may be closed only while
 * nothing of this owner runs or is being stopped, started or woken. A pending
 * retirement (waiting, handed off, or a stop whose exit was never confirmed)
 * does not keep it: the proof finishes that retirement. */
function exitedAgentOwner(store: Store, state: CommandState, a: Assignment) {
  if (
    a.scope !== "work_item" ||
    a.external ||
    a.status !== "active" ||
    !a.runtime_ref ||
    // Only a macOS worker can prove the launched CLI is gone.
    !darwinWorker(state, a) ||
    a.role_upgrade ||
    stoppedByHuman(state.events, a.id) ||
    hostOpsPending(state.events, a.id) ||
    runsOf(state.runs, a.id).some(
      (r) =>
        !["queued", "completed", "failed", "cancelled"].includes(r.status) ||
        r.dispatch_stop ||
        r.inactivity_stop ||
        (r.launch_publication &&
          !["started", "exited"].includes(r.launch_publication.phase)),
    ) ||
    unfinishedBellAttempts(store.database, state.project_id, a.id).length
  )
    return false;
  // Only owners with work for a new session (or a retirement to finish).
  const latest = Math.max(
    0,
    ...state.roles
      .filter((r) => r.role_id === a.role_id && r.status !== "inactive")
      .map((r) => r.role_version),
  );
  return (
    !!a.idle_retirement ||
    latest > a.role_version ||
    runsOf(state.runs, a.id).some((r) => r.status === "queued") ||
    store.listNotifications({
      project_id: state.project_id,
      assignment_id: a.id,
      statuses: LIVE_NOTIFICATION_STATUSES,
    }).length > 0
  );
}

export type ExitedAgentRelease =
  /** The terminal was closed and the session settled; dispatch starts anew. */
  | "settled"
  /** Proven exited, but the terminal could not be closed or settled now. */
  | "proven"
  /** Not eligible, not live, not proven or locked: nothing was changed. */
  | "skipped";

/**
 * C-667/C-672: one owner. When the worker proves that this exact live
 * terminal no longer runs its launched CLI (an idle shell of a kept terminal,
 * or a launcher such as the macOS idle owner that outlived the CLI), close
 * that terminal and settle the session so the existing upgrade and dispatch
 * paths start a fresh one. Holds both host-ops locks and re-reads the owner
 * before closing; never signals a live CLI.
 */
export async function releaseExitedAgent(
  store: Store,
  project: ProjectId,
  a: Assignment,
  runtime: Runtime,
  clock: Clock,
): Promise<ExitedAgentRelease> {
  const ref = a.runtime_ref;
  if (!ref || !runtime.observe_agent_exit) return "skipped";
  const observed = await runtime.status(ref).catch(() => undefined);
  if (!observed?.ok || observed.value.process !== "alive") return "skipped";
  const unlock = await tryHostOpsLock(store, project, a.id);
  if (!unlock) return "skipped";
  try {
    const unlockLaunch = await tryHostOpsLock(store, project, a.id, "launch");
    if (!unlockLaunch) return "skipped";
    try {
      const current = () =>
        store.uow.read((tx) => {
          const state = loadCommandState(tx, project);
          const owner = state.assignments.find((v) => v.id === a.id);
          return owner &&
            JSON.stringify(owner.runtime_ref) === JSON.stringify(ref) &&
            exitedAgentOwner(store, state, owner)
            ? owner
            : undefined;
        });
      if (!current()) return "skipped";
      const owner = { project_id: project, assignment_id: a.id };
      const exited = await runtime
        .observe_agent_exit(ref, owner)
        .catch(() => undefined);
      if (!exited?.ok || !exited.value) return "skipped";
      if (!current()) return "proven";
      const closed = await runtime
        .release(ref, { force: true })
        .catch(() => undefined);
      if (!closed?.ok) return "proven";
      return store.uow.run((tx) => {
        const effect = confirmKeptShellExit(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          a.id,
          ref,
          { ids: tx.ids, clock },
        );
        // A changed owner keeps its reference; the closed terminal then
        // reads as not found and takes the ordinary replacement path.
        if (!effect.ok) return "proven" as const;
        persistEffect(tx, project, effect.value);
        revokeRetiredTokens(tx, project, a.id);
        return "settled" as const;
      });
    } finally {
      await unlockLaunch();
    }
  } catch {
    console.error("Terminal of an exited Agent could not be settled");
    return "skipped";
  } finally {
    await unlock();
  }
}

/**
 * C-690: a waiting retirement of a session the Assignment no longer runs
 * (typically: retained for dispatch, then a human stop released that terminal
 * and a start launched a new one) fenced the new session's dispatch, stall
 * recovery and host operations. Drop it; no runtime IO, no signal.
 */
export function clearSupersededRetirements(
  store: Store,
  project: ProjectId,
  clock: Clock,
) {
  const stale = store.uow.read((tx) =>
    tx.assignments
      .list(project)
      .filter((a) => a.scope === "work_item" && supersededRetirement(a))
      .map((a) => a.id),
  );
  for (const id of stale)
    store.uow.run((tx) => {
      const effect = clearSupersededRetirement(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        id,
        { ids: tx.ids, clock },
      );
      if (effect.ok) persistEffect(tx, project, effect.value);
    });
  return stale.length;
}

/**
 * C-690: a session the idle patrol retained for dispatch (handoff, nothing
 * signalled) kept every later notification pending, because the dispatcher
 * treats a handoff as busy and no host operation consumes a handoff without a
 * queued Run. When notifications are waiting for it (and no Run is queued,
 * running or being stopped or woken), withdraw that retirement under both
 * host-ops locks; the dispatcher then wakes the session through its ordinary
 * guarded path, or replaces it when its CLI is proven gone (C-672).
 */
export async function releaseRetainedForWork(
  store: Store,
  project: ProjectId,
  clock: Clock,
) {
  const candidates = store.uow.read((tx) =>
    tx.assignments
      .list(project)
      .filter(
        (a) =>
          a.scope === "work_item" &&
          a.status === "active" &&
          !a.external &&
          a.idle_retirement?.phase === "waiting" &&
          a.idle_retirement.handoff === true &&
          retirementOwnsSession(a),
      ),
  );
  let released = 0;
  for (const a of candidates) {
    if (
      !store.listNotifications({
        project_id: project,
        assignment_id: a.id,
        statuses: LIVE_NOTIFICATION_STATUSES,
      }).length ||
      unfinishedBellAttempts(store.database, project, a.id).length
    )
      continue;
    const unlock = await tryHostOpsLock(store, project, a.id);
    if (!unlock) continue;
    try {
      const unlockLaunch = await tryHostOpsLock(store, project, a.id, "launch");
      if (!unlockLaunch) continue;
      try {
        const done = store.uow.run((tx) => {
          const state = loadCommandState(tx, project);
          const current = state.assignments.find((v) => v.id === a.id);
          // Queued work belongs to the C-575 handoff consumer.
          if (
            !current ||
            JSON.stringify(current.idle_retirement) !==
              JSON.stringify(a.idle_retirement) ||
            JSON.stringify(current.runtime_ref) !==
              JSON.stringify(a.runtime_ref) ||
            runsOf(state.runs, a.id).some((r) => r.status === "queued")
          )
            return false;
          const effect = releaseRetainedRetirement(
            state,
            { kind: "system", project_id: project },
            a.id,
            { ids: tx.ids, clock },
          );
          if (!effect.ok) return false;
          persistEffect(tx, project, effect.value);
          return true;
        });
        if (done) released++;
      } finally {
        await unlockLaunch();
      }
    } finally {
      await unlock();
    }
  }
  return released;
}

/** C-667/C-672: every eligible owner of this project, bounded per pass. */
export async function releaseExitedAgents(
  store: Store,
  project: ProjectId,
  runtime: Runtime,
  clock: Clock,
  limit: number,
  note?: ReturnType<typeof sessionMaintenanceScan>["note"],
) {
  if (!runtime.observe_agent_exit) return 0;
  const candidates = store.uow.read((tx) => {
    const state = loadCommandState(tx, project);
    return state.assignments.filter((a) => exitedAgentOwner(store, state, a));
  });
  let released = 0;
  for (const a of candidates) {
    if (released >= limit) break;
    const outcome = await releaseExitedAgent(store, project, a, runtime, clock);
    if (outcome === "settled") released++;
    else if (outcome === "proven") note?.(a.id, "agent_exited");
  }
  return released;
}

/** Shares both existing lock domains with attach/stop and launch/wake. */
export async function retireIdleSessions(
  store: Store,
  project: ProjectId,
  runtime: Runtime,
  clock: Clock,
  threshold: number,
  limit: number,
  note: ReturnType<typeof sessionMaintenanceScan>["note"],
) {
  const policy = idleRetirementPolicy();
  const candidates = store.uow.read((tx) => {
    const state = loadCommandState(tx, project);
    return state.assignments
      .filter(
        (a) =>
          a.scope === "work_item" &&
          !a.external &&
          a.status === "active" &&
          !(a.idle_retirement?.handoff && retirementOwnsSession(a)) &&
          (needsRetirementHandoff(state, a) ||
            a.idle_retirement?.phase === "stopping" ||
            (runtime.retire_idle &&
              sessionMaintenanceCandidate(state, a, clock.now(), threshold)
                .candidate)),
      )
      .sort((a, b) => {
        const priority = (owner: Assignment) =>
          owner.idle_retirement?.phase === "stopping"
            ? 0
            : owner.idle_retirement
              ? 2
              : 1;
        return priority(a) - priority(b);
      })
      .map((a) => ({ a, adopt: needsRetirementHandoff(state, a) }));
  });
  let attempted = 0;
  for (const { a, adopt } of candidates) {
    if (!adopt && attempted >= limit) continue;
    if (
      !adopt &&
      Date.parse(a.idle_retirement?.retry_at ?? "") > Date.parse(clock.now())
    )
      continue;
    const unlock = await tryHostOpsLock(store, project, a.id);
    if (!unlock) {
      note(a.id, "maintenance_locked");
      continue;
    }
    let unlockLaunch: (() => Promise<void>) | undefined;
    try {
      unlockLaunch = await tryHostOpsLock(store, project, a.id, "launch");
      if (!unlockLaunch) {
        note(a.id, "maintenance_locked");
        continue;
      }
      const claim = store.uow.run((tx) => {
        const state = loadCommandState(tx, project),
          current = state.assignments.find((v) => v.id === a.id);
        if (
          !current ||
          (current.idle_retirement?.handoff &&
            retirementOwnsSession(current)) ||
          JSON.stringify(current.runtime_ref) !== JSON.stringify(a.runtime_ref)
        )
          return;
        if (needsRetirementHandoff(state, current)) {
          persistEffect(
            tx,
            project,
            unwrap(
              handoffIdleSessionRetirement(
                state,
                { kind: "system", project_id: project },
                a.id,
                { ids: tx.ids, clock },
              ),
            ),
          );
          return;
        }
        if (adopt) return; // stale migration candidate; no runtime slot was reserved
        if (current.idle_retirement?.phase === "stopping")
          return { pending: current, recovering: true };
        const inFlight = store
          .listProjects()
          .flatMap((p) => tx.assignments.list(p.id))
          .filter(
            (owner) =>
              owner.status === "active" &&
              (owner.role_upgrade ||
                (owner.idle_retirement?.phase === "stopping" &&
                  !owner.idle_retirement.handoff)),
          ).length;
        if (inFlight >= limit) return;
        const effect = beginIdleSessionRetirement(
          state,
          { kind: "system", project_id: project },
          a.id,
          threshold,
          { ids: tx.ids, clock },
        );
        if (!effect.ok) return;
        persistEffect(tx, project, effect.value);
        return { pending: effect.value.data, recovering: false };
      });
      const pending = claim?.pending;
      if (!pending?.idle_retirement) continue;
      attempted++;
      const pendingEvidence: RetirementEvidence = pending.idle_retirement
        .evidence ?? { stage: "confirm", reason: "confirmation_pending" };
      const observeOnly = pending.idle_retirement.observe_only === true;
      const unconfirmed = observeOnly ? "observing" : "uncertain";
      let result: RetirementSettlement = {
        outcome: unconfirmed,
        evidence: observeOnly
          ? { ...pendingEvidence, observation: "unknown" }
          : pendingEvidence,
      };
      const ref = pending.idle_retirement.runtime_ref;
      try {
        if (claim?.recovering || observeOnly) {
          // Unknown signals keep the fence; a known non-signal capability
          // failure permits legitimate work between read-only observations.
          const observed = await runtime.observe_retirement?.(ref, {
            project_id: project,
            assignment_id: a.id,
          });
          result =
            observed?.ok && observed.value === "exited"
              ? { outcome: "exited" }
              : {
                  outcome: unconfirmed,
                  evidence: {
                    ...pendingEvidence,
                    observation: observed?.ok
                      ? observed.value
                      : (observed?.error.code ?? "unknown"),
                  },
                };
        } else if (runtime.retire_idle) {
          const retired = await runtime.retire_idle(ref, {
            ...policy,
            project_id: project,
            assignment_id: a.id,
            before_signal: () =>
              store.uow.read((tx) => {
                const state = loadCommandState(tx, project),
                  current = state.assignments.find((v) => v.id === a.id);
                if (
                  !current ||
                  current.idle_retirement?.phase !== "stopping" ||
                  JSON.stringify(current.runtime_ref) !== JSON.stringify(ref) ||
                  current.last_mcp_activity_at !==
                    pending.idle_retirement?.activity_at
                )
                  return false;
                if (
                  darwinWorker(state, current) &&
                  (store.listNotifications({
                    project_id: project,
                    assignment_id: a.id,
                    statuses: LIVE_NOTIFICATION_STATUSES,
                  }).length > 0 ||
                    state.assignments.some(
                      (other) =>
                        other.id !== current.id &&
                        other.status === "active" &&
                        other.machine_id === current.machine_id &&
                        (other.runtime_ref?.terminal_ref === ref.terminal_ref ||
                          (current.worktree_path &&
                            other.worktree_path === current.worktree_path)),
                    ))
                )
                  return false;
                const { idle_retirement: _pending, ...identity } = current;
                return sessionMaintenanceCandidate(
                  state,
                  identity as Assignment,
                  clock.now(),
                  threshold,
                ).candidate;
              }),
          });
          result = retired.ok
            ? retired.value
            : {
                outcome: "uncertain",
                evidence: {
                  ...pendingEvidence,
                  runtime_code: retired.error.code,
                },
              };
        }
      } catch {
        // No receipt: retain the initial observation-only or uncertain state.
      }
      store.uow.run((tx) => {
        const state = loadCommandState(tx, project);
        // A missing remote snapshot alone is not proof of exit. The human stop
        // path clears its exact ref only after successful release.
        if (
          pending.runtime_ref === null &&
          humanStopRecorded(state.events, a.id)
        )
          result = { outcome: "exited" };
        const retry = Math.min(
          policy.retry_max_ms,
          policy.retry_ms *
            2 ** Math.min(pending.idle_retirement?.failures ?? 0, 30),
        );
        const effect = unwrap(
          settleIdleSessionRetirement(
            state,
            { kind: "system", project_id: project },
            a.id,
            result,
            retry,
            { ids: tx.ids, clock },
          ),
        );
        persistRetirement(store, tx, project, effect);
        if (effect.events.some((e) => e.type === "session_replaced"))
          revokeRetiredTokens(tx, project, a.id);
      });
    } catch {
      // A failed settlement retains its durable fence; unrelated owners can continue.
      console.error("Idle session retirement could not be settled");
    } finally {
      try {
        await unlockLaunch?.();
      } finally {
        await unlock();
      }
    }
  }
  return attempted;
}
