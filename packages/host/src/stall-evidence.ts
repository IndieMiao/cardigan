import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type Assignment,
  type CommandState,
  type HostOpsExecution,
  idleWakeGuard,
  type RetirementIdentity,
  type Runtime,
  type RuntimeRef,
  sharedStallRegistration,
  systemTurnOwner,
  type TurnIdlePrompt,
} from "@cardigan/domain";
import { gitSafetyArguments } from "@cardigan/git-transport";
import {
  agentProcessCommand,
  type ExecutionConfig,
  executionPaths,
  runtimeOwnsRef,
  WorkerTransportUnavailable,
  workerFiles,
} from "@cardigan/runtime-herdr";
import { captureTranscript } from "./capture-transcript.js";

// An idle verifier's build checkout can already have been reclaimed. Only an
// actual missing entry (not EACCES, a symlink or a failed git command) counts.
const inspectBuild = `import os, stat, sys
for path in sys.argv[1:]:
    try: mode = os.lstat(path).st_mode
    except FileNotFoundError:
        print("missing")
        break
    if not stat.S_ISDIR(mode): sys.exit(1)
else: print("present")`;

// Only the verdict leaves the worker. Git may report names of private material,
// and a large listing must not be copied to the control host (even on failure).
const inspectStatus = String.raw`import subprocess, sys
def prefixes(args):
    with subprocess.Popen(sys.argv[1:] + args, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as p:
        prefix = b''
        while block := p.stdout.read(65536):
            parts = block.split(b'\0')
            for piece in parts[:-1]:
                yield prefix + piece[:3-len(prefix)]
                prefix = b''
            prefix += parts[-1][:3-len(prefix)]
        if prefix or p.wait(): sys.exit(1)
verdict = 'clean'
for tag in prefixes(['status','--porcelain=v1','-z','--untracked-files=normal','--ignored=matching','--ignore-submodules=none']):
    if tag not in (b'?? ', b'!! '): verdict = 'dirty'
    elif verdict == 'clean': verdict = 'local_only'
# Hidden edits and unmerged index entries are not ordinary retained changes.
for tag in prefixes(['ls-files','-v','-z']):
    if not tag.startswith(b'H '): verdict = 'unknown'
print(verdict)`;

/** No fallback from a remote Assignment to the controller or another registration. */
function boundWorkspaceTarget(
  project: CommandState["project_id"],
  a: Assignment,
  execution?: ExecutionConfig,
) {
  if (a.external) return false;
  if (a.machine_id === "local")
    return (
      !execution?.target ||
      (execution.target.project_id === project &&
        execution.target.machine_id === "local")
    );
  const ref = a.runtime_ref;
  return (
    execution?.mode === "agent-ssh" &&
    !!ref &&
    execution.target?.project_id === project &&
    execution.target.machine_id === a.machine_id &&
    runtimeOwnsRef(execution, ref)
  );
}

type Workspace = "clean" | "local_only" | "dirty" | "unknown" | "no_worktree";
// local_only never means backed up: the caller must keep this exact checkout.
export const writableInPlace = (workspace: Workspace) =>
  workspace === "clean" || workspace === "local_only";
/** Fixed placement only. Use the worker account for agent-ssh; never return paths, stderr or filenames. */
export async function stallWorkspace(
  state: CommandState,
  a: Assignment,
  execution?: ExecutionConfig,
  signal?: AbortSignal,
  expectedHead?: string,
  inPlace = false,
): Promise<Workspace> {
  if (!boundWorkspaceTarget(state.project_id, a, execution)) return "unknown";
  if (
    a.scope === "standing" &&
    !a.worktree_path &&
    !a.runtime_ref?.worktree_path
  )
    return "no_worktree";
  const role = state.roles.find(
    (r) => r.role_id === a.role_id && r.role_version === a.role_version,
  );
  if (
    !a.worktree_path &&
    !a.runtime_ref?.worktree_path &&
    role?.worktree === "none"
  )
    return "no_worktree";
  if (!execution) return "unknown";
  try {
    const roots = executionPaths(execution, state.project_id, a.id);
    const path = join(roots.worktreesRoot, state.project_id, a.id);
    if (
      a.worktree_path !== path ||
      (a.runtime_ref?.worktree_path && a.runtime_ref.worktree_path !== path)
    )
      return "unknown";
    const run = async (file: string, args: string[]) => {
      const cmd =
        execution.mode === "agent-ssh"
          ? await agentProcessCommand(execution, [file, ...args])
          : { file, args };
      return captureTranscript(cmd.file, cmd.args, signal);
    };
    const paths = [path];
    if (role?.worktree === "readonly") {
      const parent = join(roots.buildsRoot, state.project_id);
      const build = join(parent, a.id);
      const status = (
        await run("python3", [
          "-IB",
          "-c",
          inspectBuild,
          roots.buildsRoot,
          parent,
          build,
        ])
      ).trimEnd();
      if (status === "present") paths.push(build);
      else if (status !== "missing") return "unknown";
    }
    for (const target of paths) {
      const git = async (args: string[], classify = false) => {
        const argv = [
          ...gitSafetyArguments,
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-c",
          `safe.directory=${target}`,
          "-C",
          target,
          ...args,
        ];
        return classify
          ? run("python3", ["-IB", "-c", inspectStatus, "git", ...argv])
          : run("git", argv);
      };
      if ((await git(["rev-parse", "--show-toplevel"])).trimEnd() !== target)
        return "unknown";
      if (
        expectedHead &&
        (role?.worktree !== "write" ||
          !a.branch ||
          (await git(["symbolic-ref", "-q", "HEAD"])).trimEnd() !==
            `refs/heads/${a.branch}` ||
          (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trimEnd() !==
            expectedHead)
      )
        return "unknown";
      const status = (await git([], true)).trimEnd();
      if (status === "local_only" || status === "dirty")
        return inPlace && role?.worktree === "write" && a.branch && a.base_sha
          ? "local_only"
          : "dirty";
      if (status !== "clean") return "unknown";
    }
    return "clean";
  } catch {
    return "unknown";
  }
}
/**
 * C-626: the CLI of the system-ended turn, for the dispatcher's bound
 * empty-editor observation. Only Claude Code and Codex draw a recognizable
 * idle editor; any other harness keeps requiring an hc idle status.
 */
export function turnIdlePrompt(
  state: CommandState,
  a: Assignment,
  systemTurn?: string,
): TurnIdlePrompt | undefined {
  const harness = state.runs.find(
    (r) => r.id === systemTurn && r.assignment_id === a.id,
  )?.harness;
  return harness === "claude-code" || harness === "codex"
    ? { project_id: state.project_id, assignment_id: a.id, harness }
    : undefined;
}
/** C-626: a macOS worker generation whose system-ended turn the host may
 * stop through its idle owner or the enrolled-PID fallback. */
export function darwinTurnTarget(a: Assignment, execution?: ExecutionConfig) {
  return (
    a.machine_id !== "local" &&
    execution?.mode === "agent-ssh" &&
    !!execution.macosCore &&
    !!a.runtime_ref?.launch_generation
  );
}
/** Missing hc is not an exit. The native Linux adapter can independently
 * prove that this exact non-kept launch, its process group and socket are gone. */
export async function observeTurnOwner(
  runtime: Runtime,
  ref: RuntimeRef,
  identity: RetirementIdentity,
  systemTurn = true,
  idlePrompt?: TurnIdlePrompt,
) {
  const exact = await runtime
    .observe_retirement?.(
      ref,
      systemTurn
        ? {
            ...identity,
            system_finished_turn: true,
            ...(idlePrompt ? { idle_prompt: idlePrompt } : {}),
          }
        : identity,
    )
    .catch(() => undefined);
  if (
    exact &&
    !exact.ok &&
    exact.error.code === "runtime_unavailable" &&
    ref.machine_id === "local" &&
    ref.local_process_receipt
  ) {
    const proof = await runtime
      .confirm_local_exit?.(ref, identity)
      .catch(() => undefined);
    if (proof?.ok && proof.value) return { ok: true, value: "exited" } as const;
  }
  return exact;
}
// A worker marker only observes the leader. A surviving process group can
// still write to the checkout after that leader (and its terminal) exited.
// Signal zero queries existence only; permission errors and PID reuse block.
const groupGone = `import os, sys
pid, group, uid = map(int, sys.argv[1:])
if min(pid, group) <= 1 or os.geteuid() != uid: sys.exit(1)
for process in (pid, -group):
    try: os.kill(process, 0)
    except ProcessLookupError: continue
    sys.exit(1)
print("gone")`;
/** Remote recovery only settles an already exited registered launch. The
 * worker journal and terminal observations are independent; a missing row,
 * PID reuse alone, or an unbound status response cannot authorize release. */
export async function remoteStallExit(
  state: CommandState,
  a: Assignment,
  execution?: ExecutionConfig,
) {
  return (
    a.machine_id !== "local" && registeredLaunchExited(state, a, execution)
  );
}
/** A finished terminal row is not exit evidence for a local checkout writer.
 * Require the kernel: the in-memory launch receipt's process group, the
 * adapter's own post-signal group check, or a registered worker launch. */
export async function localTurnExitProof(
  state: CommandState,
  a: Assignment,
  runtime: Runtime,
  ref: RuntimeRef,
  execution?: ExecutionConfig,
) {
  if (
    a.machine_id !== "local" ||
    ref.machine_id !== "local" ||
    !isDeepStrictEqual(a.runtime_ref, ref) ||
    sharedStallRegistration(state, a)
  )
    return false;
  const owner = { project_id: state.project_id, assignment_id: a.id };
  if (ref.local_process_receipt)
    for (const probe of [
      runtime.confirm_local_group_exit,
      runtime.confirm_local_exit,
    ]) {
      const gone = await probe
        ?.call(runtime, ref, owner)
        .catch(() => undefined);
      if (gone?.ok && gone.value) return true;
    }
  return registeredLaunchExited(state, a, execution);
}
async function registeredLaunchExited(
  state: CommandState,
  a: Assignment,
  execution?: ExecutionConfig,
) {
  return (await registeredLaunchState(state, a, execution)) === "exited";
}
/** C-663: the registered worker launch's kernel state. `unreachable` is a
 * failed worker transport; every other failure or mismatch is `unknown`. */
export async function registeredLaunchState(
  state: CommandState,
  a: Assignment,
  execution?: ExecutionConfig,
): Promise<"exited" | "alive" | "unreachable" | "unknown"> {
  const ref = a.runtime_ref,
    gen = ref?.launch_generation;
  if (
    !ref ||
    !gen ||
    execution?.mode !== "agent-ssh" ||
    !execution.target ||
    !boundWorkspaceTarget(state.project_id, a, execution)
  )
    return "unknown";
  const launch = state.runs.find(
    (r) => r.id === gen.run_id && r.assignment_id === a.id,
  )?.launch_publication;
  if (
    !launch?.process ||
    !isDeepStrictEqual(launch.target, ref.target) ||
    launch.generation !== gen.generation ||
    !isDeepStrictEqual(launch.runtime_ref, ref)
  )
    return "unknown";
  let evidence: Awaited<ReturnType<typeof workerFiles>>;
  try {
    evidence = await workerFiles(
      execution,
      {
        project: state.project_id,
        assignment: a.id,
        run: gen.run_id,
        generation: gen.generation,
        target: execution.target.fingerprint,
      },
      "status",
    );
  } catch (error) {
    return error instanceof WorkerTransportUnavailable
      ? "unreachable"
      : "unknown";
  }
  const registered = launch.process;
  if (
    !isDeepStrictEqual(registered, evidence.process) ||
    registered.machine !== execution.target.fingerprint ||
    registered.terminal !== gen.generation ||
    ![registered.pid, registered.process_group].every(
      (id) => Number.isSafeInteger(id) && id > 1,
    ) ||
    !Number.isSafeInteger(registered.uid) ||
    registered.uid <= 0
  )
    return "unknown";
  if (evidence.observed === "alive") return "alive";
  if (evidence.observed !== "exited") return "unknown";
  try {
    const cmd = await agentProcessCommand(execution, [
      "/usr/bin/python3",
      "-IB",
      "-c",
      groupGone,
      String(registered.pid),
      String(registered.process_group),
      String(registered.uid),
    ]);
    // A surviving group member (or an ambiguous probe) keeps the session.
    return (await captureTranscript(cmd.file, cmd.args)).trimEnd() === "gone"
      ? "exited"
      : "unknown";
  } catch {
    return "unknown";
  }
}
/**
 * C-663: whether this exact session is gone. Both halves are required:
 * - its terminal: a finished row of this identity, or the row is absent from
 *   the runtime (a removed terminal row alone is never proof);
 * - its processes: the kernel shows no process of this launch. Local: the
 *   launch receipt's process and group (or the core with its socket); remote:
 *   the registered worker launch's process and whole group.
 * `unreachable` means the worker transport failed: nothing is known.
 */
export type SessionExitVerdict =
  | "exited"
  | "terminal_alive"
  | "process_alive"
  | "unreachable"
  | "unproven";
export async function sessionExitProof(
  state: CommandState,
  a: Assignment,
  runtime: Runtime,
  execution?: ExecutionConfig,
): Promise<SessionExitVerdict> {
  const ref = a.runtime_ref;
  if (
    !ref ||
    !boundWorkspaceTarget(state.project_id, a, execution) ||
    sharedStallRegistration(state, a)
  )
    return "unproven";
  const owner = { project_id: state.project_id, assignment_id: a.id };
  const terminal = await terminalGone(runtime, ref, owner);
  if (terminal === "alive") return "terminal_alive";
  if (a.machine_id === "local") {
    // The local receipt proofs read only the kernel (and the core socket).
    if (await localTurnExitProof(state, a, runtime, ref, execution))
      return terminal === "gone" || (await localCoreGone(runtime, ref, owner))
        ? "exited"
        : "unproven";
    return "unproven";
  }
  if (terminal === "unreachable") return "unreachable";
  const launch = await registeredLaunchState(state, a, execution);
  if (launch === "alive") return "process_alive";
  if (launch === "unreachable") return "unreachable";
  return launch === "exited" && terminal === "gone" ? "exited" : "unproven";
}
async function terminalGone(
  runtime: Runtime,
  ref: RuntimeRef,
  owner: RetirementIdentity,
): Promise<"gone" | "alive" | "unreachable" | "unknown"> {
  const exact = await runtime
    .observe_retirement?.(ref, owner)
    .catch(() => undefined);
  if (exact?.ok && exact.value === "exited") return "gone";
  if (exact?.ok && exact.value === "alive") return "alive";
  const observed = await runtime.status(ref).catch(() => undefined);
  if (observed?.ok)
    return observed.value.process === "exited"
      ? "gone"
      : observed.value.process === "alive"
        ? "alive"
        : "unknown";
  if (observed?.error.code === "runtime_not_found") return "gone";
  return observed?.error.code === "runtime_unavailable"
    ? "unreachable"
    : "unknown";
}
/** Local core and socket gone with the receipt's group: the terminal is gone too. */
async function localCoreGone(
  runtime: Runtime,
  ref: RuntimeRef,
  owner: RetirementIdentity,
) {
  if (!ref.local_process_receipt) return false;
  const proof = await runtime
    .confirm_local_exit?.(ref, owner)
    .catch(() => undefined);
  return proof?.ok === true && proof.value;
}
/** A retirement transfer is not exit evidence. Probe the captured generation
 * and the terminal independently; neither a retained shell nor ENOENT suffices.
 * C-663: a terminal that is no longer listed counts as gone only together with
 * the kernel proof that no process of this launch is left. */
export async function transferredSessionExited(
  state: CommandState,
  a: Assignment,
  runtime: Runtime,
  execution?: ExecutionConfig,
) {
  return (await sessionExitProof(state, a, runtime, execution)) === "exited";
}
export async function stallEvidence(
  state: CommandState,
  a: Assignment,
  runtime: Runtime,
  execution?: ExecutionConfig,
  signal?: AbortSignal,
  systemTurn?: string,
  transfer?: HostOpsExecution["retirement_handoff"],
  exitOnly = false,
) {
  // Conflicting live registrations invalidate ownership, even when hc has a
  // matching address/name. No filesystem or process access on their behalf.
  const bound =
    !sharedStallRegistration(state, a) &&
    boundWorkspaceTarget(state.project_id, a, execution);
  const [workspace, observed, strictOwner] = await Promise.all([
    bound
      ? stallWorkspace(
          state,
          a,
          execution,
          signal,
          undefined,
          !!(systemTurn || transfer),
        )
      : ("unknown" as const),
    a.runtime_ref && bound
      ? runtime.status(a.runtime_ref).catch(() => undefined)
      : undefined,
    a.runtime_ref?.machine_id === a.machine_id &&
    bound &&
    (systemTurn || transfer || a.machine_id === "local")
      ? observeTurnOwner(
          runtime,
          a.runtime_ref,
          systemTurn
            ? systemTurnOwner(state, a.id, a.runtime_ref, systemTurn)
            : { project_id: state.project_id, assignment_id: a.id },
          !!systemTurn,
        )
      : undefined,
  ]);
  // C-672: a worker terminal that is still live but no longer runs its
  // launched CLI (proven by the worker from the CLI's native identity) is not
  // a live session. There is nothing to stop: the managed restart closes that
  // terminal and settles the session (see releaseExitedAgent).
  const agent_exited =
    bound &&
    !!a.runtime_ref &&
    a.scope === "work_item" &&
    a.machine_id !== "local" &&
    observed?.ok === true &&
    observed.value.process === "alive" &&
    (await runtime
      .observe_agent_exit?.(a.runtime_ref, {
        project_id: state.project_id,
        assignment_id: a.id,
      })
      .then((exited) => exited.ok && exited.value)
      .catch(() => false)) === true;
  // C-626: hc reports no activity (null/unknown) for a live terminal whose
  // strict owner check could not confirm it. The bound CLI's own empty editor
  // and idle footer, read around the same owner proof, is the equivalent idle
  // evidence. Busy, blocked or error statuses and every identity, generation
  // and keep guard are unchanged.
  const prompt =
    systemTurn && !transfer ? turnIdlePrompt(state, a, systemTurn) : undefined;
  const promptOwner =
    prompt &&
    systemTurn &&
    a.runtime_ref &&
    strictOwner?.ok &&
    strictOwner.value === "unknown" &&
    observed?.ok &&
    observed.value.process === "alive" &&
    observed.value.agent === "unknown"
      ? await observeTurnOwner(
          runtime,
          a.runtime_ref,
          systemTurnOwner(state, a.id, a.runtime_ref, systemTurn),
          true,
          prompt,
        )
      : undefined;
  const owner =
    promptOwner?.ok && promptOwner.value === "alive"
      ? promptOwner
      : strictOwner;
  const idle_basis =
    promptOwner && owner === promptOwner
      ? ("bound_idle_prompt" as const)
      : owner?.ok && owner.value === "alive"
        ? ("terminal_status" as const)
        : null;
  // A macOS worker's confirmed, live system-ended turn may be stopped through
  // its owner or enrolled PID; other remote targets still settle exits only.
  const remoteTurnStop =
    !!systemTurn &&
    !transfer &&
    darwinTurnTarget(a, execution) &&
    owner?.ok === true &&
    owner.value === "alive" &&
    observed?.ok === true &&
    observed.value.process === "alive";
  const remoteExited =
    systemTurn &&
    a.machine_id !== "local" &&
    owner?.ok &&
    owner.value === "exited" &&
    observed?.ok &&
    observed.value.process === "exited" &&
    (await remoteStallExit(state, a, execution));
  const terminal_state = observed?.ok ? observed.value.agent : null;
  // A blocked/error/unknown CLI may still be in its old turn, regardless of MCP silence.
  const safeTerminal =
    (!a.runtime_ref &&
      !a.session_ref &&
      a.runtime_state === "not_provisioned") ||
    (observed?.ok &&
      (observed.value.process === "exited" || idleWakeGuard(observed.value)));
  const ownerConfirmed =
    owner?.ok && (owner.value === "alive" || owner.value === "exited");
  // A local session already settled by an earlier recovery leaves no binding
  // and nothing to stop; its exit was proven before the binding was cleared.
  const unboundLocal =
    !a.runtime_ref && !a.session_ref && a.machine_id === "local";
  // An ordinary stall row gets the same ownership and exit guards as turn
  // recovery: this Assignment's idle terminal, a kernel-proven exit, or no
  // session at all. A matching address or a generic status is not enough.
  const ordinaryOwned = () =>
    !a.runtime_ref
      ? !!safeTerminal
      : owner?.ok === true &&
        (owner.value === "alive"
          ? !!observed?.ok && !!idleWakeGuard(observed.value)
          : owner.value === "exited" &&
            localTurnExitProof(state, a, runtime, a.runtime_ref, execution));
  // C-669: an ordinary row whose session is already gone (terminal finished
  // or no longer listed, and the kernel shows no process of this launch) has
  // nothing left to stop. A missing terminal alone never counts.
  const ordinaryRestartable = async () =>
    (!!safeTerminal && (await ordinaryOwned())) ||
    (!!a.runtime_ref &&
      (await sessionExitProof(state, a, runtime, execution)) === "exited");
  const unknownOrIdle =
    (!observed?.ok &&
      observed?.error.code !== "runtime_conflict" &&
      observed?.error.code !== "invalid_launch") ||
    (observed?.ok &&
      (["unknown", "idle", "done"].includes(observed.value.agent) ||
        observed.value.process === "exited"));
  return {
    idle_basis,
    terminal_owner: ownerConfirmed ? "confirmed" : "unconfirmed",
    workspace,
    terminal_state,
    agent_exited,
    process_state: agent_exited
      ? ("agent_exited" as const)
      : observed?.ok
        ? observed.value.process
        : owner?.ok
          ? owner.value
          : null,
    can_restart:
      agent_exited ||
      (bound &&
        (!exitOnly ||
          unboundLocal ||
          (owner?.ok &&
            owner.value === "exited" &&
            (!observed?.ok || observed.value.process === "exited"))) &&
        (transfer
          ? owner?.ok === true && owner.value === "alive"
            ? transfer.phase === "waiting" &&
              !transfer.observe_only &&
              a.machine_id === "local" &&
              !!a.runtime_ref?.local_process_receipt &&
              !!observed?.ok &&
              idleWakeGuard(observed.value)
            : // C-663: also when the terminal is no longer listed at all.
              await transferredSessionExited(state, a, runtime, execution)
          : (systemTurn
              ? (!!ownerConfirmed && unknownOrIdle) || unboundLocal
              : await ordinaryRestartable()) &&
            (a.machine_id === "local" || !!remoteExited || remoteTurnStop)) &&
        (writableInPlace(workspace) || workspace === "no_worktree")),
  };
}
