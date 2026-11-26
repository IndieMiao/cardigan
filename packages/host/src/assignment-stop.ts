import { setTimeout as sleep } from "node:timers/promises";
import type {
  Actor,
  Assignment,
  CommandEffect,
  CommandPorts,
  CommandState,
  ProjectId,
  Result,
  Runtime,
  RuntimeError,
  RuntimeRef,
} from "@cardigan/domain";
import {
  pausedByHuman,
  stopExitConfirmed,
  stopWorkItemAssignment,
} from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import { launchEntities } from "./commands.js";
import { messageOf } from "./errors.js";
import { tryHostOpsLock } from "./host-ops-lock.js";
import { scrubRunCredentials } from "./launch.js";
import { RuntimeTargets } from "./runtime-targets.js";
import type { SessionExitVerdict } from "./stall-evidence.js";
import {
  stoppedSessionExited,
  stoppedSessionLive,
  storedSessionExitProof,
} from "./stop-run.js";

/**
 * C-703: a work-item stop that changed nothing, or stopped short of the
 * settlement. `usage` = nothing to stop or a bad request; `failure` = the
 * host could not finish (retry). `runtime` carries the release error.
 */
export class AssignmentStopError extends Error {
  constructor(
    message: string,
    readonly kind: "usage" | "failure",
    readonly runtime?: RuntimeError,
  ) {
    super(message);
    this.name = "AssignmentStopError";
  }
}

/** One stop command applied as the caller's actor; the caller maps refusals. */
export type AssignmentStopCommand = <T>(
  reduce: (
    state: CommandState,
    actor: Actor,
    ports: CommandPorts,
  ) => Result<CommandEffect<T>>,
) => T;

export interface WorkItemStopInput {
  readonly store: Store;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly runtime: Runtime;
  readonly execution?: ExecutionConfig | undefined;
  /** C-620: explicit pause; without it new work wakes a fresh session after release. */
  readonly hold?: boolean | undefined;
  /** Summary recorded on the cancelled Runs. */
  readonly reason?: string | undefined;
  readonly apply: AssignmentStopCommand;
}

export interface WorkItemStopResult {
  readonly released: boolean;
  readonly aborted: boolean;
  readonly held?: boolean;
  /** C-620: the session this call was asked to stop was settled or replaced. */
  readonly stale?: boolean;
}

/**
 * `cardigan assignment stop` for a work-item Assignment (moved from the CLI by
 * C-703 so the Workbench runs the same managed flow): release the terminal,
 * keep the worktree.
 */
export async function stopWorkItemSession(
  input: WorkItemStopInput,
): Promise<WorkItemStopResult> {
  const { assignment } = entities(input);
  const ref = assignment.runtime_ref;
  if (ref === null && hasQueuedRun(input.store, input.project_id, assignment)) {
    // C-624: a queued Run without a terminal (for example a start that waited
    // for capacity) can still be withdrawn: record the stop and cancel it.
    // C-620: always a pause here. A managed stop keeps queued work and lifts
    // itself only on a terminal release, which never comes without a terminal.
    const stopped = input.apply((s, a, p) =>
      stopWorkItemAssignment(
        s,
        a,
        { assignment_id: assignment.id, reason: reasonOf(input), hold: true },
        p,
      ),
    );
    return { released: false, aborted: stopped.cancelled > 0, held: true };
  }
  if (ref === null) {
    throw new AssignmentStopError(
      `Assignment ${assignment.id} 没有在运行的终端，也没有排队的 Run，没有可停止的内容。`,
      "usage",
    );
  }
  // C-620: the whole work-item stop, from checking the session through
  // settlement, runs under the per-Assignment launch lock. Every new session
  // goes through `launchRun`, which takes the same lock. The call is bound to
  // the session it was asked to stop: if a successor started while it waited,
  // it changes nothing.
  const unlock = await launchLock(input.store, input.project_id, assignment.id);
  if (!unlock)
    throw new AssignmentStopError(
      `${assignment.id} 正在启动或交接会话，没有改动；稍后重试 cardigan assignment stop ${assignment.id}。`,
      "failure",
    );
  try {
    return await stopSession(input, ref);
  } finally {
    await unlock();
  }
}

function entities(input: WorkItemStopInput) {
  try {
    return launchEntities(input.store, input.project_id, input.assignment_id);
  } catch (error) {
    throw new AssignmentStopError(messageOf(error), "usage");
  }
}
const reasonOf = (input: WorkItemStopInput) =>
  input.reason ?? "stopped by host";

async function stopSession(
  input: WorkItemStopInput,
  expected: RuntimeRef,
): Promise<WorkItemStopResult> {
  const { assignment } = entities(input);
  const ref = assignment.runtime_ref;
  const events = () =>
    input.store.uow.read((tx) =>
      tx.events.listAfter(
        input.project_id,
        assignment.work_item_id &&
          tx.work_items.get(input.project_id, assignment.work_item_id)?.card_id,
        0,
      ),
    );
  // A late request for a session that was settled or replaced meanwhile.
  if (JSON.stringify(ref) !== JSON.stringify(expected) || ref === null)
    return { released: false, aborted: false, stale: true };
  const execution =
    input.runtime instanceof RuntimeTargets
      ? input.runtime.executionForRef(ref, input.project_id)
      : input.execution;
  const owner = { project_id: input.project_id, assignment_id: assignment.id };
  // C-620: a managed stop never downgrades an existing pause (domain rule).
  const held = input.hold === true || pausedByHuman(events(), assignment.id);
  const command = (extra: {
    released_runtime_ref?: RuntimeRef;
    exit_confirmed_ref?: RuntimeRef;
    hold?: boolean;
  }) =>
    input.apply((s, a, p) =>
      stopWorkItemAssignment(
        s,
        a,
        { assignment_id: assignment.id, reason: reasonOf(input), ...extra },
        p,
      ),
    );
  // C-211: persist the stop before touching the terminal: from here on the
  // Dispatcher starts no session for this Assignment until the stop settles
  // (a pause: until the human runs `cardigan assignment start`). The running
  // Run keeps its run slot until the terminal is released, so a failed
  // release can be retried and never under-counts capacity.
  const stopped = command({ hold: input.hold === true });
  // A retry reuses an exit this stop already proved; the terminal row may be
  // gone by now and is never looked for again.
  if (!stopExitConfirmed(events(), assignment.id, ref)) {
    const live = !held && (await stoppedSessionLive(input.runtime, ref, owner));
    const released = await input.runtime.release(ref, { force: true });
    if (!released.ok && released.error.code !== "runtime_not_found") {
      // C-663: an unreachable worker says nothing about the session either way.
      if (
        !held &&
        ref.machine_id !== "local" &&
        released.error.code === "runtime_unavailable"
      )
        throw new AssignmentStopError(
          unconfirmedExitMessage(assignment.id, "unreachable"),
          "failure",
        );
      throw new AssignmentStopError(
        released.error.message,
        "failure",
        released.error,
      );
    }
    // §9.1: the session is ending, so its tokens die with it, even before
    // its exit is proven. A successor is issued new ones.
    revokeTokens(input.store, input.project_id, assignment.id);
    // A managed stop lifts its fence and lets new work start a session, so it
    // needs this session's exit proven. Its own release proves it only when
    // it ended a live session; a finished or missing terminal row does not.
    // A pause keeps the C-211 rule.
    if (!held) {
      const verdict =
        live && released.ok
          ? "exited"
          : await stoppedSessionExited(input.runtime, ref, owner, () =>
              storedSessionExitProof(
                input.store,
                input.project_id,
                assignment.id,
                ref,
                input.runtime,
                execution,
              ),
            );
      if (verdict !== "exited")
        throw new AssignmentStopError(
          unconfirmedExitMessage(assignment.id, verdict),
          "failure",
        );
      command({ exit_confirmed_ref: ref });
    }
  }
  // Clean up before settling: a failure keeps the stop, the reference and
  // any recorded exit, so the same command can be retried.
  revokeTokens(input.store, input.project_id, assignment.id);
  if (execution)
    await scrubRunCredentials(
      execution,
      input.project_id,
      input.assignment_id,
      ref,
    );
  const settled = command({ released_runtime_ref: ref });
  return {
    released: true,
    aborted: stopped.cancelled + settled.cancelled > 0,
    held,
  };
}

/**
 * C-663: say why the exit could not be proven and what is safe next. A pause
 * followed by a start launches a second session, so it is only safe once the
 * old one is known to be gone; an unreachable worker proves nothing.
 */
export function unconfirmedExitMessage(
  id: Assignment["id"],
  verdict: Exclude<SessionExitVerdict, "exited">,
): string {
  const reason = {
    terminal_alive: "原终端仍在运行",
    process_alive: "原终端已不在，但 worker 上仍有该指派登记的进程",
    unreachable: "worker 暂时无法连接，查不到原终端和进程",
    unproven:
      "没有可核对的进程登记（如旧版启动或主机重启后），无法用进程证明它已退出",
  }[verdict];
  const next = {
    terminal_alive: `稍后重试 cardigan assignment stop ${id}；不要用 --hold 再 start 绕过，否则会有两个会话同时工作。`,
    process_alive: `等该进程结束后重试 cardigan assignment stop ${id}；不要用 --hold 再 start 绕过，否则会有两个会话同时工作。`,
    unreachable: `恢复 worker 连接后重试 cardigan assignment stop ${id}，系统会重新核对；连接恢复前不要用 --hold 再 start。`,
    unproven: `在 worker 上核实该指派的终端和进程都已不在后，执行 cardigan assignment stop ${id} --hold 再 cardigan assignment start ${id} 是安全的；未核实前不要这样做。`,
  }[verdict];
  return `未能确认 ${id} 的原会话已退出：${reason}。停止状态和终端引用均已保留，不会另起会话。${next}`;
}

function revokeTokens(
  store: Store,
  project: ProjectId,
  assignment: Assignment["id"],
) {
  const revoked = store.uow.run((tx) =>
    tx
      .tokensForAssignment(project, assignment)
      .filter((token) => token.revoked_at === null)
      .map((token) => tx.revokeToken(token.id)),
  );
  if (revoked.some((ok) => !ok))
    throw new AssignmentStopError("作废 Token 失败", "failure");
}

/** Short wait for a launch or wake that is already in its critical section. */
async function launchLock(
  store: Store,
  project: ProjectId,
  assignment: Assignment["id"],
) {
  for (let attempt = 0; ; attempt++) {
    const unlock = await tryHostOpsLock(store, project, assignment, "launch");
    if (unlock || attempt >= 20) return unlock;
    await sleep(250);
  }
}

function hasQueuedRun(
  store: Store,
  project: ProjectId,
  assignment: Assignment,
): boolean {
  return store.uow.read((tx) =>
    tx.runs
      .list(project)
      .some((r) => r.assignment_id === assignment.id && r.status === "queued"),
  );
}
