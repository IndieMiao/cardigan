/** Trusted supervisor executed as the checkout owner, never from the checked-out tree. */
export const CHECKOUT_WORKER = String.raw`
const { spawn } = require('node:child_process');
const { rm } = require('node:fs/promises');
const { createInterface } = require('node:readline');
const input = createInterface({ input: process.stdin });
let cancelled = false, current, deadline, totalExpired = false;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const cancel = () => { cancelled = true; current?.('interrupted'); };
input.on('close', cancel);
process.on('SIGTERM', cancel);
process.on('SIGINT', cancel);
process.stdout.on('error', cancel);
input.once('line', line => {
  input.on('line', cancel);
  main(JSON.parse(line)).catch(() => { process.exitCode = 1; }).finally(() => {
    clearTimeout(deadline);
    input.close();
    process.stdin.destroy();
  });
});
async function main(p) {
  const checks = [], cleanup_errors = [];
  const environment = { PATH: p.path, ...p.env };
  const gitEnv = { PATH: p.path, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
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
      let result = 'passed', output = '', hardStop;
      const kill = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch {} };
      const stop = value => {
        if (result !== 'passed') return;
        result = value;
        kill('SIGTERM');
        hardStop = setTimeout(() => kill('SIGKILL'), 500);
      };
      if (!cleanup) current = stop;
      const timer = setTimeout(() => stop('timed_out'), timeout);
      if (name) emit({ type: 'started', name, pid: child.pid });
      for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', data => {
        if (name) emit({ type: 'output', name, text: data });
        else output = (output + data.toString()).slice(-65536);
      });
      child.once('error', () => { result = 'failed'; });
      // A completed shell must not leave background children in its process group.
      child.once('exit', () => kill('SIGKILL'));
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(hardStop);
        if (!cleanup) current = undefined;
        resolve({ code, status: result === 'passed' && code !== 0 ? 'failed' : result,
          duration_ms: Date.now() - started, output });
      });
    });
  }
  const git = (cwd, args, cleanup = false) =>
    run('git', [...safety, '-C', cwd, ...args], gitEnv, '/', 30000, undefined, cleanup);
  async function verify() {
    const head = await git(p.directory, ['rev-parse', '--verify', 'HEAD']);
    const tree = await git(p.directory, ['rev-parse', '--verify', 'HEAD^{tree}']);
    const dirty = await git(p.directory, ['status', '--porcelain=v1', '--untracked-files=no']);
    return [head, tree, dirty].every(r => r.status === 'passed') &&
      head.output.trim() === p.sha && tree.output.trim() === p.tree && dirty.output.trim() === '';
  }
  try {
    const added = await git(p.repository, ['worktree', 'add', '--detach', '--', p.directory, p.sha]);
    if (added.status !== 'passed') { status = added.status; reason = 'Temporary checkout failed'; }
    else if (!await verify()) { status = 'failed'; reason = 'Checkout HEAD or tree does not match'; }
    for (const check of p.checks) {
      if (status !== 'passed') { checks.push({ name: check.name, status: 'not_run' }); continue; }
      const r = await run('/bin/sh', ['-c', check.run], environment, p.directory, check.timeoutMs, check.name);
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
    // Cleanup does not inherit cancellation. Git and recursive deletion run as the owner.
    const removed = await git(p.repository, ['worktree', 'remove', '--force', '--', p.directory], true);
    if (removed.status !== 'passed') cleanup_errors.push('Could not remove temporary worktree registration');
    try { await rm(p.directory, { recursive: true, force: true }); }
    catch { cleanup_errors.push('Could not remove temporary checkout files'); }
  }
  emit({ type: 'result', status, checks, cleanup_errors, ...(reason ? { reason } : {}) });
}
`;
