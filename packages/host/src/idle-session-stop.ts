import { isDeepStrictEqual } from "node:util";
import {
  type Assignment,
  type Clock,
  type ProjectId,
  releaseUnresponsiveSession,
  type UnresponsiveRelease,
  unresponsiveReleaseBlocker,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { type Store, unfinishedBellAttempts } from "@cardigan/store";
import { tryHostOpsLock } from "./host-ops-lock.js";
import {
  boundIdlePrompt,
  idlePromptBinding,
  sessionHarness,
} from "./idle-prompt.js";
import { revokeRetiredTokens } from "./idle-session-retirement.js";
import { sessionExitProof } from "./stall-evidence.js";
import { stoppedSessionExited, stoppedSessionLive } from "./stop-run.js";
import {
  type UnresponsiveProof,
  type UnresponsiveRuntime,
  workerProof,
} from "./unresponsive-session.js";

export type IdleSessionStopRequest = Extract<
  UnresponsiveRelease,
  { trigger: "host_ops" }
> & { readonly tool: "host_ops_stop_assignment" };

/** Which positive evidence showed the session idle. */
export type IdleStopBasis = "agent_done" | "agent_exited" | "bound_idle_prompt";

export type IdleSessionStop =
  | { readonly outcome: "settled"; readonly basis: IdleStopBasis }
  | { readonly outcome: "refused"; readonly reason: string };

const refused = (reason: string): IdleSessionStop => ({
  outcome: "refused",
  reason,
});

/**
 * C-759: a host operator's managed stop of a session whose previous turn
 * ended, like a human `cardigan assignment stop` without `--hold`: the
 * terminal is closed, the exit proven, the session settled and its
 * credentials revoked; the worktree, branch and identity stay, never-started
 * queued Runs stay as pending work and no new Run is queued.
 *
 * Only when it is clearly idle:
 * - the domain guard (`unresponsiveReleaseBlocker` with this tool): no human
 *   stop, host operation, role upgrade, launch or stop in flight, no other
 *   registration, and no Run on the session is unfinished except untouched
 *   queued ones the session was not launched for;
 * - no bell is being delivered to it;
 * - the CLI itself reports `done` (re-read right before closing), or the
 *   worker shows the Agent CLI gone (C-730 positive proof), or (C-838) hc
 *   has no activity for this Claude Code / Codex session (`unknown`) and the
 *   bound CLI shows its empty editor with its own idle footer (read again
 *   right before closing).
 * Anything else (working, blocked, a turn, a draft or confirmation on
 * screen, unobserved) keeps the session.
 */
export async function stopIdleSession(
  store: Store,
  project: ProjectId,
  a: Assignment,
  runtime: UnresponsiveRuntime,
  clock: Clock,
  request: IdleSessionStopRequest,
  deps: {
    readonly execution?: ExecutionConfig | undefined;
    readonly proof?: UnresponsiveProof | undefined;
  } = {},
): Promise<IdleSessionStop> {
  const ref = a.runtime_ref;
  if (!ref) return refused("no_session");
  const proof = deps.proof ?? workerProof;
  const observe = async () => {
    const s = await runtime.status(ref).catch(() => undefined);
    return s?.ok ? s.value : undefined;
  };
  const status = await observe();
  if (!status) return refused("terminal_unobserved");
  if (status.process !== "alive") return refused("terminal_not_live");
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
          if (!owner || !isDeepStrictEqual(owner.runtime_ref, ref))
            return { reason: "session_changed" } as const;
          const blocker = unresponsiveReleaseBlocker(state, owner, request);
          if (blocker) return { reason: blocker } as const;
          if (unfinishedBellAttempts(store.database, project, a.id).length)
            return { reason: "delivery_in_progress" } as const;
          return { state, owner } as const;
        });
      const before = current();
      if ("reason" in before) return refused(before.reason);
      let basis: IdleStopBasis;
      const prompt =
        status.agent === "unknown" && !status.kept
          ? idlePromptBinding(
              project,
              before.owner,
              sessionHarness(before.state, before.owner),
            )
          : undefined;
      if (status.agent === "done" && !status.kept) basis = "agent_done";
      else if (prompt && (await boundIdlePrompt(runtime, ref, prompt)))
        basis = "bound_idle_prompt";
      else {
        const agent = await proof.agent(
          runtime,
          before.state,
          before.owner,
          ref,
        );
        if (agent !== "gone")
          return refused(
            agent === "alive" ? `agent_${status.agent}` : "agent_unobserved",
          );
        basis = "agent_exited";
      }
      const identity = { project_id: project, assignment_id: a.id };
      const live = await stoppedSessionLive(runtime, ref, identity);
      const checked = current();
      if ("reason" in checked) return refused(checked.reason);
      if (basis === "agent_done") {
        // The CLI must still be idle right before its terminal is closed.
        const again = await observe();
        if (again?.process !== "alive" || again.agent !== "done" || again.kept)
          return refused(`agent_${again?.agent ?? "unobserved"}`);
      }
      if (basis === "bound_idle_prompt") {
        // Still no reported activity and still the empty editor.
        const again = await observe();
        if (
          again?.process !== "alive" ||
          again.agent !== "unknown" ||
          again.kept ||
          !(await boundIdlePrompt(runtime, ref, prompt))
        )
          return refused(`agent_${again?.agent ?? "unobserved"}`);
      }
      const closed = await runtime
        .release(ref, { force: true })
        .catch(() => undefined);
      if (!closed?.ok && closed?.error.code !== "runtime_not_found")
        return refused("release_failed");
      // As `assignment stop`: its own release proves the exit only when it
      // ended a live session of this identity; otherwise the kernel (local)
      // or the worker launch journal (remote) must show nothing left.
      const verdict =
        live && closed?.ok
          ? "exited"
          : await stoppedSessionExited(runtime, ref, identity, () =>
              sessionExitProof(
                checked.state,
                checked.owner,
                runtime,
                deps.execution,
              ),
            );
      if (verdict !== "exited") return refused(`exit_unconfirmed:${verdict}`);
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
        return { outcome: "settled", basis } as const;
      });
    } finally {
      await unlockLaunch();
    }
  } catch {
    console.error("Idle session could not be stopped");
    return refused("failed");
  } finally {
    await unlock();
  }
}
