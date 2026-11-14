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
test("review: read-only path sampling must not execute submodule clean filters", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-submodule-"));
  try {
    const { stdout } = await exec("python3", [
      "-B",
      "-c",
      `${load}
import subprocess,shutil
from pathlib import Path
base=Path(sys.argv[2]); sub=base/'sub'; sub.mkdir(mode=0o700)
git=shutil.which('git')
def g(path,*args):
 return subprocess.check_output([git,'-C',str(path),*args],stderr=subprocess.DEVNULL).decode().strip()
def commit(path):
 g(path,'add','.');g(path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture')
g(sub,'init');(sub/'file').write_text('initial');commit(sub)
g(base,'init');(base/'.gitmodules').write_text('[submodule "sub"]\\n path = sub\\n url = ./sub\\n');commit(base)
marker=base/'unexpected-filter-execution'
g(sub,'config','filter.fixture.clean', 'touch '+str(marker)+'; cat')
(sub/'.gitattributes').write_text('file filter=fixture\\n');(sub/'file').write_text('changed')
expected=dict(path=str(base),realpath=str(base),mount='/',volume='pending',uid=os.getuid(),kind='worktree',common_dir=str(base/'.git'),assignment='A-1',sha=g(base,'rev-parse','HEAD'),dirty=False)
try:m.paths(dict(git=git,timeout_ms=3000,worktree=str(base),paths=[expected]));raise AssertionError('unchecked submodule accepted')
except ValueError as error:assert str(error)=='unsafe_git_probe_config'
print(json.dumps({'filter_executed':marker.exists()}))
`,
      helper,
      root,
    ]);
    expect(JSON.parse(stdout)).toEqual({ filter_executed: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review: each inventoried Git directory must have its own observed SHA and common-dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-path-binding-"));
  try {
    const { stdout } = await exec("python3", [
      "-B",
      "-c",
      `${load}
import subprocess,shutil
from pathlib import Path
base=Path(sys.argv[2]);git=shutil.which('git');repos=[base/'a',base/'b']
def g(path,*args):
 return subprocess.check_output([git,'-C',str(path),*args],stderr=subprocess.DEVNULL).decode().strip()
for index,path in enumerate(repos):
 path.mkdir(mode=0o700);g(path,'init');(path/'file').write_text(str(index));g(path,'add','.')
 g(path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture')
a,b=repos;sha_a=g(a,'rev-parse','HEAD');sha_b=g(b,'rev-parse','HEAD')
expected=dict(path=str(b),realpath=str(b),mount='/',volume='pending',uid=os.getuid(),kind='worktree',common_dir=str(a/'.git'),assignment='A-1',sha=sha_a,dirty=False)
actual=m.paths(dict(git=git,timeout_ms=3000,worktree=str(a),paths=[expected]))[0]
print(json.dumps({'repositories_differ':sha_a!=sha_b,'observed_b_sha_matches_real_b':actual['sha']==sha_b,'observed_b_common_dir_matches_real_b':actual['common_dir']==str(b/'.git')}))
`,
      helper,
      root,
    ]);
    expect(JSON.parse(stdout)).toEqual({
      repositories_differ: true,
      observed_b_sha_matches_real_b: true,
      observed_b_common_dir_matches_real_b: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
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

test("Darwin libproc fixtures reject short reads, UID/start/group changes and permissions", async () => {
  const { stdout } = await exec("python3", [
    "-B",
    "-c",
    `${load}
import ctypes
class F:
 def __init__(self,fn): self.fn=fn
 def __call__(self,*args): return self.fn(*args)
class Library: pass
lib=Library();fault='';calls=0
def boot(name,buffer,size,write,length):
 if fault=='permission': return -1
 ctypes.memmove(buffer,b'fixture-boot\\0',13);return 0
def info(pid,kind,arg,buffer,size):
 global calls
 calls+=1
 value=ctypes.cast(buffer,ctypes.POINTER(m.ProcBSDInfo)).contents
 value.pid=pid;value.uid=501;value.start_sec=10;value.start_usec=20;value.pgid=77;value.status=2
 if fault=='start': value.start_usec=calls
 if fault=='group': value.pgid=88
 if fault=='uid': value.uid=calls
 return size-1 if fault=='short' else size
lib.sysctlbyname=F(boot);lib.proc_pidinfo=F(info)
m.ctypes.CDLL=lambda *a,**k:lib;m.platform.system=lambda:'Darwin'
assert ctypes.sizeof(m.ProcBSDInfo)==136
assert m.identity('fixture',123,'terminal',77)['start']=='10:20'
for fault in ['short','permission','start','group','uid']:
 assert m.identity('fixture',123,'terminal',77) is None,fault
print('native fixture checked')
`,
    helper,
  ]);
  expect(stdout.trim()).toBe("native fixture checked");
});

test("desktop probing returns status only and leaves unobserved lock state unknown", async () => {
  const { stdout } = await exec("python3", [
    "-B",
    "-c",
    `${load}
import ctypes
class F:
 def __init__(self,fn): self.fn=fn
 def __call__(self,*args): return self.fn(*args)
class Library: pass
lib=Library();names={};states={'kCGSessionUserIDKey':os.getuid(),'kCGSessionOnConsoleKey':True,'kCGSessionLoginDoneKey':True}
def key(_,name,encoding):
 index=len(names)+100;names[index]=name.decode();return index
def number(item,kind,pointer):
 ctypes.cast(pointer,ctypes.POINTER(ctypes.c_int)).contents.value=states[names[item]];return True
def keychain(pointer):
 ctypes.cast(pointer,ctypes.POINTER(ctypes.c_void_p)).contents.value=999;return 0
def status(key,pointer):
 ctypes.cast(pointer,ctypes.POINTER(ctypes.c_uint32)).contents.value=2;return 0
lib.CFStringCreateWithCString=F(key);lib.CFDictionaryGetValue=F(lambda session,key:key if names[key] in states else 0)
lib.CFNumberGetValue=F(number);lib.CFBooleanGetValue=F(lambda item:states[names[item]]);lib.CFRelease=F(lambda *a:None)
lib.CGSessionCopyCurrentDictionary=F(lambda:1);lib.CGPreflightScreenCaptureAccess=F(lambda:False)
lib.AXIsProcessTrusted=F(lambda:False);lib.MTLCreateSystemDefaultDevice=F(lambda:1)
lib.SecKeychainCopyDefault=F(keychain);lib.SecKeychainGetStatus=F(status)
m.ctypes.CDLL=lambda *a,**k:lib;m.platform.system=lambda:'Darwin'
result=m.desktop();assert result['login'] is True and result['unlocked'] is None
assert result['screen-capture'] is False and result['accessibility'] is False and result['keychain'] is False
states['kCGSessionUserIDKey']=os.getuid()+1
assert m.desktop()['graphics-session'] is False
def unavailable(*a,**k): raise OSError('private native diagnostic')
m.ctypes.CDLL=unavailable
assert all(v is None for v in m.desktop().values())
print(json.dumps(result))
`,
    helper,
  ]);
  expect(JSON.parse(stdout)).toMatchObject({
    login: true,
    unlocked: null,
    keychain: false,
    "screen-capture": false,
  });
  expect(stdout).not.toContain("private");
});

test("inherited child FD retains the lock after its parent dies and releases on child close", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-child-lock-"));
  const path = join(root, "lock");
  await writeFile(path, "");
  const childCode =
    "import os,sys;fd=int(sys.argv[1]);os.write(3,b'ready');os.read(3,1);os.close(fd);os.write(3,b'released')";
  const parent = spawn(
    "python3",
    [
      "-B",
      "-c",
      `${load}
import subprocess
fd=os.open(sys.argv[2],os.O_RDWR);m.lock_fd(fd)
child=subprocess.Popen([sys.executable,'-B','-c',sys.argv[3],str(fd)],pass_fds=(fd,3),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print(child.pid,flush=True);sys.stdin.read()
`,
      helper,
      path,
      childCode,
    ],
    { stdio: ["pipe", "pipe", "pipe", "pipe"] },
  );
  const channel = parent.stdio[3];
  if (!channel || !("write" in channel)) throw new Error("No fixture channel");
  const exit = once(parent, "exit");
  const closed = once(parent, "close");
  let childPid = 0;
  parent.stdout.on("data", (data) => {
    childPid = Number(String(data).trim());
  });
  try {
    expect(String((await once(channel, "data"))[0])).toBe("ready");
    parent.kill("SIGKILL");
    await exit;
    await expect(
      exec("python3", [
        "-B",
        "-c",
        `${load}m.lock_fd(os.open(sys.argv[2],os.O_RDWR))`,
        helper,
        path,
      ]),
    ).rejects.toThrow();
    const released = once(channel, "data");
    channel.write("x");
    expect(String((await released)[0])).toBe("released");
    await closed;
    await expect(
      exec("python3", [
        "-B",
        "-c",
        `${load}m.lock_fd(os.open(sys.argv[2],os.O_RDWR))`,
        helper,
        path,
      ]),
    ).resolves.toMatchObject({ stdout: "" });
    childPid = 0;
  } finally {
    parent.kill("SIGKILL");
    if (childPid > 0) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("native tool fixtures distinguish architectures and require the pinned Apple signature", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-signature-"));
  try {
    const { stdout } = await exec("python3", [
      "-B",
      "-c",
      `${load}
from pathlib import Path
base=Path(sys.argv[2]);app=base/'Fixture.app';binary=app/'Contents'/'fixture';binary.parent.mkdir(parents=True)
binary.write_bytes(bytes.fromhex('cffaedfe0c000001')+bytes(32))
request={'path':str(binary),'signature':{'app':str(app),'team':'ABCDEFGHIJ','identifier':'invalid.example.fixture'},'timeout_ms':1000}
m.platform.system=lambda:'Darwin';commands=[]
m.run=lambda argv,timeout:commands.append(argv) or ''
assert m.tool(request)=={'arch':'arm64','signed':True}
assert commands[0][:4]==['/usr/bin/codesign','--verify','--deep','--strict']
assert 'anchor apple generic' in commands[0][5] and 'ABCDEFGHIJ' in commands[0][5]
request['signature']=None
assert m.tool(request)['signed'] is None
request['signature']={'app':str(base/'Other.app'),'team':'ABCDEFGHIJ','identifier':'invalid.example.fixture'}
try:m.tool(request);raise AssertionError('accepted different App')
except ValueError:pass
assert len(commands)==1
binary.write_bytes(b'#!/usr/bin/env node\\n')
assert m.tool({'path':str(binary),'node_arch':'arm64'})['arch']=='arm64'
print('signature and architecture checked')
`,
      helper,
      root,
    ]);
    expect(stdout.trim()).toBe("signature and architecture checked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protected lock fixtures reject replaceable names, hard links, ACLs and invalid files", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-lock-inode-"));
  try {
    const { stdout } = await exec("python3", [
      "-B",
      "-c",
      `${load}
from pathlib import Path
root=Path(sys.argv[2]);path=root/'lock';path.write_bytes(b'');path.chmod(0o600)
fd=os.open(path,os.O_RDWR);real_fstat=os.fstat
# Only ownership/namespace are synthetic; flock and inode checks remain real.
def owned(number):
 info=real_fstat(number)
 if number==fd:
  fields=list(info);fields[4]=0;return os.stat_result(fields)
 return info
m.os.fstat=owned;m.directory=lambda *a,**k:os.open(root,os.O_RDONLY);m.acl_safe=lambda _:True
m.protected_lock(fd,str(path),0)
def rejected():
 try:m.protected_lock(fd,str(path),0);raise AssertionError('unsafe lock accepted')
 except ValueError:pass
os.link(path,root/'alias');rejected();(root/'alias').unlink()
path.write_bytes(b'occupied');rejected();path.write_bytes(b'')
m.acl_safe=lambda _:False;rejected();m.acl_safe=lambda _:True
path.unlink();path.write_bytes(b'');rejected()
os.close(fd)
print('unsafe lock fixtures rejected')
`,
      helper,
      root,
    ]);
    expect(stdout.trim()).toBe("unsafe lock fixtures rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested safe submodules contribute tracked, untracked and staged gitlink changes to dirty", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-submodule-states-"));
  try {
    const { stdout } = await exec("python3", [
      "-B",
      "-c",
      `${load}
import subprocess,shutil
from pathlib import Path
base=Path(sys.argv[2]);sub=base/'sub';nested=sub/'nested';sub.mkdir(mode=0o700);nested.mkdir(mode=0o700)
git=shutil.which('git')
def g(path,*args):return subprocess.check_output([git,'-C',str(path),*args],stderr=subprocess.DEVNULL).decode().strip()
def commit(path):
 g(path,'add','.');g(path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture')
g(nested,'init');(nested/'file').write_text('initial');commit(nested)
g(sub,'init');(sub/'.gitmodules').write_text('[submodule "nested"]\\n path = nested\\n url = ./nested\\n');commit(sub)
g(base,'init');(base/'.gitmodules').write_text('[submodule "sub"]\\n path = sub\\n url = ./sub\\n');commit(base)
request=dict(git=git,timeout_ms=3000)
def dirty():return m.git_state(request,str(base))['dirty']
assert dirty() is False
(nested/'file').write_text('modified');assert dirty() is True
g(nested,'checkout','--','file');(nested/'untracked').write_text('new');assert dirty() is True
(nested/'untracked').unlink();assert dirty() is False
(nested/'file').write_text('new revision');commit(nested);g(sub,'add','nested');commit(sub);g(base,'add','sub')
assert dirty() is True
marker=base/'filter-executed'
g(nested,'config','filter.fixture.clean','touch '+str(marker)+'; cat')
(nested/'.gitattributes').write_text('file filter=fixture\\n');(nested/'file').write_text('changed again')
try:dirty();raise AssertionError('unsafe nested filter accepted')
except ValueError as error:assert str(error)=='unsafe_git_probe_config'
assert not marker.exists()
print('all submodule states checked')
`,
      helper,
      root,
    ]);
    expect(stdout.trim()).toBe("all submodule states checked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Git paths require host directory-incarnation bindings and cannot borrow another workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-directory-bindings-"));
  try {
    const { stdout } = await exec("python3", [
      "-B",
      "-c",
      `${load}
import subprocess,shutil
from pathlib import Path
base=Path(sys.argv[2]);workspace=base/'work';cache=base/'cache';workspace.mkdir(mode=0o700);cache.mkdir(mode=0o700)
git=shutil.which('git')
def g(*args):return subprocess.check_output([git,'-C',str(workspace),*args],stderr=subprocess.DEVNULL).decode().strip()
g('init');(workspace/'file').write_text('fixture');g('add','.');g('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture')
expected=dict(kind='cache',path=str(cache),realpath=str(cache),mount='/',volume='pending',uid=os.getuid(),assignment='A-1',common_dir=str(workspace/'.git'),sha=g('rev-parse','HEAD'),dirty=False)
request=dict(git=git,timeout_ms=3000,worktree=str(workspace),paths=[expected])
def registered(path,kind):
 info=path.stat();return dict(device=str(info.st_dev),inode=str(info.st_ino),kind=kind)
def rejected():
 try:m.paths(request);raise AssertionError('unbound directory accepted')
 except ValueError as error:assert str(error)=='path_binding_unknown'
rejected()
request['binding']=dict(assignment='A-1',workspace=str(workspace),directories={str(workspace):registered(workspace,'worktree'),str(cache):registered(cache,'cache')})
actual=m.paths(request)[0];assert actual['assignment']=='A-1' and actual['sha']==expected['sha']
request['binding']['workspace']=str(base/'other');rejected();request['binding']['workspace']=str(workspace)
cache.rename(base/'old-cache');cache.mkdir(mode=0o700);rejected()
request['binding']['directories'][str(cache)]=registered(cache,'cache')
workspace.rename(base/'old-workspace');workspace.mkdir(mode=0o700);rejected()
print('binding replacements rejected')
`,
      helper,
      root,
    ]);
    expect(stdout.trim()).toBe("binding replacements rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
