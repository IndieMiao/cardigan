import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;
const storageCodes = new Set([
  "EIO",
  "EINTR",
  "EBUSY",
  "EAGAIN",
  "ENOSPC",
  "EDQUOT",
  "EMFILE",
  "ENFILE",
  "EROFS",
]);
/** An exclusive private sibling keeps incomplete writes out of the ranged reader. */
export async function saveCheckLog(
  path: string,
  verifyDirectory: () => Promise<void>,
  write: (file: FileHandle) => Promise<void>,
): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    const temp = `${path}.${randomUUID()}.tmp`;
    let created = false;
    let verified = false;
    try {
      // Identity/permission failures are not evidence of a transient write fault.
      await verifyDirectory();
      const existing = await fs.lstat(path);
      if (
        !existing.isFile() ||
        existing.nlink !== 1 ||
        existing.uid !== process.getuid?.() ||
        (existing.mode & 0o777) !== 0o600
      )
        throw new Error("Unsafe merge check log file");
      verified = true;
      const file = await fs.open(
        temp,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      try {
        await write(file);
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temp, path);
      created = false;
      return undefined;
    } catch (e) {
      const code = errno(e);
      if (!code || !storageCodes.has(code)) throw e;
      if (attempt === 2) {
        if (!verified) throw e;
        return code;
      }
    } finally {
      if (created)
        await fs.unlink(temp).catch((e) => {
          if (errno(e) !== "ENOENT") throw e;
        });
    }
    await delay(50 * (attempt + 1));
  }
}
export async function pruneCheckLogs(directory: string) {
  const logs = [];
  for (const name of await fs.readdir(directory)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.log$/u.test(name)) continue;
    try {
      const info = await fs.lstat(join(directory, name));
      if (info.isFile() && info.uid === process.getuid?.())
        logs.push({ name, time: info.mtimeMs });
    } catch (e) {
      if (errno(e) !== "ENOENT") throw e;
    }
  }
  logs.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  for (const old of logs.slice(50))
    await fs.unlink(join(directory, old.name)).catch((e) => {
      if (errno(e) !== "ENOENT") throw e;
    });
}
