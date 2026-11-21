import {
  type Assignment,
  type AssignmentId,
  beginIdleSessionRetirement,
  type Clock,
  type CommandEffect,
  confirmWaitingRetirementExit,
  type ProjectId,
  type RetirementDispatchWait,
  type RetirementEvidence,
  type RetirementSettlement,
  type RunId,
  type Runtime,
  type RuntimeErrorCode,
  retirementOwnsSession,
  runtimeErrorCodes,
  sessionMaintenanceCandidate,
  settleIdleSessionRetirement,
  stoppedByHuman,
  trackRetirementDispatch,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  recordNotification,
  type Store,
  type StoreTransactionContext,
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
          (a.idle_retirement?.phase === "stopping" ||
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
      });
  });
  let attempted = 0;
  for (const a of candidates) {
    if (attempted >= limit) break;
    if (Date.parse(a.idle_retirement?.retry_at ?? "") > Date.parse(clock.now()))
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
          JSON.stringify(current.runtime_ref) !== JSON.stringify(a.runtime_ref)
        )
          return;
        if (current.idle_retirement?.phase === "stopping")
          return { pending: current, recovering: true };
        const inFlight = store
          .listProjects()
          .flatMap((p) => tx.assignments.list(p.id))
          .filter(
            (owner) =>
              owner.status === "active" &&
              (owner.role_upgrade ||
                owner.idle_retirement?.phase === "stopping"),
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
        evidence: pendingEvidence,
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
        if (pending.runtime_ref === null && stoppedByHuman(state.events, a.id))
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
