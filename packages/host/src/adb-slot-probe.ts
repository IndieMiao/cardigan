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
 * the account's console token). No PID is read from disk or signalled.
 *
 * argv[1] is the JSON context. `check` reports how many of the slot's ports
 * are listening; `release` closes them and reports what is left.
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
export const ADB_SLOT_SCRIPT = `import json,os,pwd,shutil,socket,subprocess,sys,time
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
  s.sendall(b'kill\\r\\n'); read_ok(s)
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
  s.sendall(b'0009host:kill'); s.recv(4)
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
if c.get('action')=='usb_off':
 usb_off(); sys.exit(0)
found=sum(1 for p in ports if up(p))
if c.get('action')=='release' and found:
 for p in emu:
  if up(p): emu_kill(p)
 for p in adb:
  if up(p): adb_kill(p)
 end=time.monotonic()+float(c.get('wait',4))
 while any(up(p) for p in ports) and time.monotonic()<end: time.sleep(0.2)
left=sum(1 for p in ports if up(p))
print(json.dumps({'generation':c.get('generation'),'found':found,'left':left}),flush=True)
`;

export type AdbProbeContext = {
  /** C-833 `usb_off`: restart this account's servers on `adb_ports` that hold USB devices with `ADB_USB=0`. */
  action: "check" | "release" | "usb_off";
  project: string;
  machine: string;
  generation?: string;
  adb_ports: readonly number[];
  emulator_ports: readonly number[];
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
