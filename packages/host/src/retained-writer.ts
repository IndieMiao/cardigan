import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type Assignment,
  automaticContextActionForRun,
  type CommandState,
  eventsOfType,
  type Run,
  type RuntimeRef,
} from "@cardigan/domain";
import {
  agentProcessCommand,
  type ExecutionConfig,
  executionPaths,
  runtimeOwnsRef,
} from "@cardigan/runtime-herdr";
import { captureTranscript } from "./capture-transcript.js";
import { stallWorkspace, writableInPlace } from "./stall-evidence.js";

// Neither directory entries nor file content are returned. Do not create a
// missing directory. Bind the checkout and its .git entry to the actual account.
const identify = `import hashlib, json, os, stat, subprocess, sys, uuid
p = sys.argv[1]
if not os.path.isabs(p): sys.exit(1)
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fd = os.open('/', flags)
try:
    for part in p.split('/')[1:]:
        if part in ('', '.', '..'): sys.exit(1)
        child = os.open(part, flags, dir_fd=fd)
        os.close(fd)
        fd = child
    root = os.fstat(fd)
    git = os.stat('.git', dir_fd=fd, follow_symlinks=False)
    if not (stat.S_ISDIR(git.st_mode) or (stat.S_ISREG(git.st_mode) and git.st_nlink == 1)): sys.exit(1)
    def identity(s): return [s.st_dev, s.st_ino, s.st_uid, s.st_gid, s.st_mode]
    if sys.platform.startswith('linux'):
        with open('/proc/sys/kernel/random/boot_id') as f: boot = f.read(64).strip()
    elif sys.platform == 'darwin':
        boot = subprocess.check_output(['/usr/sbin/sysctl','-n','kern.bootsessionuuid'], timeout=2, stderr=subprocess.DEVNULL).decode().strip()
    else: sys.exit(1)
    key = [uuid.UUID(boot).hex, os.geteuid(),os.getegid(),sorted(os.getgroups()),identity(root),identity(git)]
    if stat.S_ISREG(git.st_mode): key.append(git.st_ctime_ns)
    print(hashlib.sha256(json.dumps(key).encode()).hexdigest())
finally: os.close(fd)`;

export async function writerPlacementSeal(
  project: CommandState["project_id"],
  a: Assignment,
  ref: RuntimeRef | null,
  execution?: ExecutionConfig,
  signal?: AbortSignal,
) {
  if (
    !ref ||
    !execution ||
    a.scope !== "work_item" ||
    a.external ||
    !a.worktree_path ||
    !a.branch ||
    !a.base_sha ||
    ref.machine_id !== a.machine_id ||
    (ref.target && ref.target.project_id !== project) ||
    !runtimeOwnsRef(execution, ref)
  )
    return;
  const path = join(
    executionPaths(execution, project, a.id).worktreesRoot,
    project,
    a.id,
  );
  if (
    a.worktree_path !== path ||
    (ref.worktree_path && ref.worktree_path !== path) ||
    (ref.branch && ref.branch !== a.branch)
  )
    return;
  try {
    const args = ["-IB", "-c", identify, path];
    const cmd =
      execution.mode === "agent-ssh"
        ? await agentProcessCommand(execution, ["python3", ...args])
        : { file: "python3", args };
    const stamp = (
      await captureTranscript(cmd.file, cmd.args, signal)
    ).trimEnd();
    if (!/^[a-f0-9]{64}$/u.test(stamp)) return;
    return createHash("sha256")
      .update(
        JSON.stringify([
          project,
          a.id,
          a.work_item_id,
          a.employee_id ?? null,
          a.role_id,
          a.role_version,
          a.machine_id,
          ref.target?.fingerprint ?? null,
          execution.mode,
          path,
          a.branch,
          a.base_sha,
          stamp,
        ]),
      )
      .digest("hex");
  } catch {
    return;
  }
}

/** No placement or repair is allowed on this path, including when a caller
 * supplied a worktree. A missing/mismatched receipt must never fall through. */
export function retainedWriterForRun(
  state: CommandState,
  run: Run,
  a: Assignment,
) {
  const action = automaticContextActionForRun(state.events, run);
  if (
    !action?.dispatch_stall_id ||
    (!action.system_finished_run_id && !action.retirement_handoff)
  )
    return;
  const row = eventsOfType(state.events, "dispatch_stall_backup_verified").find(
    (e) =>
      e.actor.kind === "system" &&
      (e.payload as { action_id?: string }).action_id === action.action_id,
  )?.payload as
    | { assignment_id?: string; sha?: string; workspace_seal?: string }
    | undefined;
  const role = state.roles.find(
    (r) => r.role_id === a.role_id && r.role_version === a.role_version,
  );
  if (
    !row &&
    (role?.worktree !== "write" ||
      (!a.worktree_path && !action.runtime_ref?.worktree_path))
  )
    return;
  const reject = () => {
    throw new Error("Preserved writer checkout could not be verified");
  };
  if (
    action.assignment_id !== a.id ||
    !row ||
    row.assignment_id !== a.id ||
    role?.worktree !== "write" ||
    !row.workspace_seal ||
    !row.sha ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(row.sha) ||
    a.runtime_ref ||
    !a.worktree_path ||
    !a.branch ||
    !a.base_sha
  )
    return reject();
  const sha = row.sha;
  return {
    tree: { path: a.worktree_path, branch: a.branch, base_sha: a.base_sha },
    verify: async (
      current: Assignment | undefined,
      execution: ExecutionConfig,
    ) => {
      if (
        current?.status !== "active" ||
        current.runtime_ref ||
        (await writerPlacementSeal(
          state.project_id,
          current,
          action.runtime_ref,
          execution,
        )) !== row.workspace_seal ||
        !writableInPlace(
          await stallWorkspace(
            state,
            { ...current, runtime_ref: action.runtime_ref },
            execution,
            undefined,
            sha,
            true,
          ),
        )
      )
        reject();
    },
  };
}
