import { isDeepStrictEqual } from "node:util";
import {
  type Assignment,
  type Clock,
  type CommandState,
  type ProjectId,
  type Runtime,
  type RuntimeRef,
  releaseUnresponsiveSession,
  UNRESPONSIVE_PROBE_LIMIT,
  type UnresponsiveRelease,
  unresponsiveReleaseBlocker,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { type Store, unfinishedBellAttempts } from "@cardigan/store";
import type { ResolveActivityExecution } from "./context-usage.js";
import { tryHostOpsLock } from "./host-ops-lock.js";
import { revokeRetiredTokens } from "./idle-session-retirement.js";
import { registeredLaunchState, sessionExitProof } from "./stall-evidence.js";

/** The runtime router can name the worker execution of a remote session. */
export type UnresponsiveRuntime = Runtime & {
  executionForRef?: ResolveActivityExecution;
};

/** C-730: consecutive `probe_invalid` withdrawals before maintenance releases. */
export function unresponsiveProbeLimit() {
  const raw = process.env.CARDIGAN_UNRESPONSIVE_PROBE_LIMIT;
  if (raw === undefined) return UNRESPONSIVE_PROBE_LIMIT;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || value < 1 || value > 100)
    throw new Error("Invalid CARDIGAN_UNRESPONSIVE_PROBE_LIMIT");
  return value;
}

export type UnresponsiveOutcome =
  | { readonly outcome: "settled" }
  | { readonly outcome: "refused"; readonly reason: string };

const refused = (reason: string): UnresponsiveOutcome => ({
  outcome: "refused",
  reason,
});
const sameRef = (a: RuntimeRef | null, b: RuntimeRef | null) =>
  isDeepStrictEqual(a, b);

async function executionOf(
  runtime: UnresponsiveRuntime,
  ref: RuntimeRef,
  project: ProjectId,
): Promise<ExecutionConfig | undefined> {
  try {
    return await runtime.executionForRef?.(ref, project);
  } catch {
    return undefined;
  }
}

/**
 * C-730: the process evidence around releasing a session. Only positive
 * evidence counts: a failed, timed-out, incomplete or mismatched observation
 * is never read as "the Agent is gone".
 */
export interface UnresponsiveProof {
  /** Before closing: "gone" only on positive proof the Agent CLI exited. */
  agent(
    runtime: UnresponsiveRuntime,
    state: CommandState,
    a: Assignment,
    ref: RuntimeRef,
  ): Promise<"gone" | "alive" | "unknown">;
  /** After closing: true only on positive proof the whole session exited. */
  sessionGone(
    runtime: UnresponsiveRuntime,
    state: CommandState,
    a: Assignment,
    ref: RuntimeRef,
  ): Promise<boolean>;
}

async function localGone(
  runtime: UnresponsiveRuntime,
  owner: { project_id: ProjectId; assignment_id: Assignment["id"] },
  ref: RuntimeRef,
  checks: readonly ("confirm_local_group_exit" | "confirm_local_exit")[],
) {
  if (!ref.local_process_receipt) return false;
  for (const check of checks) {
    const gone = await runtime[check]
      ?.call(runtime, ref, owner)
      .catch(() => undefined);
    if (gone?.ok && gone.value) return true;
  }
  return false;
}

/**
 * The worker's evidence.
 * - Before closing, remote: the terminal observation must answer and not say
 *   alive, AND the worker launch journal must be read, match this exact
 *   registration and observe the registered CLI's birth identity gone (its
 *   launcher may still hold the process group). A journal that cannot be
 *   read, times out, mismatches or is missing keeps the session.
 * - Before closing, local: the kernel proves the receipt's process group gone.
 * - After closing, remote: the C-663 proof of `assignment stop`: terminal row
 *   finished or gone, and the journal shows no process of the launch left,
 *   including its whole process group. Local: the kernel receipt checks.
 */
export const workerProof: UnresponsiveProof = {
  async agent(runtime, state, a, ref) {
    const owner = { project_id: state.project_id, assignment_id: a.id };
    if (a.machine_id === "local")
      return (await localGone(runtime, owner, ref, [
        "confirm_local_group_exit",
      ]))
        ? "gone"
        : "unknown";
    const observed = await runtime
      .observe_retirement?.(ref, owner)
      .catch(() => undefined);
    if (!observed?.ok) return "unknown";
    if (observed.value === "alive") return "alive";
    const cli = await registeredLaunchState(
      state,
      a,
      await executionOf(runtime, ref, state.project_id),
      true,
    );
    return cli === "exited" ? "gone" : cli === "alive" ? "alive" : "unknown";
  },
  async sessionGone(runtime, state, a, ref) {
    const owner = { project_id: state.project_id, assignment_id: a.id };
    if (a.machine_id === "local")
      return localGone(runtime, owner, ref, [
        "confirm_local_group_exit",
        "confirm_local_exit",
      ]);
    return (
      (await sessionExitProof(
        state,
        a,
        runtime,
        await executionOf(runtime, ref, state.project_id),
      )) === "exited"
    );
  },
};

/**
 * C-730: release one session whose Agent no longer answers while its terminal
 * stays live, like a managed `cardigan assignment stop`: under both host-ops
 * locks, with the domain guard re-read before and after the observation, only
 * when the Agent CLI is not observed alive, then close the terminal, prove the
 * session gone and settle it (`releaseUnresponsiveSession`). Credentials of the
 * session are revoked; queued work starts a new session through dispatch.
 */
export async function releaseUnresponsiveAgent(
  store: Store,
  project: ProjectId,
  a: Assignment,
  runtime: UnresponsiveRuntime,
  clock: Clock,
  request: UnresponsiveRelease,
  proof: UnresponsiveProof = workerProof,
): Promise<UnresponsiveOutcome> {
  const ref = a.runtime_ref;
  if (!ref) return refused("no_session");
  const live = await runtime.status(ref).catch(() => undefined);
  if (!live?.ok || live.value.process !== "alive")
    return refused("terminal_not_live");
  const unlock = await tryHostOpsLock(store, project, a.id);
  if (!unlock) return refused("locked");
  try {
    const unlockLaunch = await tryHostOpsLock(store, project, a.id, "launch");
    if (!unlockLaunch) return refused("locked");
    try {
      const current = () =>
        store.uow.read((tx) => {
          const state = loadCommandState(tx, project);
          const owner = state.assignments.find((v) => v.id === a.id);
          if (!owner || !sameRef(owner.runtime_ref, ref))
            return { reason: "session_changed" } as const;
          const blocker = unresponsiveReleaseBlocker(state, owner, request);
          if (blocker) return { reason: blocker } as const;
          if (unfinishedBellAttempts(store.database, project, a.id).length)
            return { reason: "delivery_in_progress" } as const;
          return { state, owner } as const;
        });
      const before = current();
      if ("reason" in before) return refused(before.reason);
      const agent = await proof.agent(runtime, before.state, before.owner, ref);
      if (agent !== "gone")
        return refused(agent === "alive" ? "agent_alive" : "agent_unobserved");
      const checked = current();
      if ("reason" in checked) return refused(checked.reason);
      const closed = await runtime
        .release(ref, { force: true })
        .catch(() => undefined);
      if (!closed?.ok && closed?.error.code !== "runtime_not_found")
        return refused("release_failed");
      if (
        !(await proof.sessionGone(runtime, checked.state, checked.owner, ref))
      )
        return refused("exit_unconfirmed");
      return store.uow.run((tx) => {
        const effect = releaseUnresponsiveSession(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          a.id,
          ref,
          request,
          { ids: tx.ids, clock },
        );
        // A changed owner keeps its reference; the closed terminal then
        // reads as not found and takes the ordinary replacement path.
        if (!effect.ok) return refused("session_changed");
        persistEffect(tx, project, effect.value);
        revokeRetiredTokens(tx, project, a.id);
        return { outcome: "settled" } as const;
      });
    } finally {
      await unlockLaunch();
    }
  } catch {
    console.error("Session of an unresponsive Agent could not be released");
    return refused("failed");
  } finally {
    await unlock();
  }
}

/** C-730: per-session pause after a refused maintenance attempt. */
const BACKOFF_MIN_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const backoffs = new WeakMap<
  Store,
  Map<string, { until: number; delay: number }>
>();

/**
 * C-730: maintenance pass; every eligible session of this project, bounded.
 * A session whose evidence was refused (alive, unobserved, not closable or not
 * proven exited) is not probed again for 5 minutes, doubling up to an hour,
 * so a live Agent with a dirty checkout is not observed every minute.
 */
export async function releaseUnresponsiveAgents(
  store: Store,
  project: ProjectId,
  runtime: UnresponsiveRuntime,
  clock: Clock,
  limit: number,
  proof: UnresponsiveProof = workerProof,
) {
  const request = {
    trigger: "probe_invalid",
    limit: unresponsiveProbeLimit(),
  } as const;
  const now = Date.parse(clock.now());
  const backoff = backoffs.get(store) ?? new Map();
  backoffs.set(store, backoff);
  const key = (a: Assignment) =>
    JSON.stringify([project, a.id, a.runtime_ref?.terminal_ref]);
  const candidates = store.uow.read((tx) => {
    const state = loadCommandState(tx, project);
    return state.assignments.filter(
      (a) => !unresponsiveReleaseBlocker(state, a, request),
    );
  });
  const eligible = new Set(candidates.map(key));
  for (const k of backoff.keys())
    if (JSON.parse(k)[0] === project && !eligible.has(k)) backoff.delete(k);
  let attempted = 0;
  for (const a of candidates) {
    if (attempted >= limit) break;
    const k = key(a);
    if ((backoff.get(k)?.until ?? 0) > now) continue;
    attempted++;
    const result = await releaseUnresponsiveAgent(
      store,
      project,
      a,
      runtime,
      clock,
      request,
      proof,
    );
    if (result.outcome === "settled") {
      backoff.delete(k);
      continue;
    }
    if (
      [
        "agent_alive",
        "agent_unobserved",
        "release_failed",
        "exit_unconfirmed",
        "terminal_not_live",
      ].includes(result.reason)
    ) {
      const delay = Math.min(
        BACKOFF_MAX_MS,
        (backoff.get(k)?.delay ?? BACKOFF_MIN_MS / 2) * 2,
      );
      backoff.set(k, { until: now + delay, delay });
    }
    if (result.reason === "exit_unconfirmed")
      console.error(
        `${a.id}: terminal of an unresponsive Agent closed, exit unconfirmed`,
      );
  }
  return attempted;
}
