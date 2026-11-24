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
import { registeredLaunchState } from "./stall-evidence.js";

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
 * Before closing: the Agent CLI must not be observed alive.
 * - Remote: the worker's terminal observation (macOS: the CLI's native birth
 *   identity under its labeled terminal) must answer and not say alive, and
 *   the worker launch journal must not show the registered CLI alive or be
 *   unreachable.
 * - Local: the kernel must prove the launch receipt's whole process group gone.
 */
async function agentState(
  runtime: UnresponsiveRuntime,
  state: CommandState,
  a: Assignment,
  ref: RuntimeRef,
): Promise<"alive" | "not_alive" | "unknown"> {
  const owner = { project_id: state.project_id, assignment_id: a.id };
  if (a.machine_id === "local") {
    if (!ref.local_process_receipt) return "unknown";
    const gone = await runtime
      .confirm_local_group_exit?.(ref, owner)
      .catch(() => undefined);
    return gone?.ok && gone.value ? "not_alive" : "unknown";
  }
  const observed = await runtime
    .observe_retirement?.(ref, owner)
    .catch(() => undefined);
  if (!observed?.ok) return "unknown";
  if (observed.value === "alive") return "alive";
  const launch = await registeredLaunchState(
    state,
    a,
    await executionOf(runtime, ref, state.project_id),
  );
  return launch === "alive"
    ? "alive"
    : launch === "unreachable"
      ? "unknown"
      : "not_alive";
}

/**
 * After closing: the session is gone. Its terminal row is finished or no
 * longer listed, and no process of the launch is observed: locally the
 * kernel receipt checks; remotely the worker journal (which also checks the
 * whole process group when it registered the launch) is neither alive nor
 * unreachable.
 */
async function sessionGone(
  runtime: UnresponsiveRuntime,
  state: CommandState,
  a: Assignment,
  ref: RuntimeRef,
) {
  const owner = { project_id: state.project_id, assignment_id: a.id };
  if (a.machine_id === "local") {
    for (const check of [
      runtime.confirm_local_group_exit,
      runtime.confirm_local_exit,
    ]) {
      const gone = await check
        ?.call(runtime, ref, owner)
        .catch(() => undefined);
      if (gone?.ok && gone.value) return true;
    }
    return false;
  }
  const terminal = await runtime.status(ref).catch(() => undefined);
  if (
    !(terminal?.ok
      ? terminal.value.process === "exited"
      : terminal?.error.code === "runtime_not_found")
  )
    return false;
  const launch = await registeredLaunchState(
    state,
    a,
    await executionOf(runtime, ref, state.project_id),
  );
  return launch === "exited" || launch === "unknown";
}

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
      const agent = await agentState(runtime, before.state, before.owner, ref);
      if (agent !== "not_alive")
        return refused(agent === "alive" ? "agent_alive" : "agent_unobserved");
      const checked = current();
      if ("reason" in checked) return refused(checked.reason);
      const closed = await runtime
        .release(ref, { force: true })
        .catch(() => undefined);
      if (!closed?.ok && closed?.error.code !== "runtime_not_found")
        return refused("release_failed");
      if (!(await sessionGone(runtime, checked.state, checked.owner, ref)))
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

/** C-730: maintenance pass; every eligible session of this project, bounded. */
export async function releaseUnresponsiveAgents(
  store: Store,
  project: ProjectId,
  runtime: UnresponsiveRuntime,
  clock: Clock,
  limit: number,
) {
  const request = {
    trigger: "probe_invalid",
    limit: unresponsiveProbeLimit(),
  } as const;
  const candidates = store.uow.read((tx) => {
    const state = loadCommandState(tx, project);
    return state.assignments.filter(
      (a) => !unresponsiveReleaseBlocker(state, a, request),
    );
  });
  let released = 0;
  for (const a of candidates) {
    if (released >= limit) break;
    const result = await releaseUnresponsiveAgent(
      store,
      project,
      a,
      runtime,
      clock,
      request,
    );
    if (result.outcome === "settled") released++;
    else if (result.reason === "exit_unconfirmed")
      console.error(
        `${a.id}: terminal of an unresponsive Agent closed, exit unconfirmed`,
      );
  }
  return released;
}
