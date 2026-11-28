import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** C-845: at most this many processes are named. */
export const DATABASE_OPENERS_MAX = 10;
/** Command words shown for a CLI process: lowercase words only, never values. */
const COMMAND_WORD = /^[a-z][a-z-]{0,31}$/u;

/**
 * C-845: read-only diagnostics after the role sync kept finding the database
 * locked. SQLite does not say who holds its write lock, so this names the
 * other processes that have the database (or its WAL) open: the supervisor's
 * own server children by role, a Cardigan CLI by its command words, anything
 * else only as "其它进程". Labels are fixed text plus a PID; no path, argument
 * value or environment leaves. Linux only; elsewhere, or when /proc cannot be
 * read, nothing is named. Never signals a process.
 */
export async function databaseOpeners(
  database: string,
  known: Readonly<Record<number, string>> = {},
  proc = "/proc",
): Promise<string[]> {
  let target: string;
  try {
    target = join(await realpath(dirname(database)), basename(database));
  } catch {
    return [];
  }
  const files = new Set([target, `${target}-wal`, `${target}-shm`]);
  let pids: number[];
  try {
    pids = (await readdir(proc))
      .filter((name) => /^[1-9][0-9]*$/u.test(name))
      .map(Number)
      .filter((pid) => pid !== process.pid)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
  const labels: string[] = [];
  for (const pid of pids) {
    if (labels.length >= DATABASE_OPENERS_MAX) break;
    if (!(await opens(join(proc, String(pid), "fd"), files))) continue;
    labels.push(
      `${known[pid] ?? (await commandLabel(join(proc, String(pid))))}（pid ${pid}）`,
    );
  }
  return labels;
}

async function opens(fdDir: string, files: ReadonlySet<string>) {
  let fds: string[];
  try {
    fds = await readdir(fdDir);
  } catch {
    return false;
  }
  for (const fd of fds) {
    try {
      if (files.has(await readlink(join(fdDir, fd)))) return true;
    } catch {
      /* Closed meanwhile. */
    }
  }
  return false;
}

async function commandLabel(dir: string) {
  let argv: string[];
  try {
    argv = (await readFile(join(dir, "cmdline"), "utf8"))
      .split("\0")
      .filter(Boolean);
  } catch {
    return "其它进程";
  }
  const bin = argv.findIndex((a) =>
    /(?:^|\/)apps\/cli\/dist\/bin\.js$/u.test(a),
  );
  if (bin < 0) return "其它进程";
  const words: string[] = [];
  for (const word of argv.slice(bin + 1, bin + 3)) {
    if (!COMMAND_WORD.test(word)) break;
    words.push(word);
  }
  return words.length ? `cardigan CLI ${words.join(" ")}` : "cardigan CLI";
}
