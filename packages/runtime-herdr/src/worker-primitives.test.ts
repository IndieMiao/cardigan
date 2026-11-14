import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { sameWorkerProcess } from "./worker-primitives.js";

const exec = promisify(execFile);
const helper = fileURLToPath(
  new URL("../../../deploy/worker-primitives.py", import.meta.url),
);
const load = `import importlib.util,sys,os,json
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
`;
test("native identity binds boot, UID, start time and controlled group; incomplete evidence is unknown", async () => {
  const { stdout } = await exec("python3", [
    "-B",
    "-c",
    `${load}
actual=m.identity('worker-fixture',os.getpid(),'terminal-generation',os.getpgrp())
assert actual and actual['uid']==os.getuid()
print(json.dumps(actual))
for platform in ['Linux','Darwin']:
 m.platform.system=lambda:platform
 def denied(pid): raise PermissionError()
 m.linux_identity=m.darwin_identity=denied
 assert m.identity('fixture',1,'terminal',1) is None
 def changed(pid):
  changed.count+=1
  return ('boot-'+str(changed.count),501,'1:2',1)
 changed.count=0;m.linux_identity=m.darwin_identity=changed
 assert m.identity('fixture',1,'terminal',1) is None
`,
    helper,
  ]);
  const identity = JSON.parse(stdout);
  expect(sameWorkerProcess(identity, identity)).toBe(true);
  for (const changed of [
    { boot: "new" },
    { start: "new" },
    { uid: 999 },
    { terminal: "new" },
  ])
    expect(sameWorkerProcess(identity, { ...identity, ...changed })).toBe(
      false,
    );
  expect(sameWorkerProcess(identity, null)).toBe(false);
});

test("two processes contend on an inherited FD; parent SIGKILL releases it after helper exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-lock-"));
  const path = join(root, "lock");
  await writeFile(path, "");
  const program = `${load}
import subprocess
fd=os.open(sys.argv[2],os.O_RDWR)
subprocess.run([sys.executable,'-B','-c','import fcntl,sys;fcntl.flock(int(sys.argv[1]),fcntl.LOCK_EX|fcntl.LOCK_NB)',str(fd)],pass_fds=(fd,),check=True)
print('locked',flush=True)
sys.stdin.read()
`;
  const child = spawn("python3", ["-B", "-c", program, helper, path], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  try {
    await once(child.stdout, "data");
    await expect(
      exec("python3", [
        "-B",
        "-c",
        `${load}m.lock_fd(os.open(sys.argv[2],os.O_RDWR))`,
        helper,
        path,
      ]),
    ).rejects.toThrow();
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
  try {
    await expect(
      exec("python3", [
        "-B",
        "-c",
        `${load}m.lock_fd(os.open(sys.argv[2],os.O_RDWR))`,
        helper,
        path,
      ]),
    ).resolves.toMatchObject({ stdout: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
