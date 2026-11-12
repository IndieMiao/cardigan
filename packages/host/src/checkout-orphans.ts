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
import { CHECKOUT_PROCESSES } from "./checkout-processes.js";

/** Fixed Linux operation. No caller-supplied PID, signal, path or shell code. */
export const CHECKOUT_ORPHAN_SWEEP = String.raw`
const { userInfo } = require('node:os');
const { execFileSync } = require('node:child_process');
${CHECKOUT_PROCESSES}
const account = userInfo();
if (account.username !== 'agent' || account.uid === 0 || account.uid !== process.getuid()) process.exit(1);
const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 }));
if (!Number.isSafeInteger(hz) || hz <= 0) process.exit(1);
const hardDeadline = setTimeout(() => process.exit(124), ${CHECKOUT_LIMITS.remoteCommandMs});
const checksRoot = process.argv[1] + '/checks/';
async function identity(pid) {
  try {
    const record = await procIdentity(pid);
    if (!record || record.comm !== '${CHECKOUT_HANDSHAKE_TITLE}') return;
    const cwd = await procCwd(pid);
    if (!cwd.startsWith(checksRoot) || !/^[A-Za-z0-9_][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(cwd.slice(checksRoot.length))) return;
    const uptime = Number((await boundedRead(procFiles.readFile('/proc/uptime', 'utf8'))).split(' ')[0]);
    if (!Number.isFinite(uptime) || uptime - Number(record.start) / hz < ${CHECKOUT_LIMITS.orphanAgeMs / 1000}) return;
    return { ...record, cwd };
  } catch { return; }
}
async function sweep() {
  const found = (await Promise.all((await procPids()).map(identity))).filter(Boolean);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const record of found) {
      // Recheck account, handshake comm, container cwd and incarnation before EACH signal.
      const current = await identity(record.pid);
      if (!current || current.start !== record.start || current.cwd !== record.cwd) continue;
      let outcome = 'sent';
      try { process.kill(record.pid, signal); } catch { outcome = 'failed'; }
      process.stdout.write('orphan ' + record.pid + ' ' + record.start + ' ' + signal + ' ' + outcome + '\n');
    }
    if (signal === 'SIGTERM' && found.length) await new Promise(r => setTimeout(r, ${CHECKOUT_LIMITS.killGraceMs}));
  }
  if (found.length) await new Promise(r => setTimeout(r, ${CHECKOUT_LIMITS.childExitMs}));
  for (const record of found) {
    const current = await identity(record.pid);
    if (!current || current.start !== record.start || current.cwd !== record.cwd) continue;
    const wchan = await procWait(record.pid);
    process.stdout.write('manual ' + record.cwd.slice(checksRoot.length) + ' ' + record.pid + ' ' + record.start + ' ' + current.state + ' ' + wchan + '\n');
    await markManualAttention(record.cwd, [{ pid: record.pid, start: record.start, state: current.state, wchan }]);
  }
  process.stdout.write('sweep-complete\n');
}
sweep().catch(() => { process.exitCode = 1; }).finally(() => {
  clearTimeout(hardDeadline);
  // A timed-out /proc read must not keep this diagnostic process alive.
  process.exit(process.exitCode ?? 0);
});
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
    "--",
    execution.agentRoot,
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
      if (
        /^manual [A-Za-z0-9_][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9_-]{0,79} [1-9]\d* \d+ [A-Z] [A-Za-z0-9_]{1,80}$/u.test(
          line,
        )
      )
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
