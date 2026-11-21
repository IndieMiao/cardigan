/**
 * Fixed reader, executed by the account that owns Claude's private directories.
 * No project code is loaded. Only the selected usage fields cross stdout; the
 * transcript body and read/SSH errors never leave the reader.
 */
export const CLAUDE_CONTEXT_READER = String.raw`
const { constants } = require('node:fs');
const { open, readdir, lstat } = require('node:fs/promises');
const { resolve, join, dirname, basename } = require('node:path');
const root = process.argv[1], session = process.argv[2];
let readFailed = false;
const timeout = setTimeout(() => process.exit(1), 10000);
async function directory(path) {
  if (process.platform !== 'linux') throw new Error();
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let current = await open('/', flags);
  try {
    for (const part of resolve(path).split('/').filter(Boolean)) {
      const next = await open('/proc/self/fd/' + current.fd + '/' + part, flags);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) { await current.close(); throw error; }
}
async function entries(path) {
  let dir;
  try {
    dir = await directory(path);
    const list = await readdir('/proc/self/fd/' + dir.fd, { withFileTypes: true });
    if (list.length > 2048) { readFailed = true; return []; }
    return list;
  } catch (error) { if (error.code !== 'ENOENT') readFailed = true; return []; }
  finally { await dir?.close(); }
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function text(value, max) {
  return typeof value === 'string' && value.length <= max ? value : null;
}
function summarize(lines, path, attributable, activityOnly, complete) {
  const workerSession = activityOnly ? basename(path, '.jsonl') : undefined;
  let activity, progress, fault, silentSince = complete ? 0 : undefined;
  if (attributable) {
    for (const line of lines.slice(-256)) {
      let event;
      try { event = object(JSON.parse(line)); } catch { if (line.trim()) silentSince = undefined; continue; }
      if (!event) { silentSince = undefined; continue; }
      if (event.isSidechain === true) continue;
      const apiError = event.isApiErrorMessage === true ||
        (event.type === 'system' && event.subtype === 'api_error');
      if (!apiError && !['assistant', 'user'].includes(event.type)) continue;
      if (!apiError && object(event.message)?.model === '<synthetic>') continue;
      // Even a unique worker file is not evidence for another CLI session.
      if (activityOnly && event.sessionId !== workerSession) return;
      const timestamp = text(event.timestamp, 64);
      if (!timestamp || !Number.isFinite(Date.parse(timestamp)) ||
        (activity && Date.parse(timestamp) < Date.parse(activity.updated_at))) {
        activity = undefined;
        break;
      }
      const status = object(event.error)?.status;
      const error = status === 429 ? 'rate_limit' :
        Number.isInteger(status) && status >= 500 && status <= 599 ? 'server_error' : 'unclassified';
      activity = { session_id: text(event.sessionId, 128), cwd: text(event.cwd, 4096),
        updated_at: timestamp, ...(event.type === 'assistant' && object(event.message)?.stop_reason === 'end_turn' && !apiError ? { turn_ended: true } : {}), ...(apiError ? { error } : {}) };
      if (silentSince !== undefined) {
        if (apiError) fault = error !== 'unclassified' ? activity : undefined;
        else if (event.type === 'assistant') { silentSince = Date.parse(timestamp); fault = undefined; }
      }
      if (!apiError) progress = activity;
      else if (progress && progress.session_id === activity.session_id) activity.progress = progress;
    }
  }
  // Only attach proof after the entire bounded read, including the suffix, was validated.
  if (activity && fault && silentSince !== undefined &&
      activity.session_id === fault.session_id && activity.cwd === fault.cwd) {
    activity = { ...activity, startup_failure: { session_id: fault.session_id, cwd: fault.cwd,
      updated_at: fault.updated_at, error: fault.error, model_silent_since: silentSince } };
  }
  if (activityOnly) return activity ? { path, activity } : undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    let event;
    try { event = object(JSON.parse(lines[i])); } catch { continue; }
    if (event?.type !== 'assistant' || event.isSidechain === true) continue;
    const message = object(event.message), usage = object(message?.usage);
    if (!usage || message.model === '<synthetic>') continue;
    const counts = {};
    for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
      const value = usage[key];
      if (value === undefined && key.startsWith('cache_')) continue;
      // Invalid latest usage suppresses earlier usage, as in the host parser.
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return activity ? { path, activity } : undefined;
      counts[key] = value;
    }
    return {
      path, ...(activity ? { activity } : {}), type: 'assistant', sessionId: text(event.sessionId, 128),
      cwd: text(event.cwd, 4096), timestamp: text(event.timestamp, 64),
      message: { model: text(message.model, 256), usage: counts },
    };
  }
  return activity ? { path, activity } : undefined;
}
// Alert-only metadata. A large screenshot can consume the entire bounded tail;
// establish file ownership independently from a bounded prefix in that case.
function alertMetadata(head, tail, path, mtime) {
  const id = basename(path, '.jsonl');
  let cwd, pending, clockOnly = false;
  const lines = head.concat(tail);
  for (const [index, line] of lines.entries()) {
    let e; try { e = object(JSON.parse(line)); } catch { continue; }
    if (!e) continue;
    if (e.isSidechain === true || e.message?.model === '<synthetic>') {
      if (index >= head.length) clockOnly = true;
      continue;
    }
    if (e.sessionId && e.sessionId !== id) return;
    if (e.sessionId !== id || !text(e.cwd, 4096)) continue;
    cwd = e.cwd;
    if (index < head.length) continue; // Never infer a pending command across an unread gap.
    clockOnly = e.type === 'progress' && e.data?.type === 'bash_progress';
    if (!Array.isArray(e.message?.content)) continue;
    for (const block of e.message.content) {
      if (block?.type === 'tool_result' && pending?.id === block.tool_use_id) pending = undefined;
      if (block?.type !== 'tool_use' || block.name !== 'Bash' || block.input?.run_in_background || typeof block.input?.command !== 'string') continue;
      // Never export arguments, filenames, environment assignments or shell text.
      const cmd = block.input.command;
      const command = /(?:^|\s)node\s+[^\n;&|]*\bweb\.mjs\b/.test(cmd) ? 'node web.mjs' :
        /(?:^|\s)python3?\s+-m\s+http\.server\b/.test(cmd) ? 'python -m http.server' :
        /(?:^|\s)(?:pnpm|npm)\s+(?:run\s+)?dev\b/.test(cmd) ? 'dev server' :
        /(?:^|\s)vite(?:\s|$)/.test(cmd) ? 'vite' : 'Bash';
      if (text(block.id, 128) && Number.isFinite(Date.parse(e.timestamp))) pending = {id: block.id, command, since: e.timestamp};
    }
  }
  return cwd ? {file_activity: {session_id: id, cwd, updated_at: new Date(mtime).toISOString()},
    ...(pending ? {foreground: {command: pending.command, since: pending.since}} : {}), clock_only: clockOnly} : undefined;
}
function readTail(fd, path, attributable, activityOnly = false) {
  const { fstatSync, readSync } = require('node:fs');
  const stat = fstatSync(fd);
  if (!stat.isFile()) return;
  const start = Math.max(0, stat.size - 4 * 1024 * 1024);
  const buffer = Buffer.alloc(stat.size - start);
  const size = readSync(fd, buffer, 0, buffer.length, start);
  const lines = buffer.subarray(0, size).toString('utf8').split('\n');
  if (start) lines.shift();
  const sample = summarize(lines, path, attributable, activityOnly, !start && size === stat.size && lines.length <= 256);
  if (!attributable) return sample;
  const prefix = Buffer.alloc(start ? Math.min(start, 65536) : 0);
  const count = prefix.length ? readSync(fd, prefix, 0, prefix.length, 0) : 0;
  const extra = alertMetadata(prefix.subarray(0, count).toString('utf8').split('\n').slice(0, 32), lines.slice(-256), path, stat.mtimeMs);
  if (!extra) return sample;
  return {path, ...sample, ...(!sample?.activity?.error && !extra.clock_only ? {file_activity: extra.file_activity} : {}), ...(extra.foreground ? {foreground: extra.foreground} : {})};
}
async function read() {
  // The worker opener passed a no-follow regular file as stdin. This is
  // activity evidence only: do not trigger context notices or restarts.
  if (process.argv[3] === 'worker-fd') return readTail(0, root, true, true);
  const projects = join(root, 'claude', 'projects');
  const candidates = [];
  for (const slug of await entries(projects)) {
    if (!slug.isDirectory()) continue;
    const path = join(projects, slug.name);
    let dir;
    try {
      dir = await directory(path);
      const list = await readdir('/proc/self/fd/' + dir.fd, { withFileTypes: true });
      if (list.length > 2048) { readFailed = true; continue; }
      for (const entry of list) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const stat = await lstat('/proc/self/fd/' + dir.fd + '/' + entry.name);
        if (!stat.isFile()) continue;
        candidates.push({ path: join(path, entry.name), name: entry.name, mtime: stat.mtimeMs, born: stat.birthtimeMs });
        if (candidates.length > 256) { readFailed = true; return; }
      }
    } catch { readFailed = true; }
    finally { await dir?.close(); }
  }
  const wanted = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(session) ? session + '.jsonl' : null;
  const chosen = candidates.find(c => c.name === wanted) ?? candidates.sort(
    (a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1)
  )[0];
  if (!chosen) return;
  const dir = await directory(dirname(chosen.path));
  let file;
  try {
    file = await open('/proc/self/fd/' + dir.fd + '/' + basename(chosen.path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    // With no trusted session ID, a late write to an older file cannot revive it.
    const byCreation = candidates.slice().sort((a, b) => b.born - a.born);
    const latest = byCreation.length === 1 || (byCreation[0]?.born > 0 && byCreation[0].born !== byCreation[1]?.born) ? byCreation[0] : undefined;
    return readTail(file.fd, chosen.path, (!wanted && chosen.path === latest?.path) || chosen.name === wanted);
  } finally { await file?.close(); await dir.close(); }
}
read().catch(() => { readFailed = true; }).then(sample => {
  process.stdout.write(JSON.stringify(readFailed ? { read_failed: true } : sample ?? null), () => {
    clearTimeout(timeout);
    process.exit();
  });
});
`;
