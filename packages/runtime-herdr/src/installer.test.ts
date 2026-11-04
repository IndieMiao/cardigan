import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";

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
    version: "0.1.18",
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

const preflightProbe = `import importlib.util,sys,os
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
  const result = await python(preflightProbe, [root, "check"]);
  expect(result.stdout).toContain(
    "Read-only checks passed; no installation changes made.",
  );
});
