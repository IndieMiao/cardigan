import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";

/**
 * C-679: host-owned cleanup for one adb slot, run on the actual worker as the
 * project account (never a project file). It only talks to loopback ports of
 * this slot: the adb server protocol's `host:kill` (what `adb -P <port>
 * kill-server` sends) and the emulator console's `kill` (authenticated with
 * the account's console token). No PID is read from disk.
 *
 * argv[1] is the JSON context. `check` reports how many of the slot's ports
 * are listening; `release` closes them and reports what is left.
 *
 * C-848: both also count this account's emulator and adb processes of the
 * slot (an emulator whose `-port` is the slot's console port or that names
 * the Run, a listener on its ports), so an emulator the port check misses is
 * still found. What the console or adb protocol did not close within a few
 * seconds `release` stops by PID (SIGTERM, then SIGKILL), each checked
 * against its start stamp first. Processes naming a Run in `keep_sessions`
 * and the ports they hold are left alone. The processes are reported with
 * their parent PID and whether they had to be signalled.
 *
 * C-833 `usb_off` (legacy fixed ports only): a server of this account that
 * lists a USB device (it claimed the device, typically because a session
 * from before the switch started it without `ADB_USB=0`) is stopped with
 * `host:kill` and started again on the same port with `ADB_USB=0`; its
 * emulators are registered again under their old serials (`host:emulator`,
 * what an emulator sends on start) and network devices reconnected. A
 * server another account runs is only counted (`foreign`): its own project's
 * pass restarts it with that account's adb keys. `found` counts restarted
 * servers, `left` those still holding USB or not back.
 */
export const ADB_SLOT_SCRIPT = `import json,os,pwd,re,shutil,signal,socket,subprocess,sys,time
c=json.loads(sys.argv[1])
adb=[p for p in c.get('adb_ports',[]) if isinstance(p,int)]
emu=[p for p in c.get('emulator_ports',[]) if isinstance(p,int)]
ports=adb+[q for p in emu for q in (p,p+1)]
def up(p):
 s=socket.socket(socket.AF_INET,socket.SOCK_STREAM); s.settimeout(0.5)
 try:
  s.connect(('127.0.0.1',p)); return True
 except OSError:
  return False
 finally:
  s.close()
def read_ok(s,limit=4096):
 b=b''
 try:
  while b'OK' not in b and len(b)<limit:
   d=s.recv(1024)
   if not d: break
   b+=d
 except OSError:
  pass
 return b
def emu_kill(p):
 try:
  s=socket.create_connection(('127.0.0.1',p),1); s.settimeout(1)
 except OSError:
  return
 try:
  if b'Authentication required' in read_ok(s):
   try:
    with open(os.path.join(pwd.getpwuid(os.getuid()).pw_dir,'.emulator_console_auth_token'),'rb') as f: t=f.read(256).strip()
   except OSError:
    t=b''
   s.sendall(b'auth '+t+b'\\r\\n'); read_ok(s)
  # C-848: no need to wait for the goodbye; what stays up is stopped by PID.
  s.settimeout(0.3); s.sendall(b'kill\\r\\n'); read_ok(s)
 except OSError:
  pass
 finally:
  s.close()
def adb_kill(p):
 try:
  s=socket.create_connection(('127.0.0.1',p),1); s.settimeout(1)
 except OSError:
  return
 try:
  s.settimeout(0.5); s.sendall(b'0009host:kill'); s.recv(4)
 except OSError:
  pass
 finally:
  s.close()
def recvn(s,n):
 b=b''
 while len(b)<n:
  d=s.recv(n-len(b))
  if not d: raise OSError()
  b+=d
 return b
def query(p,svc):
 try:
  s=socket.create_connection(('127.0.0.1',p),1); s.settimeout(2)
 except OSError:
  return None
 try:
  s.sendall(b'%04x'%len(svc)+svc)
  if recvn(s,4)!=b'OKAY': return None
  return recvn(s,int(recvn(s,4),16)).decode('utf-8','replace')
 except (OSError,ValueError):
  return None
 finally:
  s.close()
def notify(p,svc):
 try:
  s=socket.create_connection(('127.0.0.1',p),1); s.settimeout(0.5)
 except OSError:
  return
 try:
  s.sendall(b'%04x'%len(svc)+svc); s.recv(64)
 except OSError:
  pass
 finally:
  s.close()
def serials(listing):
 return [l.split()[0] for l in (listing or '').splitlines() if l.strip()]
def usb(s):
 return not s.startswith('emulator-') and ':' not in s and '._adb' not in s
def own(p):
 uid=os.getuid()
 if sys.platform.startswith('linux'):
  for f in ('/proc/net/tcp','/proc/net/tcp6'):
   try:
    with open(f) as h: rows=h.read().splitlines()[1:]
   except OSError:
    continue
   for r in rows:
    x=r.split()
    try:
     if len(x)>7 and x[3]=='0A' and int(x[1].rsplit(':',1)[1],16)==p and int(x[7])==uid: return True
    except ValueError:
     pass
  return False
 try:
  o=subprocess.run(['/usr/sbin/lsof','-nP','-a','-u',str(uid),'-iTCP:%d'%p,'-sTCP:LISTEN','-t'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=3).stdout
  return bool(o.strip())
 except (OSError,subprocess.SubprocessError):
  return False
def usb_off():
 deadline=time.monotonic()+8.0
 home=pwd.getpwuid(os.getuid()).pw_dir
 env=dict(os.environ,HOME=home,ADB_USB='0')
 for k in ('ANDROID_SERIAL','ADB_SERVER_SOCKET','ANDROID_ADB_SERVER_ADDRESS','ANDROID_ADB_SERVER_PORT'): env.pop(k,None)
 tool=shutil.which('adb')
 r=dict(generation=c.get('generation'),found=0,left=0,foreign=0,reconnected=0,missing=0)
 for p in adb:
  names=serials(query(p,b'host:devices')) if up(p) else []
  if not any(usb(s) for s in names): continue
  if not own(p):
   r['foreign']+=1; continue
  r['found']+=1
  if not tool or deadline-time.monotonic()<4:
   r['left']+=1; continue
  others=[s for s in names if not usb(s)]
  adb_kill(p)
  end=min(deadline,time.monotonic()+3)
  while up(p) and time.monotonic()<end: time.sleep(0.1)
  if up(p):
   r['left']+=1; continue
  try:
   subprocess.run([tool,'-P',str(p),'start-server'],env=env,cwd=home,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,timeout=max(1.0,deadline-time.monotonic()-1.5))
  except (OSError,subprocess.SubprocessError):
   pass
  for s in others:
   if s.startswith('emulator-') and s[9:].isdigit(): notify(p,b'host:emulator:%d'%(int(s[9:])+1))
   else: query(p,('host:connect:'+s).encode())
  seen=None
  end=min(deadline,time.monotonic()+3)
  while time.monotonic()<end:
   seen=query(p,b'host:devices')
   if seen is not None and set(others)<=set(serials(seen)): break
   time.sleep(0.2)
  now=serials(seen)
  if seen is None or any(usb(s) for s in now): r['left']+=1
  r['reconnected']+=sum(1 for s in others if s in now)
  r['missing']+=sum(1 for s in others if s not in now)
 print(json.dumps(r),flush=True)
SESSION=re.compile(r'A-[0-9]{1,12}\\.R-[0-9]{1,12}')
def emu_kind(a):
 n=os.path.basename(a)
 if n.startswith('qemu-system-'): return 'qemu'
 if n=='emulator' or (n.startswith('emulator64-') and n!='emulator64-crash-service'): return 'launcher'
def emu_port(argv):
 for i,a in enumerate(argv[:-1]):
  if a in ('-port','-ports'):
   v=argv[i+1].split(',')[0]
   if v.isdigit() and 0<int(v)<65536: return int(v)
def snapshot():
 # {pid: (start, argv, ppid)} of this account's processes (not this one);
 # None when the process table cannot be read.
 uid=os.getuid(); me=os.getpid(); out={}
 if sys.platform.startswith('linux'):
  for d in os.listdir('/proc'):
   if not d.isdigit() or int(d)==me: continue
   try:
    if os.stat('/proc/'+d).st_uid!=uid: continue
    with open('/proc/%s/cmdline'%d,'rb') as f: argv=[a.decode('utf-8','replace') for a in f.read(65536).split(b'\\0') if a]
    with open('/proc/%s/stat'%d,'rb') as f: x=f.read(4096).rsplit(b')',1)[1].split()
    if x[0]==b'Z': continue
    out[int(d)]=(x[19].decode(),argv,int(x[1]))
   except (OSError,IndexError,ValueError):
    continue
  return out
 try:
  o=subprocess.run(['/bin/ps','-ww','-U',str(uid),'-o','pid=,ppid=,lstart=,command='],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=3,text=True).stdout
 except (OSError,subprocess.SubprocessError):
  return None
 last=None
 for l in o.splitlines():
  x=l.split()
  if len(x)>=8 and x[0].isdigit() and x[1].isdigit():
   last=int(x[0])
   if last!=me: out[last]=(' '.join(x[2:7]),x[7:],int(x[1]))
  elif last in out:
   # An argument with a newline continues on the next line.
   out[last][1].extend(x)
 return out
def session_of(pid):
 try:
  with open('/proc/%d/environ'%pid,'rb') as f:
   for e in f.read(262144).split(b'\\0'):
    if e.startswith(b'CARDIGAN_RESOURCE_SESSION='):
     v=e[26:].decode('ascii','replace')
     if SESSION.fullmatch(v): return v
 except OSError:
  pass
def emu_procs(snap=None):
 snap=snapshot() if snap is None else snap
 if snap is None: return None
 return [(pid,v[0],v[1],session_of(pid),v[2]) for pid,v in sorted(snap.items()) if v[1] and emu_kind(v[1][0])]
def listeners(want):
 # {port: PIDs} of this account's processes listening on these ports, in one pass.
 uid=os.getuid(); want=set(want); out={}
 if not want: return out
 if sys.platform.startswith('linux'):
  inode={}
  for f in ('/proc/net/tcp','/proc/net/tcp6'):
   try:
    with open(f) as h: rows=h.read().splitlines()[1:]
   except OSError:
    continue
   for r in rows:
    x=r.split()
    try:
     if len(x)>9 and x[3]=='0A' and int(x[1].rsplit(':',1)[1],16) in want and int(x[7])==uid: inode['socket:[%s]'%x[9]]=int(x[1].rsplit(':',1)[1],16)
    except (ValueError,IndexError):
     pass
  if not inode: return out
  for d in os.listdir('/proc'):
   if not d.isdigit() or int(d)==os.getpid(): continue
   try:
    if os.stat('/proc/'+d).st_uid!=uid: continue
    for fd in os.listdir('/proc/%s/fd'%d):
     l=os.readlink('/proc/%s/fd/%s'%(d,fd))
     if l in inode: out.setdefault(inode[l],set()).add(int(d))
   except OSError:
    continue
  return out
 try:
  o=subprocess.run(['/usr/sbin/lsof','-nP','-a','-u',str(uid),'-iTCP','-sTCP:LISTEN','-Fpn'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=3,text=True).stdout
 except (OSError,subprocess.SubprocessError):
  return out
 pid=None
 for l in o.splitlines():
  if l[:1]=='p' and l[1:].isdigit(): pid=int(l[1:])
  elif l[:1]=='n' and pid is not None:
   v=l.rsplit(':',1)[-1]
   if v.isdigit() and int(v) in want: out.setdefault(int(v),set()).add(pid)
 return out
def str_list(v):
 return [x for x in v if isinstance(x,str) and SESSION.fullmatch(x)] if isinstance(v,list) else []
SESS=str_list([c.get('session')])
KEEP=set(str_list(c.get('keep_sessions')))-set(SESS)
def slot_procs():
 # C-848: this account's emulator and adb processes holding this slot: an
 # emulator on one of its console ports or naming the Run (Linux), and any
 # emulator or adb process listening on its ports. A process naming another
 # Run that still runs is never one of them, nor are the ports it holds.
 # ({pid: (start,kind,port,ppid)}, kept ports, snapshot)
 snap=snapshot()
 # No process table: no answer, so the host retries instead of a false release.
 if snap is None: sys.exit(0)
 found={}; kept=set(); keep_ports=set()
 for pid,(start,argv,ppid) in snap.items():
  k=emu_kind(argv[0]) if argv else None
  if not k: continue
  port=emu_port(argv); session=session_of(pid)
  if session in KEEP:
   kept.add(pid)
   if port is not None: keep_ports.update((port,port+1))
   continue
  if (port is not None and port in emu) or (session is not None and session in SESS):
   found[pid]=(start,k,port,ppid)
 for p,pids in listeners(ports).items():
  for pid in pids:
   if pid in kept:
    keep_ports.add(p); continue
   if pid in found or pid not in snap or not snap[pid][1]: continue
   start,argv,ppid=snap[pid]
   if session_of(pid) in KEEP:
    keep_ports.add(p); continue
   k=emu_kind(argv[0]) or ('adb' if os.path.basename(argv[0])=='adb' else None)
   if k: found[pid]=(start,k,p,ppid)
 for pid in [pid for pid in found if found[pid][2] in keep_ports]: found.pop(pid)
 return found,keep_ports,snap
def occupied(procs):
 # Listening ports (a running Run's too: the slot is not free while it is
 # held) plus processes of the slot the port check missed.
 busy={p for p in ports if up(p)}|{v[2] for v in procs.values() if v[2] in ports}
 return len(busy)+sum(1 for v in procs.values() if v[2] not in ports)
def alive(pid):
 if sys.platform.startswith('linux'):
  try:
   with open('/proc/%d/stat'%pid,'rb') as f: return f.read(4096).rsplit(b')',1)[1].split()[0]!=b'Z'
  except (OSError,IndexError):
   return False
 try:
  os.kill(pid,0); return True
 except ProcessLookupError:
  return False
 except OSError:
  return True
def emulators():
 found=emu_procs()
 if found is None:
  return
 rows=[[p,s,emu_kind(a[0]),emu_port(a),n,pp] for p,s,a,n,pp in found][:16]
 print(json.dumps(dict(generation=c.get('generation'),found=len(rows),left=0,emulators=rows)),flush=True)
def emulator_stop():
 want=set()
 for x in c.get('pids',[]):
  if isinstance(x,list) and len(x)==2 and isinstance(x[0],int) and isinstance(x[1],str): want.add((x[0],x[1]))
 def live():
  f=emu_procs()
  return None if f is None else [p for p,s,a,n,pp in f if (p,s) in want]
 hit=live()
 if hit is None: return
 left=hit
 for sig,wait in ((signal.SIGTERM,5.0),(signal.SIGKILL,2.0)):
  for p in left:
   try:
    os.kill(p,sig)
   except OSError:
    pass
  end=time.monotonic()+wait
  while True:
   now=live()
   left=left if now is None else now
   if not left or time.monotonic()>=end: break
   time.sleep(0.2)
  if not left: break
 print(json.dumps(dict(generation=c.get('generation'),found=len(hit),left=len(left))),flush=True)
if c.get('action')=='usb_off':
 usb_off(); sys.exit(0)
if c.get('action') in ('emulators','emulator_stop'):
 (emulators if c['action']=='emulators' else emulator_stop)(); sys.exit(0)
# C-848: the whole pass ends well inside the host's 10 s call limit, so what
# was found and stopped is always reported.
t0=time.monotonic(); deadline=t0+7.5
procs,keep,snap=slot_procs()
found=occupied(procs)
left=found
signalled=[]
if c.get('action')=='release' and found:
 for p in emu:
  if p not in keep and up(p): emu_kill(p)
 for p in adb:
  if p not in keep and up(p): adb_kill(p)
 free=[p for p in ports if p not in keep]
 end=min(t0+3.0,deadline-3.5)
 while (any(up(p) for p in free) or any(alive(pid) for pid in procs)) and time.monotonic()<end: time.sleep(0.2)
 # What the console and adb protocol did not close (no answer under load, a
 # token in another HOME, an emulator off its console) is stopped by PID,
 # only while it still has the start stamp it was found with.
 more,keep2,snap=slot_procs()
 keep|=keep2
 rest={pid:v for pid,v in procs.items() if pid in snap and snap[pid][0]==v[0] and v[2] not in keep}
 rest.update(more)
 procs.update(more)
 for sig,wait in ((signal.SIGTERM,2.0),(signal.SIGKILL,1.0)):
  if not rest: break
  for pid in rest:
   try:
    os.kill(pid,sig)
   except OSError:
    pass
   if pid not in signalled: signalled.append(pid)
  end=min(deadline,time.monotonic()+wait)
  while rest and time.monotonic()<end:
   time.sleep(0.1)
   rest={pid:v for pid,v in rest.items() if alive(pid)}
 end=min(deadline,time.monotonic()+1.0)
 while any(up(p) for p in ports if p not in keep) and time.monotonic()<end: time.sleep(0.1)
 left=occupied(slot_procs()[0])
rows=[[pid,procs[pid][1],procs[pid][2],procs[pid][3],pid in signalled] for pid in sorted(procs)][:16]
print(json.dumps({'generation':c.get('generation'),'found':found,'left':left,'processes':rows}),flush=True)
`;

export type AdbProbeContext = {
  /** C-833 `usb_off`: restart this account's servers on `adb_ports` that hold USB devices with `ADB_USB=0`. */
  /**
   * C-844 `emulators`: list this account's emulator processes (the `emulator`
   * launcher and `qemu-system-*`); `emulator_stop`: stop `pids` (pid and
   * start stamp from that list, so a reused PID is never signalled) with
   * SIGTERM, then SIGKILL. `found`/`left` count the matched and the remaining.
   */
  action: "check" | "release" | "usb_off" | "emulators" | "emulator_stop";
  project: string;
  machine: string;
  generation?: string;
  adb_ports: readonly number[];
  emulator_ports: readonly number[];
  pids?: readonly (readonly [number, string])[];
  /**
   * C-848 `check` / `release` of a Run's slot: its `<Assignment>.<Run>`, so
   * an emulator naming the Run (Linux) is closed even off the slot's ports.
   */
  session?: string;
  /** C-848: Runs still running on the machine; their processes and ports are never touched. */
  keep_sessions?: readonly string[];
};
/** C-848: a process of the slot the check or release found (at most 16). */
export type SlotProcess = {
  readonly pid: number;
  readonly kind: "qemu" | "launcher" | "adb";
  /** Its console port (emulators) or the slot port it listens on. */
  readonly port?: number;
  /** Parent PID; 1 means it was left to launchd / init. */
  readonly ppid?: number;
  /** Stopped by signal because the console or adb protocol did not close it. */
  readonly signalled: boolean;
};
/** C-844: one emulator process of the project account on the worker. */
export type EmulatorProcess = {
  readonly pid: number;
  /** Process start stamp (Linux: clock ticks since boot; macOS: `ps lstart`). */
  readonly started: string;
  readonly kind: "qemu" | "launcher";
  /** Console port from `-port` / `-ports`, when given. */
  readonly port?: number;
  /** `CARDIGAN_RESOURCE_SESSION` (`<Assignment>.<Run>`) in its environment (Linux). */
  readonly session?: string;
  /** C-848: parent PID. */
  readonly ppid?: number;
};
export type AdbProbeResult = {
  target: string;
  found: number;
  left: number;
  /** usb_off: servers holding USB devices that another account runs. */
  foreign?: number;
  /** usb_off: emulator and network connections back on the restarted servers. */
  reconnected?: number;
  missing?: number;
  /** emulators: the processes found. */
  emulators?: readonly EmulatorProcess[];
  /** check / release: the slot's processes found. */
  processes?: readonly SlotProcess[];
};
/** Undefined means the target or its answer could not be established. */
export type AdbProbe = (
  context: AdbProbeContext,
  expectedTarget?: string,
) => Promise<AdbProbeResult | undefined>;

/** Run host-owned Python on the actual target as the project account. */
export async function runOnTarget(
  config: ExecutionConfig,
  args: readonly string[],
): Promise<string> {
  const argv = ["/usr/bin/python3", ...args];
  const cmd =
    config.mode === "agent-ssh"
      ? await agentProcessCommand(config, argv)
      : { file: "/usr/bin/python3", args: argv.slice(1) };
  const { stdout } = await promisify(execFile)(cmd.file, cmd.args, {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 4096,
  });
  return stdout;
}

const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

const SESSION = /^A-[0-9]{1,12}\.R-[0-9]{1,12}$/u;
const pid = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
const port = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 65535
    ? v
    : undefined;
function slotProcesses(value: unknown): SlotProcess[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const rows: SlotProcess[] = [];
  for (const v of value) {
    if (!Array.isArray(v) || v.length !== 5) return undefined;
    const [id, kind, p, parent, signalled] = v as unknown[];
    if (
      pid(id) === undefined ||
      (kind !== "qemu" && kind !== "launcher" && kind !== "adb") ||
      (p !== null && port(p) === undefined) ||
      (parent !== null &&
        (typeof parent !== "number" ||
          !Number.isSafeInteger(parent) ||
          parent < 0)) ||
      typeof signalled !== "boolean"
    )
      return undefined;
    rows.push({
      pid: id as number,
      kind,
      ...(p === null ? {} : { port: p as number }),
      ...(parent === null ? {} : { ppid: parent as number }),
      signalled,
    });
  }
  return rows;
}
function emulatorRows(value: unknown): EmulatorProcess[] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const rows: EmulatorProcess[] = [];
  for (const v of value) {
    if (!Array.isArray(v) || v.length !== 6) return undefined;
    const [pid, started, kind, port, session, ppid] = v as unknown[];
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof started !== "string" ||
      !/^[A-Za-z0-9: ]{1,40}$/u.test(started) ||
      (kind !== "qemu" && kind !== "launcher") ||
      (port !== null &&
        (typeof port !== "number" ||
          !Number.isSafeInteger(port) ||
          port <= 0 ||
          port > 65535)) ||
      (session !== null &&
        (typeof session !== "string" || !SESSION.test(session))) ||
      (ppid !== null &&
        (typeof ppid !== "number" || !Number.isSafeInteger(ppid) || ppid < 0))
    )
      return undefined;
    rows.push({
      pid,
      started,
      kind,
      ...(port === null ? {} : { port }),
      ...(session === null ? {} : { session }),
      ...(ppid === null ? {} : { ppid }),
    });
  }
  return rows;
}

export function adbTargetProbe(
  resolve: (
    context: { project: string; machine: string },
    expectedTarget?: string,
  ) => Promise<{ config: ExecutionConfig; target: string } | undefined>,
  run: typeof runOnTarget = runOnTarget,
): AdbProbe {
  return async (context, expectedTarget) => {
    try {
      const resolved = await resolve(context, expectedTarget);
      if (!resolved) return undefined;
      const stdout = await run(resolved.config, [
        "-I",
        "-B",
        "-c",
        ADB_SLOT_SCRIPT,
        JSON.stringify(context),
      ]);
      const row = JSON.parse(stdout.trim()) as Record<string, unknown>;
      const found = count(row.found),
        left = count(row.left);
      if (found === undefined || left === undefined) return undefined;
      if (context.action !== "check" && row.generation !== context.generation)
        return undefined;
      if (context.action === "emulators") {
        const emulators = emulatorRows(row.emulators);
        return emulators
          ? { target: resolved.target, found, left, emulators }
          : undefined;
      }
      if (context.action === "check" || context.action === "release") {
        const processes = slotProcesses(row.processes);
        if (!processes) return undefined;
        return {
          target: resolved.target,
          found,
          left,
          ...(processes.length ? { processes } : {}),
        };
      }
      if (context.action !== "usb_off")
        return { target: resolved.target, found, left };
      const foreign = count(row.foreign),
        reconnected = count(row.reconnected),
        missing = count(row.missing);
      if (
        foreign === undefined ||
        reconnected === undefined ||
        missing === undefined
      )
        return undefined;
      return {
        target: resolved.target,
        found,
        left,
        foreign,
        reconnected,
        missing,
      };
    } catch {
      return undefined;
    }
  };
}
