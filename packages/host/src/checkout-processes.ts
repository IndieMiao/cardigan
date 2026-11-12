import { CHECKOUT_LIMITS } from "./checkout-limits.js";

/** Shared trusted Linux inspection. Never reads cmdline or runs ps. */
export const CHECKOUT_PROCESSES = String.raw`
const procFiles = require('node:fs/promises');
async function boundedRead(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Process inspection timed out')), ${CHECKOUT_LIMITS.procReadMs});
    })]);
  } finally { clearTimeout(timer); }
}
async function procStat(pid) {
  const stat = await boundedRead(procFiles.readFile('/proc/' + pid + '/stat', 'utf8'));
  const end = stat.lastIndexOf(') '), fields = stat.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || !/^\d+$/.test(fields[19])) throw new Error('Invalid process identity');
  return { pid: Number(pid), comm: stat.slice(stat.indexOf('(') + 1, end),
    state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]), start: fields[19] };
}
async function procIdentity(pid, observed) {
  const record = observed ?? await procStat(pid);
  if (['Z', 'X'].includes(record.state)) return;
  const status = await boundedRead(procFiles.readFile('/proc/' + pid + '/status', 'utf8'));
  const uids = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);
  if (!uids) throw new Error('Invalid process owner');
  if (uids.slice(1).some(uid => Number(uid) !== process.getuid())) return;
  return record;
}
async function procCwd(pid) {
  return boundedRead(procFiles.readlink('/proc/' + pid + '/cwd'));
}
async function procWait(pid) {
  try {
    const value = (await boundedRead(procFiles.readFile('/proc/' + pid + '/wchan', 'utf8'))).trim();
    return /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : 'unknown';
  } catch { return 'unknown'; }
}
async function procPids() {
  return (await boundedRead(procFiles.readdir('/proc'))).filter(pid => /^[1-9]\d*$/.test(pid));
}
async function markManualAttention(container, records) {
  const data = { kind: 'merge_check_manual_attention', processes: records,
    reason: 'Check processes did not stop; preserve this directory for operator inspection' };
  try {
    await boundedRead(procFiles.writeFile(container + '/manual-attention.json', JSON.stringify(data) + '\n',
      { mode: 0o600, flag: 'wx' }));
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
}
`;
