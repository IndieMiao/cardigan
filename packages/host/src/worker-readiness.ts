import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  agentProcessCommand,
  type ExecutionConfig,
  isHcVersionCompatible,
} from "@cardigan/runtime-herdr";

type Worker = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
export type WorkerReadinessFailure =
  | "worker_unreachable"
  | "hc_version"
  | "worker_directories"
  | "worker_helpers";

/** Fixed, read-only probe. No project code, credentials or raw diagnostics are returned. */
export const workerReadinessScript = `
import importlib.util,json,os,pathlib,platform,pwd,stat,subprocess,sys
r=json.loads(sys.argv[1])
failures=[]
def require(value):
    if not value: raise ValueError()
def protected(path):
    # Never import a helper from a worker-writable namespace.
    p=pathlib.Path(path)
    for parent in [p,*p.parents]:
        s=parent.lstat()
        require(not stat.S_ISLNK(s.st_mode) and s.st_uid==0 and not s.st_mode & 0o022)
    require(p.is_file())
def module(path,name):
    protected(path)
    protected(str(pathlib.Path(path).with_name('worker-primitives.py')))
    spec=importlib.util.spec_from_file_location(name,path)
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m
try:
    git=module(r['git_helper'],'worker_git')
    files=module(r['file_helper'],'worker_files')
    require(callable(git.Workspace) and callable(git.check_layout) and callable(files.namespace))
    native=git.native
    require(subprocess.run(['git','--version'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5).returncode==0)
except Exception:
    failures.append('worker_helpers')
try:
    uid,gid=os.getuid(),os.getgid()
    require(uid>0 and gid==r['gid'] and os.geteuid()==uid and os.getegid()==gid)
    if platform.system() == 'Darwin':
        account=pwd.getpwuid(uid)
        native.isolation_groups(account, native.process_groups())
        for path in {account.pw_dir, r['root'], os.path.dirname(r['git_helper']), os.path.dirname(r['file_helper'])}:
            native.macos_check_directory(path)
    else:
        require(set(native.process_groups()) <= {gid})
    root=r['root']
    os.close(native.isolation_directory(root,0,gid,0o750,True))
    os.close(git.check_layout(root,r['project']))
    for kind in ['runs']:
        os.close(native.isolation_directory(root+'/'+kind,0,gid,0o750,True))
        os.close(native.isolation_directory(root+'/'+kind+'/'+r['project'],uid,gid,0o700,True))
    for kind in ['cache','generated','evidence','temporary']:
        os.close(native.isolation_directory(root+'/'+kind,uid,gid,0o700,True))
    os.close(native.isolation_directory(root+'/locks',0,gid,0o750,True))
    lock=pathlib.Path(root+'/locks/git.lock').lstat()
    require(stat.S_ISREG(lock.st_mode) and lock.st_uid==0 and lock.st_gid==gid and stat.S_IMODE(lock.st_mode)==0o660 and lock.st_nlink==1)
except Exception:
    failures.append('worker_directories')
version=None
try:
    version=subprocess.check_output(['hc','--version'],stderr=subprocess.DEVNULL,timeout=5).decode().strip()
except Exception: pass
print(json.dumps(dict(failures=failures,version=version)))
`;

export async function workerReadiness(
  execution: Worker,
): Promise<readonly WorkerReadinessFailure[]> {
  if (!execution.gitHelper || !execution.fileHelper || !execution.target)
    return ["worker_helpers"];
  try {
    const command = await agentProcessCommand(execution, [
      execution.gitHelper.python,
      "-I",
      "-B",
      "-c",
      workerReadinessScript,
      JSON.stringify({
        root: execution.agentRoot,
        gid: execution.gid,
        project: execution.target.project_id,
        git_helper: execution.gitHelper.path,
        file_helper: execution.fileHelper.path,
      }),
    ]);
    const { stdout } = await promisify(execFile)(command.file, command.args, {
      timeout: execution.publication?.timeout_ms ?? 10000,
      killSignal: "SIGKILL",
      maxBuffer: 65536,
    });
    const result = JSON.parse(stdout) as {
      failures: unknown;
      version: unknown;
    };
    if (
      !Array.isArray(result.failures) ||
      result.failures.some(
        (v) => !["worker_helpers", "worker_directories"].includes(v),
      )
    )
      return ["worker_unreachable"];
    const version =
      typeof result.version === "string"
        ? /^hc (\S+)$/u.exec(result.version)?.[1]
        : undefined;
    return [
      ...(result.failures as WorkerReadinessFailure[]),
      ...(isHcVersionCompatible(version) ? [] : ["hc_version" as const]),
    ];
  } catch {
    return ["worker_unreachable"];
  }
}
