import { constants } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const TAIL_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;

// The host reads Agent-writable trees. Pin every ancestor so a directory swap
// cannot redirect a read into host-private files between lstat and open.
async function directory(path: string): Promise<FileHandle> {
  if (process.platform !== "linux")
    throw new Error(
      "Context cache reader requires pinned directory descriptors",
    );
  const flags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let current = await open("/", flags);
  try {
    for (const part of resolve(path).split("/").filter(Boolean)) {
      const next = await open(`/proc/self/fd/${current.fd}/${part}`, flags);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

/** Never read a cache-provided transcript path or follow directory/file symlinks. */
export async function files(
  root: string,
  suffix: string,
  depth = 0,
  onReadFailure?: () => void,
): Promise<string[]> {
  let dir: FileHandle | undefined;
  try {
    if (depth > 4) {
      onReadFailure?.();
      return [];
    }
    dir = await directory(root);
    const entries = await readdir(`/proc/self/fd/${dir.fd}`, {
      withFileTypes: true,
    });
    if (entries.length > 2048) {
      onReadFailure?.();
      return [];
    }
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory())
        result.push(
          ...(await files(
            join(root, entry.name),
            suffix,
            depth + 1,
            onReadFailure,
          )),
        );
      else if (entry.isFile() && entry.name.endsWith(suffix))
        result.push(join(root, entry.name));
      if (result.length > 4096) {
        onReadFailure?.();
        return [];
      }
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") onReadFailure?.();
    return [];
  } finally {
    await dir?.close();
  }
}
export async function readParts(path: string, cache = false) {
  const dir = await directory(dirname(path));
  let file: FileHandle | undefined;
  try {
    file = await open(
      `/proc/self/fd/${dir.fd}/${basename(path)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || (cache && stat.size > HEAD_BYTES)) return undefined;
    const start = Buffer.alloc(Math.min(stat.size, HEAD_BYTES));
    const head = await file.read(start, 0, start.length, 0);
    const tailStart = Math.max(0, stat.size - TAIL_BYTES);
    const end = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    const tail = await file.read(end, 0, end.length, tailStart);
    return {
      head: start.subarray(0, head.bytesRead).toString("utf8"),
      tail: end.subarray(0, tail.bytesRead).toString("utf8"),
      tailStart,
      mtime: stat.mtimeMs,
    };
  } finally {
    await file?.close();
    await dir.close();
  }
}
