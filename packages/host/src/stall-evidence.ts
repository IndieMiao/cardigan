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
} from "@cardigan/domain";
import { gitSafetyArguments } from "@cardigan/git-transport";
import {
  agentProcessCommand,
  type ExecutionConfig,
  executionPaths,
  runtimeOwnsRef,
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
const inspectStatus = `import subprocess, sys
with subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                      stderr=subprocess.DEVNULL) as p:
    dirty = False
    while p.stdout.read(65536): dirty = True
    if p.wait(): sys.exit(1)
    print('dirty' if dirty else 'clean')`;

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

type Workspace = "clean" | "dirty" | "unknown" | "no_worktree";
/** Fixed placement only. Use the worker account for agent-ssh; never return paths, stderr or filenames. */
export async function stallWorkspace(
  state: CommandState,
  a: Assignment,
  execution?: ExecutionConfig,
  signal?: AbortSignal,
  expectedHead?: string,
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
      const status = (
        await git(
          [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignored=matching",
            "--ignore-submodules=none",
          ],
          true,
        )
      ).trimEnd();
      if (status !== "clean") return status === "dirty" ? "dirty" : "unknown";
    }
    return "clean";
  } catch {
    return "unknown";
  }
}
/** Missing hc is not an exit. The native Linux adapter can independently
 * prove that this exact non-kept launch, its process group and socket are gone. */
export async function observeTurnOwner(
  runtime: Runtime,
  ref: RuntimeRef,
  identity: RetirementIdentity,
  systemTurn = true,
) {
  const exact = await runtime
    .observe_retirement?.(
      ref,
      systemTurn ? { ...identity, system_finished_turn: true } : identity,
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
/** Remote recovery only settles an already exited registered launch. The
 * worker journal and terminal observations are independent; a missing row,
 * PID reuse alone, or an unbound status response cannot authorize release. */
export async function remoteStallExit(
  state: CommandState,
  a: Assignment,
  execution?: ExecutionConfig,
) {
  const ref = a.runtime_ref,
    gen = ref?.launch_generation;
  if (
    !ref ||
    !gen ||
    a.machine_id === "local" ||
    execution?.mode !== "agent-ssh" ||
    !execution.target ||
    !boundWorkspaceTarget(state.project_id, a, execution)
  )
    return false;
  const launch = state.runs.find(
    (r) => r.id === gen.run_id && r.assignment_id === a.id,
  )?.launch_publication;
  if (
    !launch?.process ||
    !isDeepStrictEqual(launch.target, ref.target) ||
    launch.generation !== gen.generation ||
    !isDeepStrictEqual(launch.runtime_ref, ref)
  )
    return false;
  try {
    const evidence = await workerFiles(
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
    return (
      evidence.observed === "exited" &&
      isDeepStrictEqual(launch.process, evidence.process)
    );
  } catch {
    return false;
  }
}
/** A retirement transfer is not exit evidence. Probe the captured generation
 * and the terminal independently; neither a retained shell nor ENOENT suffices. */
export async function transferredSessionExited(
  state: CommandState,
  a: Assignment,
  runtime: Runtime,
  execution?: ExecutionConfig,
) {
  const ref = a.runtime_ref;
  if (
    !ref ||
    !boundWorkspaceTarget(state.project_id, a, execution) ||
    sharedStallRegistration(state, a)
  )
    return false;
  const owner = { project_id: state.project_id, assignment_id: a.id };
  const observed = await runtime
    .observe_retirement?.(ref, owner)
    .catch(() => undefined);
  if (!observed?.ok || observed.value !== "exited") return false;
  if (a.machine_id !== "local") return remoteStallExit(state, a, execution);
  if (!ref.local_process_receipt) return false;
  const process = await runtime
    .confirm_local_exit?.(ref, owner)
    .catch(() => undefined);
  return !!process?.ok && process.value;
}
export async function stallEvidence(
  state: CommandState,
  a: Assignment,
  runtime: Runtime,
  execution?: ExecutionConfig,
  signal?: AbortSignal,
  systemTurn?: string,
  transfer?: HostOpsExecution["retirement_handoff"],
) {
  // Conflicting live registrations invalidate ownership, even when hc has a
  // matching address/name. No filesystem or process access on their behalf.
  const bound =
    !sharedStallRegistration(state, a) &&
    boundWorkspaceTarget(state.project_id, a, execution);
  const [workspace, observed, owner] = await Promise.all([
    bound ? stallWorkspace(state, a, execution, signal) : ("unknown" as const),
    a.runtime_ref && bound
      ? runtime.status(a.runtime_ref).catch(() => undefined)
      : undefined,
    (systemTurn || transfer) &&
    a.runtime_ref?.machine_id === a.machine_id &&
    bound
      ? observeTurnOwner(
          runtime,
          a.runtime_ref,
          systemTurn
            ? systemTurnOwner(state, a.id, a.runtime_ref, systemTurn)
            : { project_id: state.project_id, assignment_id: a.id },
          !transfer,
        )
      : undefined,
  ]);
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
  const unknownOrIdle =
    (!observed?.ok &&
      observed?.error.code !== "runtime_conflict" &&
      observed?.error.code !== "invalid_launch") ||
    (observed?.ok &&
      (["unknown", "idle", "done"].includes(observed.value.agent) ||
        observed.value.process === "exited"));
  return {
    ...(systemTurn || transfer
      ? { terminal_owner: ownerConfirmed ? "confirmed" : "unconfirmed" }
      : {}),
    workspace,
    terminal_state,
    process_state: observed?.ok
      ? observed.value.process
      : owner?.ok
        ? owner.value
        : null,
    can_restart:
      bound &&
      (transfer
        ? owner?.ok && owner.value === "exited"
          ? await transferredSessionExited(state, a, runtime, execution)
          : transfer.phase === "waiting" &&
            !transfer.observe_only &&
            a.machine_id === "local" &&
            !!a.runtime_ref?.local_process_receipt &&
            owner?.ok === true &&
            owner.value === "alive" &&
            !!observed?.ok &&
            idleWakeGuard(observed.value)
        : (systemTurn ? !!ownerConfirmed && unknownOrIdle : !!safeTerminal) &&
          (a.machine_id === "local" || !!remoteExited)) &&
      (workspace === "clean" || workspace === "no_worktree"),
  };
}
