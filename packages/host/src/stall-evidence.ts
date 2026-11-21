import { join } from "node:path";
import type { Assignment, CommandState, Runtime } from "@cardigan/domain";
import { gitSafetyArguments } from "@cardigan/git-transport";
import {
  agentProcessCommand,
  type ExecutionConfig,
  executionPaths,
} from "@cardigan/runtime-herdr";
import { captureTranscript } from "./capture-transcript.js";

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
    const paths =
      role?.worktree === "readonly"
        ? [path, join(roots.buildsRoot, state.project_id, a.id)]
        : [path];
    for (const target of paths) {
      const git = async (args: string[]) => {
        const argv = [
          "git",
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
        const cmd =
          execution.mode === "agent-ssh"
            ? await agentProcessCommand(execution, argv)
            : { file: "git", args: argv.slice(1) };
        return captureTranscript(cmd.file, cmd.args, signal);
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
export async function stallEvidence(
  state: CommandState,
  a: Assignment,
  runtime: Runtime,
  execution?: ExecutionConfig,
  signal?: AbortSignal,
) {
  const [workspace, observed] = await Promise.all([
    stallWorkspace(state, a, execution, signal),
    a.runtime_ref
      ? runtime.status(a.runtime_ref).catch(() => undefined)
      : undefined,
  ]);
  const terminal_state = observed?.ok ? observed.value.agent : null;
  const safeTerminal =
    !a.runtime_ref ||
    (observed?.ok &&
      (observed.value.process === "exited" ||
        (observed.value.process === "alive" &&
          ["idle", "done", "blocked", "error"].includes(
            observed.value.agent,
          ))));
  return {
    workspace,
    terminal_state,
    process_state: observed?.ok ? observed.value.process : null,
    can_restart:
      !!safeTerminal &&
      a.machine_id === "local" &&
      (workspace === "clean" || workspace === "no_worktree"),
  };
}
