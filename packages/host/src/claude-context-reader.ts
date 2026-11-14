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
    return list.length <= 2048 ? list : [];
  } catch { return []; }
  finally { await dir?.close(); }
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function text(value, max) {
  return typeof value === 'string' && value.length <= max ? value : null;
}
async function read() {
  const projects = join(root, 'claude', 'projects');
  const candidates = [];
  for (const slug of await entries(projects)) {
    if (!slug.isDirectory()) continue;
    const path = join(projects, slug.name);
    let dir;
    try {
      dir = await directory(path);
      const list = await readdir('/proc/self/fd/' + dir.fd, { withFileTypes: true });
      if (list.length > 2048) continue;
      for (const entry of list) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const stat = await lstat('/proc/self/fd/' + dir.fd + '/' + entry.name);
        if (!stat.isFile()) continue;
        candidates.push({ path: join(path, entry.name), name: entry.name, mtime: stat.mtimeMs });
        if (candidates.length > 256) return;
      }
    } catch { /* Unreadable or swapped directory. */ }
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
    const stat = await file.stat();
    if (!stat.isFile()) return;
    const start = Math.max(0, stat.size - 4 * 1024 * 1024);
    const buffer = Buffer.alloc(Math.min(stat.size, 4 * 1024 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
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
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
        counts[key] = value;
      }
      return {
        path: chosen.path, type: 'assistant', sessionId: text(event.sessionId, 128),
        cwd: text(event.cwd, 4096), timestamp: text(event.timestamp, 64),
        message: { model: text(message.model, 256), usage: counts },
      };
    }
  } finally { await file?.close(); await dir.close(); }
}
read().catch(() => null).then(sample => {
  process.stdout.write(JSON.stringify(sample ?? null), () => {
    clearTimeout(timeout);
    process.exit();
  });
});
`;
