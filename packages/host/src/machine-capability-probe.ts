import { spawn } from "node:child_process";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";

import {
  type CapabilityCommand,
  CHROMIUM_SEARCH_SCRIPT,
} from "./chromium-search.js";

export type { CapabilityCommand } from "./chromium-search.js";

export interface CapabilityProbeResult {
  readonly ok: boolean;
  readonly output: string;
  readonly attempted?: number;
  readonly incomplete?: boolean;
}
export type CapabilityProbe = (
  execution: ExecutionConfig,
  os: string,
  command: CapabilityCommand,
  signal?: AbortSignal,
) => Promise<CapabilityProbeResult>;
export const CAPABILITY_PROBE_TIMEOUT_MS = 10_000;

// The controller supplies argv, never a project script. Bound time/output on the
// worker as well as the controller; restore HOME for account-scoped CLI auth.
export const CAPABILITY_PROBE_SCRIPT = `
import json, os, pwd, selectors, signal, subprocess, sys, time
class ProbeCancelled(Exception): pass
def interrupted(*args): raise ProbeCancelled()
for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGALRM): signal.signal(sig, interrupted)

def run_command(argv, env, deadline):
    p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=env['HOME'], start_new_session=True)
    try:
        output = bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(p.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise TimeoutError()
                for key, _ in selector.select(remaining):
                    chunk = os.read(key.fd, 4096)
                    if not chunk: selector.unregister(key.fd)
                    else: output.extend(chunk)
                    if len(output) > 16384: raise ValueError()
        try: code = p.wait(timeout=max(0.001, deadline-time.monotonic()))
        except subprocess.TimeoutExpired: raise TimeoutError()
        return output.decode('utf-8', errors='replace') if code == 0 else None
    finally:
        try: os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        p.stdout.close()
        p.wait()
${CHROMIUM_SEARCH_SCRIPT}
try:
    request = json.loads(sys.argv[1])
    if sys.platform != request['os']: raise ValueError()
    account = pwd.getpwuid(os.getuid())
    env = dict(PATH=os.environ.get('PATH', '/usr/bin:/bin'), HOME=account.pw_dir, USER=account.pw_name, LOGNAME=account.pw_name, LC_ALL='C')
    timeout = request['timeout_ms'] / 1000
    deadline = time.monotonic() + timeout
    if isinstance(request['argv'], dict):
        os.chdir(account.pw_dir)  # Resolve relative PATH entries in the Run account's cwd.
        signal.setitimer(signal.ITIMER_REAL, timeout)
        result = search_browser(request['argv'], env, deadline)
    else:
        banner = run_command(request['argv'], env, deadline)
        result = dict(ok=banner is not None, output=banner or '')
except Exception:
    result = dict(ok=False, output='')
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
print(json.dumps(result))
`;
export const probeMachineCapability: CapabilityProbe = async (
  execution,
  os,
  argv,
  signal,
) => {
  try {
    signal?.throwIfAborted();
    const args = [
      execution.mode === "agent-ssh"
        ? (execution.fileHelper?.python ?? "python3")
        : "python3",
      "-I",
      "-B",
      "-c",
      CAPABILITY_PROBE_SCRIPT,
      JSON.stringify({ os, argv, timeout_ms: CAPABILITY_PROBE_TIMEOUT_MS }),
    ];
    const command =
      execution.mode === "agent-ssh"
        ? await agentProcessCommand(execution, args)
        : { file: args[0] as string, args: args.slice(1) };
    return await new Promise<CapabilityProbeResult>((resolve) => {
      const child = spawn(command.file, command.args, {
        env: {
          PATH:
            execution.mode === "agent-ssh"
              ? "/usr/bin:/bin"
              : (process.env.PATH ?? "/usr/bin:/bin"),
        },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: CAPABILITY_PROBE_TIMEOUT_MS + 15_000,
        killSignal: "SIGTERM",
        ...(signal ? { signal } : {}),
      });
      let output = "",
        overflow = false,
        failed = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (output.length + chunk.length > 100_000) {
          overflow = true;
          child.kill("SIGTERM");
        } else output += chunk.toString("utf8");
      });
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code) => {
        try {
          const value = JSON.parse(output);
          resolve({
            ok:
              !overflow &&
              !failed &&
              code === 0 &&
              value.ok === true &&
              typeof value.output === "string",
            output: typeof value.output === "string" ? value.output : "",
            ...(!overflow &&
            !failed &&
            code === 0 &&
            "scopes" in argv &&
            Number.isSafeInteger(value.attempted) &&
            value.attempted >= 0 &&
            value.attempted <= argv.scopes.length
              ? {
                  attempted: value.attempted as number,
                  incomplete:
                    value.incomplete !== false ||
                    value.attempted !== argv.scopes.length,
                }
              : {}),
          });
        } catch {
          resolve({ ok: false, output: "" });
        }
      });
    });
  } catch {
    return { ok: false, output: "" };
  }
};
