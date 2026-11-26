import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * C-804: host-private record of each Darwin launch's idle-owner enrollment
 * outcome (`enrolled` or why it was skipped), so a later refused retirement
 * can name it. Diagnostic only: it never authorizes or refuses anything.
 * Files are named by a digest of the enrollment id and hold one bounded
 * token; never a path, key, seed or signature.
 */
export const DARWIN_ENROLLMENT_DIR = "darwin-idle-owner.enrollment";
const LIMIT = 2048;
const token = /^[a-z_]{1,40}$/u;
const digest = /^[0-9a-f]{64}$/u;

const name = (id: string) => createHash("sha256").update(id).digest("hex");

async function directory(dataDir: string, create: boolean) {
  const path = join(dataDir, DARWIN_ENROLLMENT_DIR);
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
  const entry = await lstat(path);
  if (
    !entry.isDirectory() ||
    entry.uid !== process.getuid?.() ||
    (entry.mode & 0o077) !== 0
  )
    throw new Error("Unverified Darwin enrollment records");
  return path;
}

/** Keep the newest LIMIT records; older launches are long retired. */
async function prune(path: string) {
  const names = (await readdir(path)).filter((n) => digest.test(n));
  if (names.length <= LIMIT) return;
  const aged = await Promise.all(
    names.map(async (n) => ({
      n,
      at: (await lstat(join(path, n)).catch(() => undefined))?.mtimeMs ?? 0,
    })),
  );
  aged.sort((a, b) => a.at - b.at);
  for (const { n } of aged.slice(0, aged.length - LIMIT))
    await rm(join(path, n), { force: true });
}

/** Best effort: a launch never fails because its diagnostic was not written. */
export async function recordDarwinEnrollment(
  dataDir: string,
  id: string,
  outcome: string,
): Promise<void> {
  if (!token.test(outcome)) return;
  try {
    const path = await directory(dataDir, true);
    const handle = await open(
      join(path, name(id)),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${outcome}\n`);
    } finally {
      await handle.close();
    }
    await prune(path);
  } catch {}
}

/** `unrecorded` when this launch left no record (launched before C-804, or
 * the record could not be written); `unreadable` when one cannot be trusted. */
export async function readDarwinEnrollment(
  dataDir: string,
  id: string,
): Promise<string> {
  const missing = (err: unknown) =>
    (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "unrecorded"
      : "unreadable";
  let path: string;
  try {
    path = await directory(dataDir, false);
  } catch (err) {
    return missing(err);
  }
  try {
    const handle = await open(
      join(path, name(id)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.size > 64) return "unreadable";
      const value = (await handle.readFile("utf8")).trim();
      return token.test(value) ? value : "unreadable";
    } finally {
      await handle.close();
    }
  } catch (err) {
    return missing(err);
  }
}
