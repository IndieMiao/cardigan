import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  AGENT_PATH,
  type AgentExecution,
  agentProcessCommand,
} from "@cardigan/runtime-herdr";
import {
  CHECKOUT_HANDSHAKE_TITLE,
  CHECKOUT_LIMITS,
} from "./checkout-limits.js";

/** Fixed Linux operation. No caller-supplied PID, signal, path or shell code. */
export const CHECKOUT_ORPHAN_SWEEP = String.raw`
const fs = require('node:fs');
const { userInfo } = require('node:os');
const { basename } = require('node:path');
const { execFileSync } = require('node:child_process');
const account = userInfo();
if (account.username !== 'agent' || account.uid === 0 || account.uid !== process.getuid()) process.exit(1);
const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 }));
if (!Number.isSafeInteger(hz) || hz <= 0) process.exit(1);
function identity(pid) {
  try {
    const dir = '/proc/' + pid;
    if (fs.lstatSync(dir).uid !== account.uid) return;
    const uids = fs.readFileSync(dir + '/status', 'utf8').match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);
    if (!uids || uids.slice(1).some(uid => Number(uid) !== account.uid)) return;
    if (!['node', 'nodejs'].includes(basename(fs.readlinkSync(dir + '/exe')))) return;
    if (fs.readFileSync(dir + '/cmdline', 'utf8').replace(/\0+$/, '') !== '${CHECKOUT_HANDSHAKE_TITLE}') return;
    const stat = fs.readFileSync(dir + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    if (['Z', 'X'].includes(fields[0]) || !/^\d+$/.test(fields[19])) return;
    const uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    if (!Number.isFinite(uptime) || uptime - Number(fields[19]) / hz < ${CHECKOUT_LIMITS.orphanAgeMs / 1000}) return;
    return fields[19];
  } catch { return; }
}
async function sweep() {
  const found = fs.readdirSync('/proc').filter(pid => /^[1-9]\d*$/.test(pid))
    .map(pid => ({ pid: Number(pid), start: identity(pid) })).filter(r => r.start !== undefined);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const record of found) {
      // Recheck account, exact handshake command and incarnation before EACH signal.
      if (identity(record.pid) !== record.start) continue;
      let outcome = 'sent';
      try { process.kill(record.pid, signal); } catch { outcome = 'failed'; }
      process.stdout.write('orphan ' + record.pid + ' ' + record.start + ' ' + signal + ' ' + outcome + '\n');
    }
    if (signal === 'SIGTERM' && found.length) await new Promise(r => setTimeout(r, ${CHECKOUT_LIMITS.killGraceMs}));
  }
  process.stdout.write('sweep-complete\n');
}
sweep().catch(() => { process.exitCode = 1; });
`;

/** Only marked, over-age handshake workers owned by agent are eligible. */
export async function sweepCheckoutOrphans(
  execution: AgentExecution,
  audit: (record: string) => void,
  start: (
    file: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams = (file, args, env) =>
    spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] }),
): Promise<void> {
  if ((execution.user ?? "agent") !== "agent") return;
  const command = await agentProcessCommand(execution, [
    "node",
    "-e",
    CHECKOUT_ORPHAN_SWEEP,
  ]);
  await new Promise<void>((resolve, reject) => {
    const child = start(command.file, command.args, { PATH: AGENT_PATH });
    let complete = false,
      closed = false;
    const lines = createInterface({ input: child.stdout });
    const finish = (ok: boolean) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      lines.close();
      if (ok) resolve();
      else reject(new Error("远程检查孤儿巡检失败，将在下轮重试"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(false);
    }, CHECKOUT_LIMITS.remoteCommandMs);
    lines.on("line", (line) => {
      if (closed) return;
      // Never log remote command lines, environments, SSH diagnostics or arbitrary output.
      if (/^orphan [1-9]\d* \d+ SIG(?:TERM|KILL) (?:sent|failed)$/u.test(line))
        audit(line);
      if (line === "sweep-complete") complete = true;
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0 && complete));
  });
}
