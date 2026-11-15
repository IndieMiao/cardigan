import { type ChildProcessByStdio, spawn } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  AGENT_PATH,
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";
import { CHECKOUT_LIMITS } from "./checkout-limits.js";

/** Read-only target proof. No signals, lock creation/deletion, recursive cleanup or caller script. */
export const CHECK_TARGET_IDLE = String.raw`
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const [root, lockRoot, slots, aliases, isolated] = process.argv.slice(1);
const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
function directory(p) {
  const s = fs.lstatSync(p);
  if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(p) !== p) throw Error();
  return s;
}
function entries(p) {
  try { directory(p); return fs.readdirSync(p); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
directory(root); directory(lockRoot);
if (isolated === 'yes' && (directory(lockRoot).mode & 0o022 || directory(lockRoot).uid === process.getuid())) throw Error();
const held = [];
for (let i = 0; i < Number(slots); i++) {
  const p = path.join(lockRoot, i === 0 ? 'merge-check.lock' : 'merge-check-' + i + '.lock');
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const s = fs.fstatSync(fd);
  if (!s.isFile() || s.nlink !== 1 || s.size !== 0 || (isolated === 'yes' && s.uid !== 0)) throw Error();
  execFileSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore','ignore','ignore',fd], env });
  held.push(fd);
}
for (const project of entries(path.join(root, 'checks'))) {
  if (entries(path.join(root, 'checks', project)).length) throw Error();
}
if (entries(aliases).length) throw Error();
for (const project of entries(path.join(root, 'repos'))) {
  const repo = path.join(root, 'repos', project);
  directory(repo);
  const out = execFileSync('git', ['-c','core.hooksPath=/dev/null','-C',repo,'worktree','list','--porcelain'], { env, encoding:'utf8', timeout:${CHECKOUT_LIMITS.remoteCommandMs}, maxBuffer:1048576 });
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ') && (line.includes('/checks/') || line.includes('/s/'))) throw Error();
  }
}
const files = require('node:fs/promises');
async function bounded(work) {
  let timer;
  try { return await Promise.race([work,new Promise((_,reject) => { timer=setTimeout(() => reject(Error()),${CHECKOUT_LIMITS.procReadMs}); })]); }
  finally { clearTimeout(timer); }
}
async function identity(proc) {
  const text = await bounded(files.readFile(proc + '/stat','utf8'));
  const fields = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? '')) throw Error();
  return {start:fields[19],state:fields[0]};
}
async function account(proc) {
  const text = await bounded(files.readFile(proc + '/status','utf8'));
  const uids = text.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);
  if (!uids) throw Error();
  return uids.slice(1).some(uid => Number(uid) === process.getuid());
}
const roots = [path.join(root,'checks'),aliases];
function occupied(target) {
  const name = target.endsWith(' (deleted)') ? target.slice(0,-10) : target;
  return roots.some(base => name === base || name.startsWith(base + '/'));
}
async function inspect() {
  // A free flock and absent directories do not prove exit: threads can retain deleted cwd/fds.
  for (const pid of (await bounded(files.readdir('/proc'))).filter(p => /^[1-9]\d*$/.test(p))) {
    const proc = '/proc/' + pid;
    let tids;
    try {
      if (!await account(proc)) continue;
      tids = (await bounded(files.readdir(proc + '/task'))).filter(t => /^[1-9]\d*$/.test(t));
    } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') continue; throw e; }
    for (const tid of tids) {
      if (Number(tid) === process.pid) continue;
      const task = proc + '/task/' + tid;
      let before;
      try {
        before = await identity(task);
        if (['Z','X'].includes(before.state)) continue;
        const names = await bounded(files.readdir(task + '/fd'));
        for (const link of [task + '/cwd',...names.map(n => task + '/fd/' + n)]) {
          try { if (occupied(await bounded(files.readlink(link)))) throw Error(); }
          catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        }
        if ((await identity(task)).start !== before.start) throw Error();
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ESRCH') {
          try { const now=await identity(task); if (['Z','X'].includes(now.state) || before && now.start !== before.start) continue; }
          catch (gone) { if (gone.code === 'ENOENT' || gone.code === 'ESRCH') continue; }
        }
        throw e;
      }
    }
  }
}
inspect().then(() => process.stdout.write('target-idle\n',() => process.exit(0))).catch(() => process.exit(1));
`;

/** Probe every original slot AND leftover checkout/alias/registry; unknown is never idle. */
export async function checkTargetIdle(
  execution: ExecutionConfig,
  slots: number,
  start: (
    file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "ignore"] },
  ) => ChildProcessByStdio<null, Readable, null> = (file, args, options) =>
    spawn(file, args, options),
): Promise<void> {
  if (!Number.isSafeInteger(slots) || slots < 1)
    throw new Error("Invalid trusted slot count");
  const root =
    execution.mode === "local"
      ? join(execution.dataDir, "agent")
      : execution.agentRoot;
  const lockRoot =
    execution.mode === "local" ? execution.dataDir : execution.agentRoot;
  const aliases = join(
    execution.mode === "local" ? execution.dataDir : execution.agentRoot,
    "s",
  );
  const argv = [
    execution.mode === "local" ? process.execPath : "node",
    "-e",
    CHECK_TARGET_IDLE,
    "--",
    root,
    lockRoot,
    String(slots),
    aliases,
    execution.mode === "agent-ssh" && execution.host !== undefined
      ? "yes"
      : "no",
  ];
  const command =
    execution.mode === "agent-ssh"
      ? await agentProcessCommand(execution, argv)
      : { file: process.execPath, args: argv.slice(1) };
  await new Promise<void>((resolve, reject) => {
    const child = start(command.file, command.args, {
      env: {
        PATH:
          execution.mode === "local"
            ? "/usr/local/bin:/usr/bin:/bin"
            : AGENT_PATH,
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      reject(new Error("检查目标状态未知，保留围栏"));
    }, CHECKOUT_LIMITS.remoteCommandMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output = (output + chunk).slice(-128);
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("检查目标状态未知，保留围栏"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && output === "target-idle\n") resolve();
      else reject(new Error("检查目标占用或清理未确认，保留围栏"));
    });
  });
}
