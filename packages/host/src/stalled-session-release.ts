import { isDeepStrictEqual } from "node:util";
import {
  type Assignment,
  assignmentCardHeld,
  assignmentDependenciesAllowStart,
  type CardId,
  type Clock,
  type CommandState,
  eventsOfType,
  hasRunTarget,
  type Notification,
  type ProjectId,
  type Run,
  type Runtime,
  type RuntimeObservation,
  releaseUnresponsiveSession,
  retirementWithdrawals,
  runsOf,
  sessionTurnEnded,
  systemEndedTurn,
  type UnresponsiveRelease,
  unresponsiveReleaseBlocker,
  untouchedStallSuccessor,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { type Store, unfinishedBellAttempts } from "@cardigan/store";
import { tryHostOpsLock } from "./host-ops-lock.js";
import { revokeRetiredTokens } from "./idle-session-retirement.js";
import { sessionExitProof, stallWorkspace } from "./stall-evidence.js";
import { stoppedSessionExited, stoppedSessionLive } from "./stop-run.js";

/**
 * C-739: how long work may wait on a live session the dispatcher cannot use
 * (an unconfirmed system-ended turn, or a session whose idle retirement keeps
 * withdrawing) before the stall patrol releases that session itself. `0`
 * turns the automatic release off (the PM handoff stays). Invalid values
 * fail host startup.
 */
export const DEFAULT_STALLED_SESSION_RELEASE_MS = 180_000;
export function stalledSessionReleaseMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const raw = env.CARDIGAN_STALLED_SESSION_RELEASE_MS;
  if (raw === undefined || raw === "")
    return DEFAULT_STALLED_SESSION_RELEASE_MS;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value > 3_600_000)
    throw new Error("Invalid CARDIGAN_STALLED_SESSION_RELEASE_MS");
  return value;
}

/**
 * C-759: how long a never-started queued Run may wait on a live session whose
 * previous turn ended and whose CLI reports `done` before the stall patrol
 * releases that session (clean checkout only). Resource machines need a fresh
 * session for each Run, so such a session blocks the queue until it ends
 * (sensen A-461 on cardigan-ci: 30 minutes). `0` turns it off.
 */
export const DEFAULT_DONE_SESSION_RELEASE_MS = 600_000;
export function doneSessionReleaseMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const raw = env.CARDIGAN_DONE_SESSION_RELEASE_MS;
  if (raw === undefined || raw === "") return DEFAULT_DONE_SESSION_RELEASE_MS;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value > 3_600_000)
    throw new Error("Invalid CARDIGAN_DONE_SESSION_RELEASE_MS");
  return value;
}

/** C-739: retirements given up (withdrawn or handed back) before releasing. */
export const RETIREMENT_WITHDRAWAL_LIMIT = 2;

/** Event recording that the patrol did not release a stalled session, for PM. */
export const SESSION_RELEASE_HELD = "session_release_held";

/** The managed release a PM (or the human) can run: `assignment stop` without `--hold`. */
export function managedReleaseCommand(id: Assignment["id"]) {
  return `cardigan assignment stop ${id}`;
}

export interface StalledSession {
  readonly trigger: "system_turn" | "retirement_withdrawn" | "turn_done";
  readonly assignment: Assignment;
  readonly card_id: CardId | null;
  /** One key per incident: handoff dedupe and patrol backoff. */
  readonly incident: string;
  /** The Run the system finished (system_turn). */
  readonly turn?: Run;
  /** Retirements given up since the session's last sign of life. */
  readonly withdrawals?: number;
  /** Since the work started waiting. */
  readonly since: string;
  readonly waited_ms: number;
  readonly queued_run_id?: Run["id"];
  readonly notification_ids: readonly string[];
}

const LIVE = new Set([
  "pending",
  "belled",
  "delivery_failed",
  "needs_attention",
]);
const ACTIONABLE = new Set([
  "todo",
  "ready",
  "in_progress",
  "changes_requested",
]);
const unfinished = (r: Run) =>
  !["completed", "failed", "cancelled"].includes(r.status);

/**
 * C-739: live work-item sessions the dispatcher has not been able to use
 * for at least `ms` while work waits for them:
 * - `system_turn`: the system finished the Run, and a never-started queued
 *   Run or a deferred notification is still undelivered since the
 *   dispatcher first deferred it, before the dispatcher's own turn recovery
 *   deadline (from then on that recovery owns the incident);
 * - `retirement_withdrawn`: no Run is running, a notification for the
 *   Assignment or a never-started queued Run has waited since `since`, and
 *   idle retirement of this session was given up at least twice since its
 *   last sign of life (C-690 hands the session back for business work, the
 *   session is reclaimed, and nothing ever wakes it).
 * - C-759 `turn_done` (threshold `doneMs`, `0` off): the session's previous
 *   turn ended (no Run on it is unfinished except untouched queued ones it
 *   was not launched for), and a never-started queued Run has waited since
 *   both its queueing and the session's last sign of life. The patrol also
 *   requires the CLI to report `done` before releasing.
 * `ms` of `0` turns the first two triggers off.
 */
export function stalledSessions(
  state: CommandState,
  notes: readonly Notification[],
  now: string,
  ms: number,
  doneMs = 0,
): StalledSession[] {
  const live = notes.filter((n) => LIVE.has(n.status));
  const liveIds = new Set(live.map((n) => n.id));
  const deferrals = eventsOfType(state.events, "bell_wake_deferred").filter(
    (e) =>
      e.actor.kind === "system" &&
      (e.payload as { reason?: string }).reason === "system_finished_turn",
  );
  const due = new Set(
    eventsOfType(state.events, "bell_turn_recovery_due").map((e) => {
      const p = e.payload as { assignment_id?: string; run_id?: string };
      return `${p.assignment_id}/${p.run_id}`;
    }),
  );
  const found: StalledSession[] = [];
  for (const a of state.assignments) {
    if (
      a.scope !== "work_item" ||
      a.status !== "active" ||
      a.external ||
      !a.runtime_ref
    )
      continue;
    const card_id =
      state.work_items.find((w) => w.id === a.work_item_id)?.card_id ?? null;
    const runs = runsOf(state.runs, a.id);
    const queued = runs.find((r) => untouchedStallSuccessor(state, a, r));
    const turn = systemEndedTurn(state, a);
    if (turn) {
      if (!(ms > 0)) continue;
      if (due.has(`${a.id}/${turn.id}`)) continue;
      const own = deferrals.filter((e) => {
        const p = e.payload as { assignment_id?: string; run_id?: string };
        return p.assignment_id === a.id && p.run_id === turn.id;
      });
      const since = earliest(own.map((e) => e.created_at));
      if (!since) continue;
      const waited_ms = Date.parse(now) - Date.parse(since);
      if (!(waited_ms >= ms)) continue;
      const notification_ids = [
        ...new Set(
          own.flatMap(
            (e) =>
              (e.payload as { notification_ids?: string[] }).notification_ids ??
              [],
          ),
        ),
      ].filter((id) => liveIds.has(id));
      if (!queued && !notification_ids.length) continue;
      found.push({
        trigger: "system_turn",
        assignment: a,
        card_id,
        incident: turn.id,
        turn,
        since,
        waited_ms,
        ...(queued ? { queued_run_id: queued.id } : {}),
        notification_ids,
      });
      continue;
    }
    if (runs.some((r) => unfinished(r) && r !== queued)) continue;
    if (a.idle_retirement && a.idle_retirement.phase !== "waiting") continue;
    // Only work the dispatcher would start now; a held card, an unmet
    // dependency or a waiting work item is not a stalled session.
    const item = state.work_items.find((w) => w.id === a.work_item_id);
    if (
      !item ||
      !ACTIONABLE.has(item.status) ||
      assignmentCardHeld(a, state) ||
      !assignmentDependenciesAllowStart(state, a) ||
      !hasRunTarget(a, state)
    )
      continue;
    const withdrawals = retirementWithdrawals(state, a);
    if (!(ms > 0) || withdrawals < RETIREMENT_WITHDRAWAL_LIMIT) {
      const done = doneMs > 0 && queued && turnDone(state, a, queued, now);
      if (done && done.waited_ms >= doneMs)
        found.push({
          trigger: "turn_done",
          assignment: a,
          card_id,
          incident: `${a.runtime_ref.terminal_ref}@${queued.id}`,
          since: done.since,
          waited_ms: done.waited_ms,
          queued_run_id: queued.id,
          notification_ids: [],
        });
      continue;
    }
    const waiting = live.filter(
      (n) =>
        n.recipient.kind === "assignment" &&
        n.recipient.assignment_id === a.id &&
        n.status !== "belled",
    );
    const since = earliest([
      ...waiting.map((n) => n.created_at),
      ...(queued?.queue_entered_at ? [queued.queue_entered_at] : []),
    ]);
    if (!since) continue;
    const waited_ms = Date.parse(now) - Date.parse(since);
    if (!(waited_ms >= ms)) continue;
    found.push({
      trigger: "retirement_withdrawn",
      assignment: a,
      card_id,
      incident: `${a.runtime_ref.terminal_ref}@${since}`,
      withdrawals,
      since,
      waited_ms,
      ...(queued ? { queued_run_id: queued.id } : {}),
      notification_ids: waiting.map((n) => n.id),
    });
  }
  return found;
}
/** C-759: since when `queued` waits on this ended turn's idle session. */
function turnDone(
  state: CommandState,
  a: Assignment,
  queued: Run,
  now: string,
) {
  if (!sessionTurnEnded(state, a)) return;
  const since = Math.max(
    Date.parse(queued.queue_entered_at ?? "") || 0,
    Date.parse(a.last_mcp_activity_at ?? "") || 0,
    ...runsOf(state.runs, a.id).flatMap((r) =>
      [r.started_at, r.finished_at].map((at) => Date.parse(at ?? "") || 0),
    ),
  );
  if (!since) return;
  return {
    since: new Date(since).toISOString(),
    waited_ms: Date.parse(now) - since,
  };
}
function earliest(times: readonly string[]) {
  let min: string | undefined;
  for (const t of times) if (min === undefined || t < min) min = t;
  return min;
}

type Workspace = Awaited<ReturnType<typeof stallWorkspace>>;
export type StalledSessionDecision =
  | { readonly action: "skip"; readonly reason: string }
  | { readonly action: "release"; readonly workspace: "clean" | "no_worktree" }
  | { readonly action: "hand_off"; readonly reason: string };

/**
 * C-739: whether the patrol releases a stalled session.
 * - The ordinary turn recovery (an owner-bound idle stop) is preferred
 *   whenever its evidence allows it.
 * - Only a live terminal whose owner check answered for this Assignment
 *   (alive or "cannot tell") and whose CLI does not report work, an error or
 *   a prompt is released; a conflicting identity, a failed observation or an
 *   exit is left to the existing paths.
 * - The checkout must be clean (ignored files only) or absent. Anything
 *   else goes to PM with the reason instead.
 */
export function stalledSessionDecision(input: {
  readonly trigger?: StalledSession["trigger"];
  readonly can_restart: boolean;
  readonly status: RuntimeObservation | undefined;
  readonly owner: "alive" | "unknown" | "exited" | "unobserved";
  readonly workspace: Workspace;
}): StalledSessionDecision {
  if (input.can_restart)
    return { action: "skip", reason: "turn_recovery_available" };
  const s = input.status;
  if (!s || s.process !== "alive" || s.kept)
    return { action: "skip", reason: "terminal_not_live" };
  if (!["unknown", "idle", "done"].includes(s.agent))
    return { action: "skip", reason: `terminal_state=${s.agent}` };
  // C-759: an ended turn is released only on the CLI's own `done`.
  if (input.trigger === "turn_done" && s.agent !== "done")
    return { action: "skip", reason: `terminal_state=${s.agent}` };
  if (input.owner !== "alive" && input.owner !== "unknown")
    return { action: "skip", reason: `terminal_owner=${input.owner}` };
  if (input.workspace === "clean" || input.workspace === "no_worktree")
    return { action: "release", workspace: input.workspace };
  return { action: "hand_off", reason: `workspace=${input.workspace}` };
}

/** The domain request for this incident. */
export function stalledSessionRequest(
  s: StalledSession,
  workspace: "clean" | "no_worktree",
): UnresponsiveRelease {
  if (s.trigger === "turn_done" && s.queued_run_id)
    return {
      trigger: "turn_done",
      queued_run_id: s.queued_run_id,
      waited_ms: s.waited_ms,
      workspace,
    };
  return s.trigger === "system_turn" && s.turn
    ? {
        trigger: "system_turn",
        system_finished_run_id: s.turn.id,
        waited_ms: s.waited_ms,
        workspace,
      }
    : {
        trigger: "retirement_withdrawn",
        withdrawals: s.withdrawals ?? 0,
        waited_ms: s.waited_ms,
        workspace,
      };
}

export type StalledSessionRelease =
  | { readonly outcome: "settled" }
  | { readonly outcome: "refused"; readonly reason: string };
/** Reasons that may change by the next patrol pass without anyone acting. */
export const TRANSIENT_RELEASE_REFUSALS = new Set([
  "locked",
  "session_changed",
  "delivery_in_progress",
  "operation_pending",
  "run_changed",
  "run_busy",
  "withdrawal_streak",
  "session_maintenance",
  "no_longer_waiting",
  "terminal_not_done",
]);

const refused = (reason: string): StalledSessionRelease => ({
  outcome: "refused",
  reason,
});

/**
 * C-739: release a stalled session like a managed `cardigan assignment
 * stop` (no hold): under both host-ops locks, with the domain guard and the
 * waiting work re-read before and after observing, a clean checkout re-read
 * right before closing, then close the terminal, prove this session exited
 * (the release ended a live session it identified, or the kernel / worker
 * shows no process of the launch left) and settle it. Queued Runs stay as
 * pending work; the dispatcher starts them and the waiting notifications in
 * a new session. Without exit proof nothing is settled.
 */
export async function releaseStalledSession(
  store: Store,
  project: ProjectId,
  stalled: StalledSession,
  runtime: Runtime,
  clock: Clock,
  deps: {
    readonly execution?: ExecutionConfig | undefined;
    readonly signal?: AbortSignal | undefined;
    /** Still the same incident with work waiting (fresh state). */
    readonly stillWaiting: (state: CommandState, a: Assignment) => boolean;
    readonly scrubCredentials?:
      | ((
          project: ProjectId,
          id: Assignment["id"],
          ref: NonNullable<Assignment["runtime_ref"]>,
        ) => Promise<void>)
      | undefined;
  },
): Promise<StalledSessionRelease> {
  const a = stalled.assignment;
  const ref = a.runtime_ref;
  if (!ref) return refused("no_session");
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
          const blocker = unresponsiveReleaseBlocker(
            state,
            owner,
            stalledSessionRequest(stalled, "clean"),
          );
          if (blocker) return { reason: blocker } as const;
          if (unfinishedBellAttempts(store.database, project, a.id).length)
            return { reason: "delivery_in_progress" } as const;
          if (!deps.stillWaiting(state, owner))
            return { reason: "no_longer_waiting" } as const;
          return { state, owner } as const;
        });
      const before = current();
      if ("reason" in before) return refused(before.reason);
      const workspace = await stallWorkspace(
        before.state,
        before.owner,
        deps.execution,
        deps.signal,
        undefined,
        false,
        true,
      );
      if (workspace !== "clean" && workspace !== "no_worktree")
        return refused(`workspace=${workspace}`);
      const identity = { project_id: project, assignment_id: a.id };
      const live = await stoppedSessionLive(runtime, ref, identity);
      const checked = current();
      if ("reason" in checked) return refused(checked.reason);
      if (deps.signal?.aborted) return refused("aborted");
      if (stalled.trigger === "turn_done") {
        // C-759: the CLI must still report `done` right before closing.
        const again = await runtime.status(ref).catch(() => undefined);
        if (
          !again?.ok ||
          again.value.process !== "alive" ||
          again.value.agent !== "done" ||
          again.value.kept
        )
          return refused("terminal_not_done");
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
      const settled = store.uow.run((tx) => {
        const effect = releaseUnresponsiveSession(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          a.id,
          ref,
          stalledSessionRequest(stalled, workspace),
          { ids: tx.ids, clock },
        );
        // A changed owner keeps its reference; the closed terminal then
        // reads as not found and takes the ordinary replacement path.
        if (!effect.ok) return false;
        persistEffect(tx, project, effect.value);
        revokeRetiredTokens(tx, project, a.id);
        return true;
      });
      if (!settled) return refused("session_changed");
      await deps.scrubCredentials?.(project, a.id, ref).catch(() => undefined);
      return { outcome: "settled" };
    } finally {
      await unlockLaunch();
    }
  } catch {
    console.error("Stalled session could not be released");
    return refused("failed");
  } finally {
    await unlock();
  }
}

/** C-739: this ended turn's session was already released by the patrol. */
export function systemTurnReleased(
  state: CommandState,
  run: string | undefined,
) {
  return (
    !!run &&
    eventsOfType(state.events, "session_replaced").some(
      (e) =>
        (e.payload as { system_finished_run_id?: string })
          .system_finished_run_id === run,
    )
  );
}

/** C-739: the patrol already told PM why it did not release this incident. */
export function sessionReleaseHandedOff(
  state: CommandState,
  assignment: Assignment["id"],
  incident: string | undefined,
) {
  return (
    !!incident &&
    eventsOfType(state.events, SESSION_RELEASE_HELD).some((e) => {
      const p = e.payload as { assignment_id?: string; incident?: string };
      return p.assignment_id === assignment && p.incident === incident;
    })
  );
}
