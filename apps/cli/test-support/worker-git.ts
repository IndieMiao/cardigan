import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentExecution, HC_RELEASE } from "@cardigan/runtime-herdr";
import { workerHelperDigests } from "../../../packages/host/src/worker-helper-release.js";
import { workerReadinessScript } from "../../../packages/host/src/worker-readiness.js";

/** Separate physical disk; only the SSH fixture knows its mapping. */
export async function workerGitFixture(
  root: string,
  execution: AgentExecution,
  name: string,
  platform: "linux" | "darwin" = "linux",
  project = "project",
) {
  const disk = join(root, name);
  for (const part of [
    "",
    "runs",
    "repos",
    "worktrees",
    "builds",
    "locks",
    "libexec",
  ]) {
    await mkdir(join(disk, part), { mode: 0o750 });
    await chmod(join(disk, part), 0o750);
  }
  for (const part of ["runs", "repos", "worktrees", "builds"])
    await mkdir(join(disk, part, project), { mode: 0o700 });
  for (const part of ["cache", "generated", "evidence", "temporary"])
    await mkdir(join(disk, part), { mode: 0o700 });
  await writeFile(join(disk, "locks", "git.lock"), "", { mode: 0o660 });
  await chmod(join(disk, "locks", "git.lock"), 0o660);
  for (const name of [
    "worker-git.py",
    "worker-files.py",
    "worker-primitives.py",
  ]) {
    const installed = join(disk, "libexec", name);
    await writeFile(
      installed,
      await readFile(new URL(`../../../deploy/${name}`, import.meta.url)),
      {
        mode: 0o750,
      },
    );
    await chmod(installed, 0o750);
  }
  const ownership = `import os,pathlib,stat
disk=${JSON.stringify(disk)}
parents={disk,*[disk+'/'+kind for kind in ('runs','repos','worktrees','builds','locks','libexec')]}
helpers={${["worker-git.py", "worker-files.py", "worker-primitives.py"].map((n) => JSON.stringify(join(disk, "libexec", n))).join(",")}}
ancestors={str(p) for path in [disk,*helpers] for p in pathlib.Path(path).parents}
administrators=parents|helpers|ancestors|{disk+'/locks/git.lock'}
# Only operator ownership/ancestor protection and the single project group are
# simulated; installed modes, inode identity, native ACLs and filesystem IO are real.
def observed(info,path):
    if path not in administrators: return info
    fields=list(info);fields[4]=0
    if path in ancestors and path not in parents: fields[0]=stat.S_IFDIR|0o755
    return os.stat_result(fields)
fstat,stat_path,lstat_path=os.fstat,os.stat,os.lstat
def absolute(path,dir_fd=None):
    if isinstance(path,int): return os.readlink('/proc/self/fd/'+str(path))
    return os.path.abspath(os.path.join(os.readlink('/proc/self/fd/'+str(dir_fd)),path)) if dir_fd is not None else os.path.abspath(path)
os.fstat=lambda fd:observed(fstat(fd),absolute(fd))
os.stat=lambda path,**kw:observed(stat_path(path,**kw),absolute(path,kw.get('dir_fd')))
os.lstat=lambda path,**kw:observed(lstat_path(path,**kw),absolute(path,kw.get('dir_fd')))
os.getgroups=lambda:[os.getgid()]
mkdir=os.mkdir
def private_mkdir(path,mode=0o777,*,dir_fd=None):
    parent=os.path.dirname(absolute(path,dir_fd))
    if parent in parents: raise PermissionError('administrator namespace')
    return mkdir(path,mode,dir_fd=dir_fd)
os.mkdir=private_mkdir
`;
  const helper = join(root, `${name}-git.py`);
  await writeFile(
    helper,
    `${ownership}
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('worker',${JSON.stringify(join(disk, "libexec", "worker-git.py"))})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
${
  platform === "darwin"
    ? `
# Synthetic Darwin ABI: real Linux disk/Git, with only platform APIs adapted.
# Exercise the production renameatx_np branch and its no-replace flag.
lib=m.ctypes.CDLL(None,use_errno=True)
class Darwin:
    def renameatx_np(self,source,name,destination,target,flags):
        assert flags==4
        return lib.renameat2(source,name,destination,target,1)
m.ctypes.CDLL=lambda *args,**kwargs:Darwin()
m.sys.platform='darwin'
m.native.platform.system=lambda:'Darwin'
m.native.acl_safe=lambda fd:not any(n.startswith('system.posix_acl_') for n in os.listxattr(fd))
m.native.process_groups=lambda:[os.getgid()]
`
    : ""
}
r=json.loads(sys.argv[1]);virtual=r['root']
def replace(value,a,b):
    if isinstance(value,str): return value.replace(a,b)
    if isinstance(value,list): return [replace(x,a,b) for x in value]
    if isinstance(value,dict): return {k:replace(v,a,b) for k,v in value.items()}
    return value
r=replace(r,virtual,disk)
os.umask(0o077)
w=m.Workspace(r)
try:
    reply=w.operate()
    if r['operation'] not in ('receive-pack','upload-pack'): print(json.dumps(replace(reply,disk,virtual)))
finally:
    os.close(w.lock);os.close(w.anchor)
`,
    { mode: 0o700 },
  );
  const config: AgentExecution = {
    ...execution,
    agentRoot: "/worker-fixture",
    machine: name,
    gid: process.getgid?.() ?? execution.gid,
    path: "/usr/bin:/bin",
    host: "worker.invalid",
    gitHelper: { python: "/usr/bin/python3", path: helper },
    target: {
      project_id: project,
      machine_id: name,
      session: "fixture",
      generation: "one",
      fingerprint: "a".repeat(64),
    },
  };
  const readiness = async () => {
    const program = `${ownership}
import subprocess
output=subprocess.check_output
subprocess.check_output=lambda args,**kw: ${JSON.stringify(`hc ${HC_RELEASE.version}`)}.encode() if args==['hc','--version'] else output(args,**kw)
${workerReadinessScript}`;
    const { stdout } = await promisify(execFile)("python3", [
      "-I",
      "-B",
      "-c",
      program,
      JSON.stringify({
        digests: workerHelperDigests(),
        root: disk,
        project,
        gid: config.gid,
        git_helper: join(disk, "libexec", "worker-git.py"),
        file_helper: join(disk, "libexec", "worker-files.py"),
      }),
    ]);
    return JSON.parse(stdout) as { failures: string[]; version: string };
  };
  return { disk, config, readiness };
}
