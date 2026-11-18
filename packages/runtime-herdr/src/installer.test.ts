import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { darwinSharedGroupCases } from "../../../test-support/worker-account-cases.js";
import { HC_RELEASE } from "./hc-version.js";

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL("../../../deploy/install-agent.py", import.meta.url),
);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cardigan-install-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const args = () => [
  "--host-user",
  "operator",
  "--data-dir",
  join(root, "private"),
  "--agent-root",
  join(root, "agent"),
  "--dry-run",
];
const python = (code: string, rest: string[] = []) =>
  exec("python3", ["-B", "-c", code, script, ...rest], { timeout: 10000 });

test("installer dry-run is repeatable and cannot invoke subprocesses or download payloads", async () => {
  const probe = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
def forbidden(*a,**k): raise AssertionError('dry-run performed IO')
mod.subprocess.run=forbidden;mod.urllib.request.urlopen=forbidden
sys.argv=[sys.argv[1],*sys.argv[2:]];mod.main()`;
  const first = await python(probe, args());
  expect((await python(probe, args())).stdout).toBe(first.stdout);
  expect(JSON.parse(first.stdout)).toMatchObject({
    version: HC_RELEASE.version,
    shared_group: "cardigan-share",
    data_mode: "0700",
    parent_mode: "2750",
    assignment_directory_mode: "2770",
    credential_mode: "0660",
    changes_ssh_config: false,
  });
});

test.each(["root", "agent", "-operator", "user;command"])(
  "installer refuses unsafe host account %s",
  async (user) => {
    const input = args();
    input[1] = user;
    await expect(
      exec("python3", ["-B", script, ...input], { timeout: 10000 }),
    ).rejects.toThrow();
  },
);
test("installer refuses overlapping roots and relative or parent-traversing paths", async () => {
  for (const path of [
    "relative",
    "/tmp/../root",
    join(root, "private", "agent"),
  ]) {
    const input = args();
    input[5] = path;
    await expect(
      exec("python3", ["-B", script, ...input], { timeout: 10000 }),
    ).rejects.toThrow();
  }
});

test("archive verification precedes extraction and extracts only the regular executable", async () => {
  const probe = `import importlib.util,sys,io,tarfile,hashlib
from pathlib import Path
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
archive=Path(sys.argv[2])/'fixture.tar.gz'
def bundle(link=False):
 data=io.BytesIO()
 with tarfile.open(fileobj=data,mode='w:gz') as tar:
  info=tarfile.TarInfo('herdr-core')
  if link: info.type=tarfile.SYMTYPE;info.linkname='/outside'
  else: info.size=7
  tar.addfile(info,None if link else io.BytesIO(b'fixture'))
 archive.write_bytes(data.getvalue());mod.CHECKSUMS['fixture']=hashlib.sha256(data.getvalue()).hexdigest()
mod.HC_RELEASE['targets']['linux-fixture']={'url':f'https://releases.herdr.dev/core/{mod.VERSION}/herdr-core-linux-fixture.tar.gz'}
bundle();assert mod.payload(archive,'fixture')==b'fixture'
archive.write_bytes(b'tampered')
try: mod.payload(archive,'fixture');raise AssertionError('accepted bad checksum')
except RuntimeError as e: assert 'sha256' in str(e)
bundle(True)
try: mod.payload(archive,'fixture');raise AssertionError('accepted symlink')
except RuntimeError as e: assert 'regular' in str(e)
print('verified')`;
  expect((await python(probe, [root])).stdout.trim()).toBe("verified");
});

test.each(["x86_64", "aarch64"])(
  "installer downloads %s with only the fixed product UA and retains verification",
  async (arch) => {
    const probe = `import importlib.util,sys,io,tarfile,hashlib,urllib.error
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
arch=sys.argv[2]
assert mod.DOWNLOAD_USER_AGENT=='cardigan-hc-download/1'
for mode in ['success','checksum','symlink','hardlink','directory','http-error']:
 archive=io.BytesIO()
 with tarfile.open(fileobj=archive,mode='w:gz') as tar:
  info=tarfile.TarInfo('herdr-core')
  if mode in ['symlink','hardlink','directory']:
   info.type={'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'directory':tarfile.DIRTYPE}[mode];info.linkname='../outside'
   tar.addfile(info)
  else:
   info.size=7;tar.addfile(info,io.BytesIO(b'fixture'))
 data=archive.getvalue()
 mod.CHECKSUMS[arch]='0'*64 if mode=='checksum' else hashlib.sha256(data).hexdigest()
 calls=[]
 def urlopen(request,**kwargs):
  calls.append(request)
  assert isinstance(request,mod.urllib.request.Request)
  assert request.full_url==f'https://releases.herdr.dev/core/{mod.VERSION}/herdr-core-linux-{arch}.tar.gz'
  assert request.get_method()=='GET' and request.data is None
  assert dict(request.header_items())=={'User-agent':mod.DOWNLOAD_USER_AGENT}
  assert kwargs=={'timeout':60}
  if mode=='http-error':raise urllib.error.HTTPError(request.full_url,403,'fixture rejection',{},None)
  return io.BytesIO(data)
 mod.urllib.request.urlopen=urlopen
 try:
  assert mod.payload(None,arch)==b'fixture';assert mode=='success'
 except RuntimeError as error:
  assert ('sha256' if mode=='checksum' else 'regular') in str(error)
 except urllib.error.HTTPError as error:
  assert mode=='http-error' and error.code==403
 assert len(calls)==1
print('verified download boundary')`;
    expect((await python(probe, [arch])).stdout.trim()).toBe(
      "verified download boundary",
    );
  },
);

const preflightFixture = `import importlib.util,sys,os
from pathlib import Path
from types import SimpleNamespace as Record
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
root=Path(sys.argv[2]);fault=sys.argv[3];home=root/'host';home.mkdir(mode=0o750)
hostkey=root/'host_ed25519.pub';hostkey.write_text('ssh-ed25519 fixture-host-public-key')
host=Record(pw_name='operator',pw_uid=os.getuid() or 1000,pw_gid=os.getgid(),pw_dir=str(home))
mod.AGENT_HOME=root/'agent-home';mod.os.geteuid=lambda:0;mod.platform.system=lambda:'Linux'
mod.shutil.which=lambda name: None if name==fault else '/fixture/'+name
other=Record(pw_name='unrelated',pw_gid=9876)
shared=Record(gr_gid=9876,gr_mem=['unrelated'] if fault=='members' else [])
def getuser(name):
 if name=='operator': return host
 raise KeyError(name)
def getgroup(name):
 if name==mod.GROUP and fault in ['primary-group','members']: return shared
 raise KeyError(name)
mod.pwd.getpwnam=getuser;mod.grp.getgrnam=getgroup;mod.pwd.getpwall=lambda:[host,other]
if fault=='home-mode':home.chmod(0o751)
if fault=='host-key':hostkey.unlink()
if fault=='path':(root/'agent').symlink_to(home,target_is_directory=True)
settings='''pubkeyauthentication yes
hostbasedauthentication no
authorizedkeyscommand none
trustedusercakeys none
kbdinteractiveauthentication no
gssapiauthentication no
authorizedkeysfile .ssh/authorized_keys
hostkey '''+str(hostkey)[:-4]
if fault=='ssh-policy':settings=settings.replace('pubkeyauthentication yes','pubkeyauthentication no')
calls=[]
def run(*args,**kwargs):
 if args==('sudo','-V'):return 'sudo fixture version'
 if args[0]=='sshd' and args[1]=='-T':return settings
 calls.append(args);raise AssertionError('mutation attempted before rejection')
def mutation(*a,**kw):calls.append(a);raise AssertionError('filesystem mutation attempted')
mod.run=run;mod.directory=mutation;mod.atomic_file=mutation;mod.subprocess.run=mutation
mod.payload=lambda *a:b'verified fixture executable'
`;
const preflightProbe = `${preflightFixture}
before=sorted(str(p) for p in root.rglob('*'))
sys.argv=[sys.argv[1],'--host-user','operator','--data-dir',str(root/'private'),'--agent-root',str(root/'agent')]
if fault=='check':sys.argv+=['--check']
try:
 mod.main()
 assert fault=='check','expected a preflight rejection'
except RuntimeError as e:
 expected={'primary-group':"another user's primary group",'members':'other users','home-mode':'other users to traverse',
 'host-key':'ed25519 host key','path':'symlink','ssh-policy':'pubkeyauthentication','sudo':'prerequisite: sudo','setfacl':'prerequisite: setfacl'}[fault]
 assert expected in str(e),str(e)
 print('rejected before mutation: '+fault)
assert calls==[],calls
assert sorted(str(p) for p in root.rglob('*'))==before
`;

test.each([
  "primary-group",
  "members",
  "home-mode",
  "host-key",
  "path",
  "ssh-policy",
  "sudo",
  "setfacl",
])(
  "preflight rejects %s before any account command or filesystem write",
  async (fault) => {
    const result = await python(preflightProbe, [root, fault]);
    expect(result.stdout).toContain(`rejected before mutation: ${fault}`);
  },
);
test("--check runs the successful read-only preflight without beginning installation", async () => {
  const result = await python(
    preflightProbe.replace(
      "before=sorted",
      "mod.payload=mutation\nbefore=sorted",
    ),
    [root, "check"],
  );
  expect(result.stdout).toContain(
    "Read-only checks passed; no installation changes made.",
  );
});

test("macOS dry-run neither opens configuration nor starts processes", async () => {
  const macScript = fileURLToPath(
    new URL("../../../deploy/install-macos-worker.py", import.meta.url),
  );
  const { stdout } = await exec("python3", [
    "-B",
    "-c",
    `import importlib.util,sys
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def forbidden(*a,**k): raise AssertionError('dry-run side effect')
m.subprocess.run=forbidden;m.preflight=forbidden;m.apply=forbidden
sys.argv=[sys.argv[1],'--config','/nonexistent/private-config','--dry-run'];m.main()
`,
    macScript,
  ]);
  expect(JSON.parse(stdout)).toMatchObject({
    platform: "darwin",
    arch: "arm64",
    hc: HC_RELEASE.version,
  });
});

// Every privileged command is a fixture: exercise main's post-create check and
// the real preflight of a partially installed account without invoking sudo.
const sudoProbe = `${preflightFixture}
import json
managed=sys.argv[4]=='managed';result=json.loads(sys.argv[5]);sudo_calls=[]
agent=Record(pw_name='agent',pw_uid=9877,pw_gid=9877,pw_dir=str(mod.AGENT_HOME))
account_exists=managed;group_exists=False
def getuser(name):
 if name=='operator':return host
 if name=='agent' and account_exists:return agent
 raise KeyError(name)
def getgroup(name):
 if name==mod.GROUP and group_exists:return shared
 raise KeyError(name)
mod.pwd.getpwnam=getuser;mod.grp.getgrnam=getgroup
mod.os.getgrouplist=lambda *a:[agent.pw_gid]
if managed:
 mod.AGENT_HOME.mkdir(mode=0o750)
 marker=mod.AGENT_HOME/'.cardigan-managed'
 marker.write_text(json.dumps({'host':'operator','data':str(root/'private'),'root':str(root/'agent')}));marker.chmod(0o600)
 original_stat=Path.stat
 def managed_stat(path,*a,**kw):
  value=original_stat(path,*a,**kw)
  if path in [mod.AGENT_HOME,marker]:
   fields=list(value);fields[4]=0;return os.stat_result(fields)
  return value
 Path.stat=managed_stat
os.environ['LC_ALL']='fixture-locale';os.environ['LANG']='fixture-language'
def subprocess_run(command,**kwargs):
 if command==['sudo','-n','-l','-U','agent']:
  assert kwargs['env']['LC_ALL']=='C' and kwargs['env']['LANG']=='C'
  assert kwargs['capture_output'] is True and kwargs['text'] is True
  sudo_calls.append(command)
  return mod.subprocess.CompletedProcess(command,result['code'],result['stdout'],result['stderr'])
 if command[:5]==['runuser','-u','agent','--','test']:
  return mod.subprocess.CompletedProcess(command,1)
 raise AssertionError('unexpected subprocess: '+str(command))
mod.subprocess.run=subprocess_run
class CheckPassed(Exception):pass
read_run=mod.run
def install_run(*args,**kwargs):
 global account_exists,group_exists
 if args[0] in ['sudo','sshd']:return read_run(*args,**kwargs)
 calls.append(args)
 if args[0]=='useradd':account_exists=True
 elif args[0]=='groupadd':group_exists=True
 elif args[0]=='passwd':pass
 elif args[0]=='usermod':raise CheckPassed()
 else:raise AssertionError('unexpected install command: '+str(args))
 return ''
mod.run=install_run
mod.directory=lambda *a:calls.append(('directory',*a))
mod.atomic_file=lambda *a:calls.append(('atomic_file',*a))
before=sorted(str(p) for p in root.rglob('*'))
sys.argv=[sys.argv[1],'--host-user','operator','--data-dir',str(root/'private'),'--agent-root',str(root/'agent')]
if managed:sys.argv+=['--check']
passed=False
try:
 mod.main();assert managed;passed=True
except CheckPassed:
 assert not managed;passed=True
except RuntimeError as error:
 assert 'sudo rights' in str(error),str(error)
assert len(sudo_calls)==1
assert os.environ['LC_ALL']=='fixture-locale' and os.environ['LANG']=='fixture-language'
assert sorted(str(p) for p in root.rglob('*'))==before
if managed:assert calls==[],calls
else:
 assert any(call[0]=='useradd' for call in calls)
 assert any(call[0]=='usermod' for call in calls)==passed
print(json.dumps({'passed':passed,'sudo_calls':len(sudo_calls)}))
`;

const sudoCases = [
  {
    name: "traditional sudo denial",
    code: 1,
    stdout: "",
    stderr: "",
    passed: true,
  },
  {
    name: "sudo-rs denial on stdout",
    code: 0,
    stdout: "User agent is not allowed to run sudo on fixture-host.\n",
    stderr: "",
    passed: true,
  },
  {
    name: "sudo-rs denial on stderr",
    code: 0,
    stdout: "",
    stderr: "User agent is not allowed to run sudo on fixture-host.\n",
    passed: true,
  },
  {
    name: "allowed commands",
    code: 0,
    stdout:
      "User agent may run the following commands on fixture-host:\n    (ALL : ALL) ALL\n",
    stderr: "",
    passed: false,
  },
  {
    name: "empty successful output",
    code: 0,
    stdout: "",
    stderr: "",
    passed: false,
  },
  {
    name: "unrecognized successful output",
    code: 0,
    stdout: "Policy result unavailable\n",
    stderr: "",
    passed: false,
  },
];
test.each(
  ["new", "managed"].flatMap((account) =>
    sudoCases.map((result) => ({ account, ...result })),
  ),
)(
  "$account account sudo check handles $name with a fixed locale",
  async ({ account, passed, ...result }) => {
    const response = await python(sudoProbe, [
      root,
      "sudo-case",
      account,
      JSON.stringify(result),
    ]);
    expect(JSON.parse(response.stdout.trim().split("\n").at(-1) ?? "")).toEqual(
      { passed, sudo_calls: 1 },
    );
  },
);

const groupObservations = readFileSync(
  new URL(
    "../../../test-support/worker-account-observations.py",
    import.meta.url,
  ),
  "utf8",
);
const macFixture = `${groupObservations}
import importlib.util,sys,os,json,stat
from pathlib import Path
from types import SimpleNamespace as Record
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
base=Path(sys.argv[2]);fault=sys.argv[3];root=base/'worker';home=base/'home'
root.mkdir(mode=0o750);home.mkdir(mode=0o750)
account=Record(pw_name='fixture',pw_uid=os.getuid(),pw_gid=os.getgid(),pw_dir=str(home))
config={'account':'fixture','uid':account.pw_uid,'project':'fixture-project','root':str(root),'mount':str(base),
 'volume':str(os.statvfs(base).f_fsid),'minimum_free_bytes':{'root':1,'work':1},'timeout_ms':2000}
marker=root/'.cardigan-worker';marker.write_text(json.dumps({'project':'fixture-project','uid':account.pw_uid,'home':str(home)}));marker.chmod(0o600)
claim=home/'.cardigan-project';claim.write_text(json.dumps({'project':'fixture-project','uid':account.pw_uid}));claim.chmod(0o644)
original_lstat=Path.lstat
root_paths={root,home,marker,claim,root/'runs',root/'repos',root/'worktrees',root/'builds',root/'locks',root/'libexec',root/'locks/git.lock',root/'locks/tests.lock',root/'libexec/worker-primitives.py'}
def lstat(path,*a,**k):
 value=original_lstat(path,*a,**k)
 if path in root_paths:
  fields=list(value);fields[4]=0;return os.stat_result(fields)
 return value
Path.lstat=lstat
original_fstat=os.fstat
def fstat(fd):
 value=original_fstat(fd)
 if any((p.exists() and p.stat().st_ino==value.st_ino) for p in root_paths):
  fields=list(value);fields[4]=0;return os.stat_result(fields)
 return value
m.os.fstat=fstat
# Root ownership, account lookup and ACLs are synthetic; never sudo/chown real accounts.
m.platform.system=lambda:'Darwin';m.platform.machine=lambda:'arm64';m.os.geteuid=lambda:0
m.pwd.getpwnam=lambda _:account;m.os.getgrouplist=lambda *a:[account.pw_gid]
native=m.runpy.run_path(str(Path(sys.argv[1]).with_name('worker-primitives.py')))
install_group_observations(native, account, fault)
m.protected=lambda path:None;m.os.path.ismount=lambda path:path==base
m.subprocess.run=lambda *a,**k:Record(returncode=1,stdout='User fixture is not allowed to run sudo',stderr='')
m.os.chown=lambda *a:None;m.os.fchown=lambda *a:None
m.runpy.run_path=lambda _: {'acl_safe':lambda fd:fault!='acl','directory':lambda path,uid:os.open(path,os.O_RDONLY),
 'isolation_account':native['isolation_account'],'isolation_directory':lambda path,*args:os.open(path,os.O_RDONLY)}
if fault=='uid':config['uid']+=1
if fault=='groups':m.os.getgrouplist=lambda *a:[account.pw_gid,9999]
if fault=='marker':marker.write_text('{}')
if fault=='claim':claim.write_text('{}')
if fault=='sudo':m.subprocess.run=lambda *a,**k:Record(returncode=0,stdout='ALL',stderr='')
if fault=='unmounted':m.os.path.ismount=lambda _:False
if fault=='volume':config['volume']='changed'
if fault=='space':config['minimum_free_bytes']['work']=2**63
if fault in ['conflict','acl']:
 (root/'worktrees').mkdir(mode=0o755 if fault=='conflict' else 0o700)
if fault=='symlink':(root/'worktrees').symlink_to(home)
if fault=='helper':
 (root/'libexec').mkdir(mode=0o750)
 (root/'libexec/worker-primitives.py').write_text('unmanaged helper');(root/'libexec/worker-primitives.py').chmod(0o750)
before=sorted(str(p) for p in base.rglob('*'))
accepted=fault.startswith('apply') or fault=='check' or (len(sys.argv)>4 and sys.argv[4]=='accepted')
try:
 user,location=m.preflight(config)
 assert accepted,fault
 if fault.startswith('apply'):
  os.umask(int(fault.split('-')[1],8) if '-' in fault else 0o022)
  m.apply(user,location);inode=(root/'locks/tests.lock').stat().st_ino
  names=sorted(str(p) for p in base.rglob('*'));m.preflight(config);m.apply(user,location)
  assert (root/'locks/tests.lock').stat().st_ino==inode
  assert sorted(str(p) for p in base.rglob('*'))==names
 else:assert sorted(str(p) for p in base.rglob('*'))==before
 print('passed '+fault)
except (ValueError,OSError,KeyError):
 assert not accepted,fault
 assert sorted(str(p) for p in base.rglob('*'))==before
 print('blocked '+fault)
`;

test("review: macOS installer must reject config ACL before reading root configuration", async () => {
  const macScript = fileURLToPath(
    new URL("../../../deploy/install-macos-worker.py", import.meta.url),
  );
  const result = await exec("python3", [
    "-B",
    "-c",
    `
import importlib.util,sys,os,json,stat
from pathlib import Path
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
base=Path(sys.argv[2]);config=base/'acl-config.json';config.write_text('{}');config.chmod(0o600)
original=Path.lstat
def owned(path,*a,**k):
 info=original(path,*a,**k);fields=list(info);fields[4]=0
 if stat.S_ISDIR(fields[0]):fields[0]&=~0o022
 return os.stat_result(fields)
Path.lstat=owned
checks=[];reads=[]
def acl(fd):checks.append('acl');return False
def directory(*a,**k):checks.append('directory');raise ValueError('unsafe_acl')
m.runpy.run_path=lambda _: {'acl_safe':acl,'directory':directory}
def read(path,*a,**k):reads.append(str(path));raise ValueError('configuration_read_before_acl')
Path.read_text=read
sys.argv=[sys.argv[1],'--config',str(config),'--check']
try:m.main()
except ValueError:pass
print(json.dumps({'configuration_read':bool(reads),'native_acl_checked':bool(checks)}))
`,
    macScript,
    root,
  ]);
  expect(JSON.parse(result.stdout)).toEqual({
    configuration_read: false,
    native_acl_checked: true,
  });
});

test.each([
  "apply",
  "apply-077",
  "apply-027",
  "check",
  "uid",
  "groups",
  "admin",
  "primary-staff",
  "primary-sharepoint",
  "staff",
  "sharepoint",
  "explicit-everyone:GroupMembership",
  "explicit-localaccounts:GroupMembers",
  "nested-project",
  "marker",
  "claim",
  "sudo",
  "unmounted",
  "volume",
  "space",
  "conflict",
  "symlink",
  "helper",
  "acl",
])(
  "macOS installer fixture handles %s before mutation and preserves repeated-apply lock identity",
  async (fault) => {
    const macScript = fileURLToPath(
      new URL("../../../deploy/install-macos-worker.py", import.meta.url),
    );
    const result = await exec(
      "python3",
      ["-B", "-c", macFixture, macScript, root, fault],
      { timeout: 10000 },
    );
    expect(result.stdout.trim()).toBe(
      `${fault.startsWith("apply") || fault === "check" ? "passed" : "blocked"} ${fault}`,
    );
  },
);

test.each(darwinSharedGroupCases)(
  "Q-870 public-folder group installer: %s",
  async (fault, accepted) => {
    const macScript = fileURLToPath(
      new URL("../../../deploy/install-macos-worker.py", import.meta.url),
    );
    const result = await exec(
      "python3",
      [
        "-B",
        "-c",
        macFixture,
        macScript,
        root,
        fault,
        accepted ? "accepted" : "blocked",
      ],
      { timeout: 10000 },
    );
    expect(result.stdout.trim()).toBe(
      `${accepted ? "passed" : "blocked"} ${fault}`,
    );
  },
);

test.each([
  "valid",
  "parent-acl",
  "file-acl",
  "unknown-acl",
  "hardlink",
  "symlink",
  "replaced",
])(
  "trusted configuration and management-marker reads reject %s before consuming untrusted bytes",
  async (fault) => {
    const macScript = fileURLToPath(
      new URL("../../../deploy/install-macos-worker.py", import.meta.url),
    );
    const result = await exec("python3", [
      "-B",
      "-c",
      `import importlib.util,sys,os,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
base=Path(sys.argv[2]);fault=sys.argv[3]
real_fstat=os.fstat;real_fdopen=os.fdopen
reads=[];checks=[]
def owned(fd):
 info=real_fstat(fd);fields=list(info);fields[4]=0;return os.stat_result(fields)
m.os.fstat=owned
class Reader:
 def __init__(self,file):self.file=file
 def __enter__(self):self.file.__enter__();return self
 def __exit__(self,*args):return self.file.__exit__(*args)
 def read(self,size):reads.append('read');return self.file.read(size)
m.os.fdopen=lambda *a,**k:Reader(real_fdopen(*a,**k))
for name in ['configuration.json','.cardigan-worker']:
 path=base/name;path.write_text('{"fixture":true}');path.chmod(0o600)
 def directory(parent,uid):
  checks.append('directory')
  if fault=='parent-acl':raise ValueError('unsafe_parent')
  return os.open(parent,os.O_RDONLY|os.O_DIRECTORY)
 def acl(fd):
  checks.append('file-acl')
  if fault=='unknown-acl':raise OSError('unknown ACL')
  if fault=='replaced':
   path.unlink();path.write_text('{"changed":true}');path.chmod(0o600)
  return fault!='file-acl'
 m.runpy.run_path=lambda _:dict(directory=directory,acl_safe=acl)
 if fault=='hardlink':os.link(path,base/(name+'.alias'))
 if fault=='symlink':
  target=base/(name+'.target');path.rename(target);path.symlink_to(target)
 try:
  assert m.trusted_json(path)=={'fixture':True};assert fault=='valid'
 except (ValueError,OSError):assert fault!='valid'
assert len(reads)==(2 if fault=='valid' else 0),(reads,checks)
assert checks[0]=='directory'
print('guarded reads checked')
`,
      macScript,
      root,
      fault,
    ]);
    expect(result.stdout.trim()).toBe("guarded reads checked");
  },
);

test.each([
  "https://releases.herdr.dev.evil.invalid/core/",
  "http://releases.herdr.dev/core/",
  "https://releases.herdr.dev/core/../other/",
])("rejects unofficial download URL %s before network access", async (url) => {
  const probe = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
mod.HC_RELEASE['targets']['linux-x86_64']['url']=sys.argv[2]
def forbidden(*a,**k): raise AssertionError('download reached network')
mod.urllib.request.urlopen=forbidden
try: mod.payload(None,'x86_64');raise AssertionError('accepted bad URL')
except RuntimeError as error: assert 'official release address' in str(error)
print('rejected')`;
  expect((await python(probe, [url])).stdout.trim()).toBe("rejected");
});
