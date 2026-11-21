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
// Alert-only classification, never a shell parser. Only simple unquoted argv
// with a recognized executable and operand are specific enough to name.
function foregroundName(cmd) {
  const simple = cmd.trim();
  if (!/^[\w./:@=+%,-]+(?:[ \t]+[\w./:@=+%,-]+)*$/.test(simple)) return 'Bash';
  const [exe, arg, next] = simple.split(/[ \t]+/);
  if (exe === 'node' && arg && !arg.startsWith('-') && basename(arg) === 'web.mjs') return 'node web.mjs';
  if (['python', 'python3'].includes(exe) && arg === '-m' && next === 'http.server') return 'python -m http.server';
  if (['npm', 'pnpm'].includes(exe) && (arg === 'dev' || (arg === 'run' && next === 'dev'))) return 'dev server';
  return exe === 'vite' ? 'vite' : 'Bash';
}
// Use only cumulative counters from the matched invocation, never the output
// text. A newly available counter on an already productive call is a baseline,
// not proof of growth. Repeated or regressing counters cannot renew activity.
function bashOutputGrew(call, data) {
  const keys = ['totalBytes', 'totalLines'].filter(key => data[key] !== undefined);
  if (keys.some(key => !Number.isSafeInteger(data[key]) || data[key] < (call.counts[key] ?? 0))) return false;
  const grew = keys.some(key => (call.counts[key] !== undefined || !call.produced) &&
    data[key] > (call.counts[key] ?? 0));
  for (const key of keys) call.counts[key] = data[key];
  if (grew) call.produced = true;
  return grew;
}
// Only the final attributable main-thread record may claim the file mtime.
// A later timer, fault, sidechain or unread gap leaves only verified record times.
function alertMetadata(lines, path, mtime, activity) {
  const id = basename(path, '.jsonl');
  let last, finalWrite;
  // Per bounded read of this session only. A tool ID is local to its cwd;
  // completing one sibling cannot consume another's start or high-water marks.
  const pending = new Map();
  const earliestCall = Number(process.argv[4]);
  const writeTime = new Date(mtime).toISOString();
  for (const line of lines) {
    if (line === '') continue;
    finalWrite = undefined;
    let e;
    try { e = object(JSON.parse(line)); } catch { pending.clear(); continue; }
    if (!e || e.isSidechain === true || e.message?.model === '<synthetic>') continue;
    if (e.sessionId && e.sessionId !== id) return;
    if (e.sessionId !== id || !text(e.cwd, 4096)) continue;
    if (e.isApiErrorMessage === true || (e.type === 'system' && e.subtype === 'api_error') ||
        !['user', 'assistant', 'progress'].includes(e.type)) continue;
    const ts = Date.parse(text(e.timestamp, 64));
    const timestamp = Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
    if (e.type === 'progress' && e.data?.type === 'bash_progress') {
      const call = pending.get(e.cwd)?.get(e.parentToolUseID);
      if (!call || ts < Date.parse(call.since)) continue;
      if (bashOutputGrew(call, e.data) && timestamp &&
          (!last || ts >= Date.parse(last.updated_at))) {
        last = {session_id: id, cwd: e.cwd, updated_at: timestamp};
      }
      continue;
    }
    finalWrite = {session_id: id, cwd: e.cwd, updated_at: writeTime};
    if (timestamp && (!last || ts >= Date.parse(last.updated_at))) last = {...finalWrite, updated_at: timestamp};
    if (!Array.isArray(e.message?.content)) continue;
    for (const block of e.message.content) {
      let calls = pending.get(e.cwd);
      if (e.type === 'user' && block?.type === 'tool_result') {
        const call = calls?.get(block.tool_use_id);
        if (call && (!timestamp || ts >= Date.parse(call.since))) calls.delete(block.tool_use_id);
        if (calls?.size === 0) pending.delete(e.cwd);
        continue;
      }
      if (e.type !== 'assistant' || block?.type !== 'tool_use' || block.name !== 'Bash' ||
          block.input?.run_in_background || typeof block.input?.command !== 'string' ||
          !text(block.id, 128) || !timestamp || !(ts >= earliestCall)) continue;
      if (!calls) { calls = new Map(); pending.set(e.cwd, calls); }
      if (!calls.has(block.id)) calls.set(block.id, {
        command: foregroundName(block.input.command), since: timestamp, counts: {}, produced: false,
      });
    }
  }
  const progressAt = activity?.error ? activity.progress?.updated_at : activity?.updated_at;
  const file = finalWrite ?? (last && (!progressAt || Date.parse(last.updated_at) > Date.parse(progressAt)) ? last : undefined);
  // Several calls can all contribute progress, but none is uniquely the stalled command.
  const calls = pending.size === 1 ? pending.values().next().value : undefined;
  const only = calls?.size === 1 ? calls.values().next().value : undefined;
  return file || only ? {...(file ? {file_activity: file} : {}), ...(only ? {foreground: {command: only.command, since: only.since}} : {})} : undefined;
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
  // For alert metadata only, spend the extra 64 KiB immediately before the
  // tail, so a crossing screenshot can be attributed even in a long-lived file.
  // If its opening is still outside the window, never guess its thread or mtime.
  if (size !== stat.size - start) return sample;
  let diagnosticLines = lines;
  if (start) {
    const prefix = Buffer.alloc(Math.min(start, 65536));
    if (readSync(fd, prefix, 0, prefix.length, start - prefix.length) !== prefix.length) return sample;
    diagnosticLines = Buffer.concat([prefix, buffer]).toString('utf8').split('\n');
    if (start > prefix.length) diagnosticLines.shift();
  }
  const extra = alertMetadata(diagnosticLines, path, stat.mtimeMs, sample?.activity);
  return extra ? {path, ...sample, ...extra} : sample;
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
