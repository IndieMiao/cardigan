import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { fixture } from "../../../test-support/worker-capabilities.js";
import {
  projectIsolationCombination,
  type WorkerPreflight,
  workerPreflight,
} from "./worker-preflight.js";

const native = resolve("deploy/worker-primitives.py");
const groupObservations = readFileSync(
  new URL(
    "../../../test-support/worker-account-observations.py",
    import.meta.url,
  ),
  "utf8",
);

test.each([
  ["Darwin", "safe", true],
  ["Darwin", "empty-process", true],
  ["Darwin", "process-implicit", true],
  ["Darwin", "process-admin", false],
  ["Darwin", "admin", false],
  ["Darwin", "staff", false],
  ["Darwin", "sharepoint", false],
  ["Darwin", "nested-project", false],
  ["Darwin", "explicit-everyone:GroupMembership", false],
  ["Darwin", "explicit-localaccounts:GroupMembers", false],
  ["Darwin", "explicit-_lpoperator:NestedGroups", false],
  ["Linux", "safe", true],
  ["Linux", "linux-implicit", false],
  ["Linux", "process-admin", false],
] as const)(
  "native isolation group policy on %s: %s",
  (system, fault, accepted) => {
    const source = `${groupObservations}
import runpy,sys
from types import SimpleNamespace as R
m=runpy.run_path(sys.argv[1])
account=R(pw_name='fixture',pw_uid=2201,pw_gid=2201,pw_dir='/fixture')
install_group_observations(m, account, sys.argv[3], sys.argv[2])
m['os'].getuid=m['os'].geteuid=lambda:2201
m['os'].getgid=m['os'].getegid=lambda:2201
# Equal roots stop the real entry point immediately AFTER identity/group checks;
# no filesystem observations are fabricated and no privileged IO is attempted.
try:
 m['project_isolation'](dict(account='fixture',uid=2201,home='/fixture',root='/fixture'))
 raise AssertionError('overlapping roots passed')
except ValueError as error:
 print('accepted' if str(error)=='isolation_roots' else 'blocked')
`;
    expect(
      execFileSync(
        "python3",
        ["-I", "-B", "-c", source, native, system, fault],
        {
          encoding: "utf8",
          timeout: 5000,
        },
      ).trim(),
    ).toBe(accepted ? "accepted" : "blocked");
  },
);
// Real openat/mode/ACL/socket operations; directory services, process credentials
// and root ownership are synthetic. This does not claim cross-UID field acceptance.
const probe = `import runpy,sys,os,stat,json,socket
from pathlib import Path
from types import SimpleNamespace as R
m=runpy.run_path(sys.argv[1]);base=Path(sys.argv[2]);fault=sys.argv[3]
uid=2001;gid=os.getgid();home=base/'home';root=base/'worker'
home.mkdir(mode=0o750);root.mkdir(mode=0o750)
account=R(pw_name='fixture',pw_uid=uid,pw_gid=gid,pw_dir=str(home))
m['pwd'].getpwnam=lambda _:account
m['pwd'].getpwall=lambda:[account]+([R(pw_name='alias',pw_uid=uid if fault=='uid-alias' else uid+1,pw_gid=gid+1 if fault=='uid-alias' else gid)] if fault in ('uid-alias','ci-primary-group') else [])
m['grp'].getgrgid=lambda _:R(gr_name='admin' if fault=='admin' else 'fixture',gr_mem=['ci'] if fault=='ci-group-member' else [])
m['os'].getgrouplist=lambda *a:[gid]+([gid+1] if fault=='extra-group' else [])
m['os'].getuid=lambda:uid
m['os'].geteuid=lambda:uid
m['os'].getgid=lambda:gid
m['os'].getegid=lambda:gid
m['os'].getgroups=lambda:[gid]
m['project_isolation'].__globals__['process_groups']=lambda:m['os'].getgroups()
for name in ('.local','.ssh'): (home/name).mkdir(mode=0o750)
for name in ('.config','.cache','.local/state','.local/share'): (home/name).mkdir(mode=0o700)
claim=home/'.cardigan-project';claim.write_text(json.dumps({'project':'fixture','uid':uid}));claim.chmod(0o644)
auth=home/'.ssh/authorized_keys';auth.write_text('synthetic-public-key');auth.chmod(0o640)
paths={k:str(root/k) for k in ('run','repo','worktree','build','cache','session','credentials','temporary','hc')}
for p in paths.values():Path(p).mkdir(mode=0o700)
sock=socket.socket(socket.AF_UNIX);socket_path=root/'hc/core.sock';sock.bind(str(socket_path));socket_path.chmod(0o600)
# Fake only administrative ownership of the synthetic tree and its parents.
protected={home,root,home/'.local',home/'.ssh',claim,auth,*base.parents,base}
root_inodes={p.stat().st_ino for p in protected}
original_fstat=os.fstat;original_stat=os.stat
def ownership(info):
 fields=list(info);fields[4]=0 if info.st_ino in root_inodes else uid;return os.stat_result(fields)
def fstat(fd):
 info=ownership(original_fstat(fd))
 # The fixture lives in the host temporary directory; model a protected ancestor.
 if info.st_ino in root_inodes:
  fields=list(info);fields[0]&=~0o022;info=os.stat_result(fields)
 return info
m['os'].fstat=fstat
m['os'].stat=lambda *a,**k:ownership(original_stat(*a,**k))
request=dict(project='fixture',account='fixture',uid=uid,home=str(home),root=str(root),paths=paths,socket=str(socket_path))
if fault=='wrong-uid':request['uid']+=1
if fault=='process-real-uid':m['os'].getuid=lambda:uid+1
if fault=='process-effective-root':m['os'].geteuid=lambda:0
if fault=='process-real-gid':m['os'].getgid=lambda:gid+1
if fault=='process-effective-gid':m['os'].getegid=lambda:gid+1
# Directory services already removed the foreign group; the process still has it.
if fault=='process-extra-group':m['os'].getgroups=lambda:[gid,gid+1]
if fault=='process-empty-groups':m['os'].getgroups=lambda:[]
if fault=='process-groups-unavailable':
 def unavailable():raise OSError('synthetic group query failure')
 m['os'].getgroups=unavailable
if fault=='claim':claim.write_text(json.dumps({'project':'other','uid':uid}))
if fault=='claim-hardlink':os.link(claim,base/'copy')
if fault=='shared-cache':(root/'cache').chmod(0o770)
if fault=='world-cache':(home/'.cache').chmod(0o755)
if fault=='missing-path':request['paths'].pop('credentials')
if fault=='outside':request['paths']['temporary']='/tmp'
if fault=='alias-path':request['paths']['build']=request['paths']['repo']
if fault=='symlink':(root/'cache').rmdir();(root/'cache').symlink_to(root/'repo')
if fault=='socket-mode':socket_path.chmod(0o660)
if fault=='socket-symlink':socket_path.unlink();socket_path.symlink_to(auth)
if fault=='auth-mode':auth.chmod(0o666)
if fault=='acl':
 original=m['project_isolation'].__globals__['acl_safe']
 m['project_isolation'].__globals__['acl_safe']=lambda fd: False if original_fstat(fd).st_ino==(root/'cache').stat().st_ino else original(fd)
try:
 result=m['project_isolation'](request)
 assert fault in ('valid','process-empty-groups'),fault
 assert result==dict(project='fixture',uid=uid,ready=True)
 print('passed')
except (ValueError,OSError):
 assert fault not in ('valid','process-empty-groups'),fault
 print('blocked')
finally:sock.close()
`;

test.each([
  "valid",
  "uid-alias",
  "ci-primary-group",
  "ci-group-member",
  "admin",
  "extra-group",
  "process-real-uid",
  "process-effective-root",
  "process-real-gid",
  "process-effective-gid",
  "process-extra-group",
  "process-empty-groups",
  "process-groups-unavailable",
  "wrong-uid",
  "claim",
  "claim-hardlink",
  "shared-cache",
  "world-cache",
  "missing-path",
  "outside",
  "alias-path",
  "symlink",
  "socket-mode",
  "socket-symlink",
  "auth-mode",
  "acl",
])(
  "native isolation handles %s without reading credential contents",
  (fault) => {
    const root = mkdtempSync(join(tmpdir(), "b8-"));
    try {
      expect(
        execFileSync("python3", ["-B", "-c", probe, native, root, fault], {
          encoding: "utf8",
          timeout: 5000,
        }).trim(),
      ).toBe(
        ["valid", "process-empty-groups"].includes(fault)
          ? "passed"
          : "blocked",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(["valid", "empty", "query-failure", "read-failure", "changed-count"])(
  "macOS samples inherited process groups through libc (%s)",
  (fault) => {
    const code = `import runpy,sys
from types import SimpleNamespace as R
m=runpy.run_path(sys.argv[1]);fault=sys.argv[2]
m['platform'].system=lambda:'Darwin'
def forbidden():raise AssertionError('queried dynamic directory-service groups')
m['os'].getgroups=forbidden
class Groups:
 def __call__(self,size,entries):
  if entries is None:return -1 if fault=='query-failure' else (0 if fault=='empty' else 2)
  if fault=='read-failure':return -1
  if fault=='changed-count':return size+1
  if fault=='empty':return 0
  entries[0]=2001;entries[1]=2002;return 2
m['ctypes'].CDLL=lambda *a,**k:R(getgroups=Groups())
try:
 groups=m['process_groups']()
 assert fault in ('valid','empty')
 assert groups==([2001,2002] if fault=='valid' else [])
except OSError:assert fault in ('query-failure','read-failure','changed-count')
print('verified')
`;
    expect(
      execFileSync("python3", ["-B", "-c", code, native, fault], {
        encoding: "utf8",
        timeout: 5000,
      }).trim(),
    ).toBe("verified");
  },
);

test("preflight requires current native isolation and matching operator evidence", () => {
  const { manifest, requirements } = fixture();
  const config: WorkerPreflight = {
    requirements,
    paths: [],
    minimum_free_bytes: { root: 1, work: 1 },
    credentials: [],
    isolation: {
      project: "fixture",
      account: "fixture",
      uid: requirements.uid,
      home: "/private/home",
      root: "/private/worker",
      socket: "/private/home/hc/core.sock",
      paths: Object.fromEntries(
        [
          "run",
          "repo",
          "worktree",
          "build",
          "cache",
          "session",
          "credentials",
          "temporary",
          "hc",
        ].map((k) => [k, `/private/worker/${k}`]),
      ) as NonNullable<WorkerPreflight["isolation"]>["paths"],
    },
  };
  const isolation = config.isolation;
  if (!isolation) throw new Error("Missing fixture");
  const observed = { project: "fixture", uid: requirements.uid, ready: true };
  const check = (value = observed) =>
    workerPreflight(config, manifest, [], value).blockers;
  expect(check()).toContain("project_isolation");
  isolation.verified = {
    uid: requirements.uid,
    combination: projectIsolationCombination(config, manifest),
    evidence: "operator-b8",
  };
  expect(check()).not.toContain("project_isolation");
  Reflect.deleteProperty(isolation.verified, "evidence");
  expect(check()).toContain("project_isolation");
  isolation.verified.evidence = "operator-b8";
  expect(workerPreflight(config, manifest, []).blockers).toContain(
    "project_isolation",
  );
  expect(check({ ...observed, uid: 0 })).toContain("project_isolation");
  expect(check({ ...observed, project: "other" })).toContain(
    "project_isolation",
  );
  expect(check({ ...observed, ready: false })).toContain("project_isolation");
  isolation.paths.cache = "/private/new-cache";
  expect(check()).toContain("project_isolation");
});

test("Linux private-worker dry-run is read-only and keeps remote disabled", () => {
  const report = JSON.parse(
    execFileSync(
      "python3",
      [
        "-B",
        "deploy/install-linux-worker.py",
        "--config",
        "/absent/fixture",
        "--dry-run",
      ],
      { encoding: "utf8" },
    ),
  );
  expect(report.platform).toBe("linux");
  expect(report.manual).toContain("account");
});

// Only the operator sets this on a prepared synthetic machine, once per account.
// A missing peer/file/socket is an error, never evidence of permission denial.
test.skipIf(!process.env.CARDIGAN_ISOLATION_FIXTURE)(
  "onsite: real project/CI UID cannot read, enumerate, write or connect to peers",
  () => {
    const code = `import runpy,sys,os,socket
from pathlib import Path
m=runpy.run_path('deploy/install-macos-worker.py')
c=m['trusted_json'](Path(sys.argv[1]),0o644)
assert c['synthetic_only'] is True and c['uid']==os.getuid() and c['uid']>0
assert Path(c['own_fixture']).read_text()=='B8 synthetic only\\n'
assert len(c['peers'])>=1
def denied(operation):
 try:operation()
 except PermissionError:return
 raise AssertionError('isolation_breach')
for peer in c['peers']:
 assert peer['uid']!=c['uid'] and peer['uid']>0
 assert set(peer['paths'])=={'source','clone','run','cache','session','credentials','check'}
 for path in peer['paths'].values():
  p=Path(path)
  def read():
   with (p/'fixture').open('rb') as f:f.read(1)
  def listing():
   with os.scandir(p) as entries:next(entries,None)
  def write():
   target=p/('.b8-write-'+str(os.getpid()))
   fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   os.close(fd);target.unlink()
  for operation in (read,listing,write):denied(operation)
 with socket.socket(socket.AF_UNIX) as sock:
  sock.settimeout(2);denied(lambda:sock.connect(peer['socket']))
print('passed')
`;
    expect(
      execFileSync(
        "python3",
        ["-B", "-c", code, process.env.CARDIGAN_ISOLATION_FIXTURE ?? ""],
        {
          encoding: "utf8",
          timeout: 10000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim(),
    ).toBe("passed");
  },
);
