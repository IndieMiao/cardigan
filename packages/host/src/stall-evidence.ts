import { join } from "node:path";
import {
  type Assignment,
  type CommandState,
  idleWakeGuard,
  type RetirementIdentity,
  type Runtime,
  type RuntimeRef,
} from "@cardigan/domain";
import { gitSafetyArguments } from "@cardigan/git-transport";
import {
  agentProcessCommand,
  type ExecutionConfig,
  executionPaths,
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

type Workspace = "clean" | "dirty" | "unknown" | "no_worktree";
/** Fixed placement only. Use the worker account for agent-ssh; never return paths, stderr or filenames. */
export async function stallWorkspace(
  state: CommandState,
  a: Assignment,
  execution?: ExecutionConfig,
  signal?: AbortSignal,
): Promise<Workspace> {
  if (a.external || a.machine_id !== "local") return "unknown";
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
  if (
    !execution ||
    (execution.target && execution.target.machine_id !== "local")
  )
    return "unknown";
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
      const git = async (args: string[]) => {
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
        return run("git", argv);
      };
      if ((await git(["rev-parse", "--show-toplevel"])).trimEnd() !== target)
        return "unknown";
      if (
        await git([
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=normal",
          "--ignore-submodules=none",
        ])
      )
        return "dirty";
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
) {
  const exact = await runtime
    .observe_retirement?.(ref, identity)
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
export async function stallEvidence(
  state: CommandState,
  a: Assignment,
  runtime: Runtime,
  execution?: ExecutionConfig,
  signal?: AbortSignal,
  systemTurn = false,
) {
  const [workspace, observed, owner] = await Promise.all([
    stallWorkspace(state, a, execution, signal),
    a.runtime_ref
      ? runtime.status(a.runtime_ref).catch(() => undefined)
      : undefined,
    systemTurn &&
    a.runtime_ref?.machine_id === a.machine_id &&
    a.machine_id === "local"
      ? observeTurnOwner(runtime, a.runtime_ref, {
          project_id: state.project_id,
          assignment_id: a.id,
        })
      : undefined,
  ]);
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
    !observed?.ok ||
    ["unknown", "idle", "done"].includes(observed.value.agent) ||
    observed.value.process === "exited";
  return {
    ...(systemTurn
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
      (systemTurn ? !!ownerConfirmed && unknownOrIdle : !!safeTerminal) &&
      a.machine_id === "local" &&
      (workspace === "clean" || workspace === "no_worktree"),
  };
}
