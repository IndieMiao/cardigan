import {
  CHECKOUT_HANDSHAKE_TITLE,
  CHECKOUT_LIMITS,
} from "./checkout-limits.js";
import { CHECKOUT_PROCESSES } from "./checkout-processes.js";

/** Trusted supervisor executed as the checkout owner, never from the checked-out tree. */
export const CHECKOUT_WORKER = String.raw`
process.title = '${CHECKOUT_HANDSHAKE_TITLE}';
const handshakeDeadline = setTimeout(() => process.exit(124), ${CHECKOUT_LIMITS.handshakeMs});
process.chdir(process.argv[1]);
const { spawn } = require('node:child_process');
const { createHmac } = require('node:crypto');
const { chmod, lstat, mkdir, realpath, rm, symlink } = require('node:fs/promises');
const { userInfo } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { createInterface } = require('node:readline');
${CHECKOUT_PROCESSES}
const input = createInterface({ input: process.stdin });
let cancelled = false, current, deadline, totalExpired = false, nonce, authKey;
// A same-uid check can read the pipe too. Never expose the independent authentication key,
// including in the final result: learning the returned nonce must not permit re-signing it.
const emit = value => process.stdout.write(JSON.stringify({ ...value,
  auth: createHmac('sha256', authKey).update(JSON.stringify(value)).digest('hex') }) + '\n');
const cancel = () => {
  if (authKey === undefined) process.exit(124);
  cancelled = true; current?.('interrupted');
};
input.on('close', cancel);
process.on('SIGTERM', cancel);
process.on('SIGINT', cancel);
process.on('SIGHUP', cancel);
process.stdout.on('error', cancel);
input.once('line', line => {
  clearTimeout(handshakeDeadline);
  process.title = 'cg-check-run';
  input.on('line', cancel);
  const payload = JSON.parse(line);
  nonce = payload.nonce;
  authKey = payload.auth_key;
  emit({ type: 'ready' });
  main(payload).catch(() => { process.exitCode = 1; }).finally(() => {
    clearTimeout(deadline);
    input.close();
    process.stdin.destroy();
  });
});
async function main(p) {
  const checks = [], cleanup_errors = [], groups = new Set(), unconfirmed = new Set();
  let manual_attention = false;
  const runtime = join(p.container, 'runtime'), temporary = join(p.container, 'tmp');
  const aliases = join(p.alias_container, 'u'), aliasRuntime = join(aliases, 'r'), aliasTmp = join(aliases, 't');
  let ownsAliases = false, registered = false, addInterrupted = false;
  const baseEnv = { PATH: p.path, HOME: userInfo().homedir, XDG_RUNTIME_DIR: aliasRuntime, TMPDIR: aliasTmp };
  Object.assign(process.env, baseEnv);
  const environment = { ...baseEnv, ...p.env };
  const gitEnv = { ...baseEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  const safety = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
    '-c', 'safe.directory=' + p.repository, '-c', 'safe.directory=' + p.directory];
  let status = 'passed', reason;
  deadline = setTimeout(() => { totalExpired = true; current?.('timed_out'); }, p.totalTimeoutMs);
  function run(file, args, env, cwd, timeout, name, cleanup = false) {
    if (!cleanup && (cancelled || totalExpired))
      return Promise.resolve({ code: null, status: cancelled ? 'interrupted' : 'timed_out', output: '' });
    return new Promise(resolve => {
      const started = Date.now();
      const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.pid) groups.add(child.pid);
      let result = 'passed', output = '', hardStop, exitDeadline, finished = false;
      const kill = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch {} };
      const finish = (code, forced = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); clearTimeout(hardStop); clearTimeout(exitDeadline);
        if (!cleanup) current = undefined;
        if (forced) {
          if (child.pid) unconfirmed.add(child.pid);
          child.stdout.destroy(); child.stderr.destroy(); child.unref();
          if (result === 'passed') result = 'failed';
        }
        resolve({ code, status: result === 'passed' && code !== 0 ? 'failed' : result,
          duration_ms: Date.now() - started, output });
      };
      const boundExit = () => {
        if (!exitDeadline) exitDeadline = setTimeout(() => finish(null, true), ${CHECKOUT_LIMITS.childExitMs});
      };
      const stop = value => {
        if (finished || result !== 'passed') return;
        result = value;
        kill('SIGTERM');
        hardStop = setTimeout(() => { kill('SIGKILL'); boundExit(); }, ${CHECKOUT_LIMITS.killGraceMs});
      };
      if (!cleanup) current = stop;
      const timer = setTimeout(() => stop('timed_out'), timeout);
      if (name) emit({ type: 'started', name, pid: child.pid });
      for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', data => {
        if (finished) return;
        if (name) emit({ type: 'output', name, text: data });
        else output = (output + data.toString()).slice(-65536);
      });
      child.once('error', () => { result = 'failed'; finish(null); });
      // A completed shell must not leave background children in its process group.
      child.once('exit', () => { if (!finished) { kill('SIGKILL'); boundExit(); } });
      child.once('close', code => finish(code));
    });
  }
  const git = (cwd, args, cleanup = false) =>
    run('git', [...safety, '-C', cwd, ...args], gitEnv, '/', 30000, undefined, cleanup);
  async function stillRegistered() {
    const list = await git(p.repository, ['worktree', 'list', '--porcelain'], true);
    if (list.status !== 'passed') return true;
    const paths = [p.directory];
    try { paths.push(join(await realpath(dirname(p.directory)), basename(p.directory))); } catch {}
    return list.output.split('\n').some(line => paths.some(path => line === 'worktree ' + path));
  }
  async function verify() {
    const head = await git(p.directory, ['rev-parse', '--verify', 'HEAD']);
    const tree = await git(p.directory, ['rev-parse', '--verify', 'HEAD^{tree}']);
    const dirty = await git(p.directory, ['status', '--porcelain=v1', '--untracked-files=no']);
    return [head, tree, dirty].every(r => r.status === 'passed') &&
      head.output.trim() === p.sha && tree.output.trim() === p.tree && dirty.output.trim() === '';
  }
  async function coreRecord(pid) {
    try {
      const identity = await procIdentity(pid);
      // The dedicated attempt cwd identifies the runtime without address-space reads.
      if (!identity || identity.state === 'D' || identity.comm !== 'herdr-core') return;
      const path = await procCwd(pid);
      if (path !== p.container && !path.startsWith(p.container + '/')) return;
      return { pid, start: identity.start };
    } catch { return; }
  }
  async function cores() {
    const entries = await procPids();
    return (await Promise.all(entries.filter(v => /^[1-9][0-9]*$/.test(v)).map(v => coreRecord(Number(v))))).filter(Boolean);
  }
  async function remainingProcesses() {
    if (process.platform !== 'linux') return [];
    const remaining = await Promise.all((await procPids()).map(async pid => {
      if (Number(pid) === process.pid) return;
      try {
        const record = await procIdentity(pid);
        if (!record) return;
        if (!groups.has(record.group)) {
          const cwd = await procCwd(pid);
          if (cwd !== p.container && !cwd.startsWith(p.container + '/')) return;
        }
        return { ...record, wchan: await procWait(pid) };
      } catch (error) {
        if (unconfirmed.has(Number(pid)) && !['ENOENT', 'ESRCH'].includes(error.code))
          return { pid: Number(pid), state: 'unknown', wchan: 'unknown' };
      }
    }));
    return remaining.filter(Boolean);
  }
  async function stopCores() {
    if (process.platform !== 'linux') return;
    for (let round = 0; round < 3; round++) {
      const recorded = await cores();
      if (!recorded.length) {
        await new Promise(r => setTimeout(r, 150));
        if (!(await cores()).length) return;
        continue;
      }
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        for (const record of recorded) {
          // Revalidate UID, comm, attempt cwd and Linux start time before each PID signal.
          if ((await coreRecord(record.pid))?.start === record.start) {
            try { process.kill(record.pid, signal); } catch {}
            emit({ type: 'output', name: 'cleanup', text: 'Stopped check runtime PID ' + record.pid + ' (' + signal + ')\n' });
          }
        }
        await new Promise(r => setTimeout(r, 150));
      }
    }
    if ((await cores()).length) cleanup_errors.push('Check runtime processes did not stop');
  }
  try {
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    for (const target of [runtime, temporary]) {
      await chmod(target, 0o700);
      const info = await lstat(target);
      if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700 || await realpath(target) !== target)
        throw new Error('Unsafe private check directory');
    }
    await mkdir(aliases, { mode: 0o700 }); ownsAliases = true;
    await chmod(aliases, 0o700);
    await symlink(runtime, aliasRuntime); await symlink(temporary, aliasTmp);
    // run() skips without spawning once cancelled or expired, so no registration can exist then.
    registered = !(cancelled || totalExpired);
    const added = await git(p.repository, ['worktree', 'add', '--detach', '--', p.directory, p.sha]);
    if (added.status === 'interrupted') {
      addInterrupted = true; status = 'interrupted'; reason = '临时工作区建好之前已取消';
    }
    else if (added.status !== 'passed') { status = added.status; reason = 'Temporary checkout failed'; }
    else if (!await verify()) { status = 'failed'; reason = 'Checkout HEAD or tree does not match'; }
    for (const check of p.checks) {
      if (check.skipReason === 'docs_only') {
        checks.push({ name: check.name, status: 'skipped', reason: 'docs_only' }); continue;
      }
      if (status !== 'passed') { checks.push({ name: check.name, status: 'not_run' }); continue; }
      const checkEnv = check.affectedPaths === undefined ? environment :
        { ...environment, CARDIGAN_AFFECTED_PATHS: check.affectedPaths.join(' ') };
      const r = await run('/bin/sh', ['-c', check.run], checkEnv, p.directory, check.timeoutMs, check.name);
      checks.push({ name: check.name, status: r.status, exit_code: r.code, duration_ms: r.duration_ms });
      status = r.status;
      if (status !== 'passed') reason = 'Check did not pass: ' + check.name;
    }
    if (status === 'passed' && !await verify()) { status = 'failed'; reason = 'Checkout HEAD or tree changed'; }
    if (cancelled) status = 'interrupted';
    else if (totalExpired) status = 'timed_out';
  } catch { status = 'failed'; reason = 'Checkout execution failed'; }
  finally {
    clearTimeout(deadline);
    try { await stopCores(); } catch { cleanup_errors.push('Could not inspect check runtime processes'); }
    let remaining;
    try { remaining = await remainingProcesses(); }
    catch { remaining = [...unconfirmed].map(pid => ({ pid, state: 'unknown', wchan: 'unknown' }));
      if (!remaining.length) remaining = [{ pid: process.pid, state: 'unknown', wchan: 'inspection_failed' }]; }
    if (remaining.length) {
      manual_attention = true;
      for (const record of remaining) {
        const message = 'Manual attention required for attempt ' + basename(p.container) + ': PID ' + record.pid +
          ' state=' + record.state + ' wchan=' + record.wchan;
        cleanup_errors.push(message);
        emit({ type: 'output', name: 'cleanup', text: message + '\n' });
      }
      try { await markManualAttention(p.container, remaining); }
      catch { cleanup_errors.push('Could not persist manual-attention.json; preserve the check directory'); }
      if (status === 'passed') { status = 'failed'; reason = 'Check child processes did not stop'; }
    } else {
    // Cleanup does not inherit cancellation. Git and recursive deletion run as the owner.
    const removed = await git(p.repository, ['worktree', 'remove', '--force', '--', p.directory], true);
    // A cancelled add may have stopped before Git registered anything; only report a registration that remains.
    if (registered && removed.status !== 'passed' && (!addInterrupted || await stillRegistered()))
      cleanup_errors.push('Could not remove temporary worktree registration');
    try { await rm(p.directory, { recursive: true, force: true }); }
    catch { cleanup_errors.push('Could not remove temporary checkout files'); }
    for (const path of [runtime, temporary]) {
      try { await rm(path, { recursive: true, force: true }); }
      catch { cleanup_errors.push('Could not remove private check runtime files'); }
    }
    if (ownsAliases) try { await rm(aliases, { recursive: true, force: true }); }
    catch { cleanup_errors.push('Could not remove private runtime aliases'); }
    }
  }
  emit({ type: 'result', nonce, status, checks, cleanup_errors, ...(manual_attention ? { manual_attention } : {}), ...(reason ? { reason } : {}) });
}
`;
