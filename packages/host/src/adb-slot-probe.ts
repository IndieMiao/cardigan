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
 */
export const ADB_SLOT_SCRIPT = `import json,os,pwd,socket,sys,time
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
  action: "check" | "release";
  project: string;
  machine: string;
  generation?: string;
  adb_ports: readonly number[];
  emulator_ports: readonly number[];
};
export type AdbProbeResult = { target: string; found: number; left: number };
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
      if (context.action === "release" && row.generation !== context.generation)
        return undefined;
      return { target: resolved.target, found, left };
    } catch {
      return undefined;
    }
  };
}
