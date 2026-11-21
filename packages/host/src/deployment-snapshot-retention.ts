import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireHostDirectory } from "./deployment-config.js";

const snapshotName =
  /^database-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.bak$/u;

async function mountId(fd: number) {
  const m = /^mnt_id:\s*(\d+)$/mu.exec(
    await readFile(`/proc/self/fdinfo/${fd}`, "utf8"),
  );
  if (!m) throw new Error("Unknown snapshot mount");
  return m[1];
}

/** Read-only input for the site manifest. Never descend into backup directories. */
export async function previewDeploymentSnapshots(
  directory: string,
  referenced: string | undefined,
  { latest = 5, days = 7, now = new Date() } = {},
) {
  if (
    ![days, latest].every((n) => Number.isSafeInteger(n) && n >= 1) ||
    !Number.isFinite(now.getTime())
  )
    throw new Error("Invalid snapshot retention policy");
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() - days + 1);
  if (!Number.isFinite(midnight.getTime()))
    throw new Error("Invalid snapshot retention window");
  await requireHostDirectory(directory);
  const root = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await root.stat();
    if (info.uid !== process.getuid?.() || info.mode & 0o077)
      throw new Error("Unsafe deployment directory");
    const rootMount = await mountId(root.fd);
    const pinned = `/proc/self/fd/${root.fd}`;
    const snapshots = [];
    const skipped: string[] = [],
      namespace: Record<string, string> = {};
    for (const name of await readdir(pinned)) {
      if (!snapshotName.test(name)) continue;
      const stat = await lstat(join(pinned, name), { bigint: true }).catch(
        () => undefined,
      );
      // VACUUM INTO followed by chmod(0600); an incomplete or substituted entry is not ours to prune.
      if (
        !stat?.isFile() ||
        stat.uid !== BigInt(info.uid) ||
        (stat.mode & 0o7777n) !== 0o600n ||
        stat.nlink !== 1n ||
        stat.dev !== BigInt(info.dev) ||
        stat.mtimeMs > BigInt(now.getTime())
      ) {
        skipped.push(name);
        continue;
      }
      try {
        const file = await open(
          join(pinned, name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const opened = await file.stat({ bigint: true });
          if (
            opened.dev !== stat.dev ||
            opened.ino !== stat.ino ||
            opened.ctimeNs !== stat.ctimeNs ||
            (await mountId(file.fd)) !== rootMount
          )
            throw new Error("Snapshot changed");
        } finally {
          await file.close();
        }
      } catch {
        skipped.push(name);
        continue;
      }
      const stamp = createHash("sha256")
        .update(
          `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
        )
        .digest("hex");
      namespace[name] = stamp;
      snapshots.push({
        name,
        stamp,
        size_bytes: Number(stat.size),
        device: String(stat.dev),
        inode: String(stat.ino),
        mtime_ns: String(stat.mtimeNs),
        mtime: Number(stat.mtimeMs),
      });
    }
    snapshots.sort((a, b) =>
      a.mtime_ns === b.mtime_ns
        ? a.name.localeCompare(b.name)
        : BigInt(a.mtime_ns) < BigInt(b.mtime_ns)
          ? 1
          : -1,
    );
    const seen = new Set<string>();
    const candidates = snapshots.filter((entry, index) => {
      const day = new Date(entry.mtime).toDateString();
      const daily = entry.mtime >= midnight.getTime() && !seen.has(day);
      seen.add(day);
      return index >= latest && !daily && entry.name !== referenced;
    });
    return {
      candidates,
      skipped,
      namespace,
      total_bytes: candidates.reduce((sum, file) => sum + file.size_bytes, 0),
    };
  } finally {
    await root.close();
  }
}
