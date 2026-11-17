import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentExecution } from "@cardigan/runtime-herdr";

/** Separate physical disk; only the SSH fixture knows its mapping. */
export async function workerGitFixture(
  root: string,
  execution: AgentExecution,
  name: string,
) {
  const disk = join(root, name);
  for (const part of ["", "repos", "worktrees", "builds", "locks"])
    await mkdir(join(disk, part), { mode: 0o700 });
  await writeFile(join(disk, "locks", "git.lock"), "", { mode: 0o600 });
  const helper = join(root, `${name}-git.py`);
  await writeFile(
    helper,
    `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('worker',${JSON.stringify(resolve("deploy/worker-git.py"))})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
disk=${JSON.stringify(disk)}
r=json.loads(sys.argv[1]);virtual=r['root']
def replace(value,a,b):
    if isinstance(value,str): return value.replace(a,b)
    if isinstance(value,list): return [replace(x,a,b) for x in value]
    if isinstance(value,dict): return {k:replace(v,a,b) for k,v in value.items()}
    return value
r=replace(r,virtual,disk)
# The operator-installed anchor/inode is substituted; real child path/ACL/mode,
# Git, flock and streaming operations still run. Production rejection is tested separately.
original=m.native.directory
m.native.directory=lambda path,uid,private=False: os.open(path,m.DIRECTORY) if path==disk else original(path,uid,private)
m.native.protected_lock=lambda fd,path,budget:m.native.lock_fd(fd,budget)
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
    path: "/usr/bin:/bin",
    host: "worker.invalid",
    gitHelper: { python: "/usr/bin/python3", path: helper },
    target: {
      project_id: "project",
      machine_id: name,
      session: "fixture",
      generation: "one",
      fingerprint: "a".repeat(64),
    },
  };
  return { disk, config };
}
