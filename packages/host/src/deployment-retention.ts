import { constants } from "node:fs";
import { chmod, lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Store } from "@cardigan/store";
import { requireHostDirectory } from "./deployment-config.js";
import type { RetentionPolicy } from "./deployment-retention-policy.js";
import { previewDeploymentSnapshots } from "./deployment-snapshot-retention.js";

const project = "cardigan";
export const RETENTION_ROUND = "host_retention_round";
const releaseName =
  /^release-[a-f0-9]{40}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const LISTED = 100;

export interface Ready {
  stillReady: () => Promise<boolean>;
  /** Paths `state.json` and the supervisor itself use; never removed. */
  keep: readonly string[];
  backup?: string;
  attempt: string;
  deployed_at: string;
}
interface Item {
  kind: "release" | "snapshot";
  name: string;
  stamp: string;
}
interface Round {
  started_at: string;
  removed: { kind: Item["kind"]; name: string; freed_bytes: number }[];
  failed: string[];
  kept_releases: number;
}

/** Top-level release directory names referenced by the given absolute paths. */
export function releaseKeep(directory: string, paths: readonly string[]) {
  const keep = new Set<string>();
  for (const value of paths) {
    if (!value || resolve(value) !== value)
      throw new Error("Unknown deployment reference");
    const prefix = `${directory}/`;
    if (value.startsWith(prefix))
      keep.add(value.slice(prefix.length).split("/")[0] ?? "");
  }
  return [...keep];
}

/**
 * Remove (or, with `dryRun`, measure) a host-owned tree without following a
 * symlink or leaving its file system. Returns the allocated bytes freed;
 * hard-linked files count only when this was their last name.
 */
export async function removeTree(
  path: string,
  dev: bigint,
  dryRun = false,
): Promise<number> {
  const st = await lstat(path, { bigint: true });
  if (!st.isDirectory()) {
    if (!dryRun) await unlink(path);
    return st.nlink <= 1n ? Number(st.blocks * 512n) : 0;
  }
  if (st.dev !== dev) throw new Error("Release crosses a mount");
  if (!dryRun && st.uid === BigInt(process.getuid?.() ?? -1))
    if ((st.mode & 0o700n) !== 0o700n)
      await chmod(path, Number(st.mode & 0o7777n) | 0o700);
  let freed = Number(st.blocks * 512n);
  for (const name of await readdir(path))
    freed += await removeTree(join(path, name), dev, dryRun);
  if (!dryRun) await rmdir(path);
  return freed;
}

/**
 * C-743: after each successful deployment, prune old releases (keep the
 * newest `release_keep` plus every referenced one) and automatic database
 * snapshots (keep `backup_days` and at least `backup_min`). One item per
 * supervisor tick, so a backlog never holds deployment capacity; one
 * `host_retention_round` event summarizes each round.
 */
export class DeploymentRetention {
  private attempt = "";
  private finished = "";
  private queue: Item[] = [];
  private round?: Round;
  constructor(
    private readonly store: Store,
    private readonly dir: string,
    private readonly policy: RetentionPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  private async releases(keep: ReadonlySet<string>) {
    await requireHostDirectory(this.dir);
    const root = await lstat(this.dir, { bigint: true });
    if (root.uid !== BigInt(process.getuid?.() ?? -1) || root.mode & 0o077n)
      throw new Error("Unsafe deployment directory");
    const found: { name: string; mtime: bigint; stamp: string }[] = [];
    for (const name of await readdir(this.dir)) {
      if (!releaseName.test(name)) continue;
      const st = await lstat(join(this.dir, name), { bigint: true }).catch(
        () => undefined,
      );
      if (
        st?.isDirectory() &&
        st.uid === root.uid &&
        !(st.mode & 0o077n) &&
        st.dev === root.dev
      )
        found.push({ name, mtime: st.mtimeNs, stamp: `${st.dev}:${st.ino}` });
    }
    found.sort((a, b) =>
      a.mtime === b.mtime
        ? b.name.localeCompare(a.name)
        : a.mtime < b.mtime
          ? 1
          : -1,
    );
    const items = found
      .filter((r, i) => i >= this.policy.release_keep && !keep.has(r.name))
      .map<Item>((r) => ({ kind: "release", name: r.name, stamp: r.stamp }));
    return { items, kept: found.length - items.length };
  }
  private snapshots(ready: Ready) {
    return previewDeploymentSnapshots(this.dir, ready.backup, {
      latest: this.policy.backup_min,
      days: this.policy.backup_days,
      now: new Date(this.now()),
    });
  }

  async poll(ready: Ready) {
    if (ready.attempt !== this.attempt) {
      this.attempt = ready.attempt;
      this.queue = [];
      delete this.round;
    }
    if (this.finished === ready.attempt) return;
    if (!this.round) {
      const releases = await this.releases(
        new Set(releaseKeep(this.dir, ready.keep)),
      );
      const snapshots = await this.snapshots(ready);
      this.queue = [
        ...releases.items,
        ...snapshots.candidates.map<Item>((s) => ({
          kind: "snapshot",
          name: s.name,
          stamp: s.stamp,
        })),
      ];
      this.round = {
        started_at: new Date(this.now()).toISOString(),
        removed: [],
        failed: [],
        kept_releases: releases.kept,
      };
    }
    const round = this.round;
    const item = this.queue.shift();
    if (!item) return this.finish();
    if (!(await ready.stillReady())) {
      // The next poll plans again against the then-current deployment.
      this.queue = [];
      delete this.round;
      return;
    }
    const preview = this.policy.mode === "preview";
    try {
      const freed =
        item.kind === "release"
          ? await this.release(item, ready, preview)
          : await this.snapshot(item, ready, preview);
      if (freed === undefined) return;
      round.removed.push({
        kind: item.kind,
        name: item.name,
        freed_bytes: freed,
      });
    } catch {
      round.failed.push(item.name);
    }
    if (!this.queue.length) this.finish();
  }
  private async release(item: Item, ready: Ready, preview: boolean) {
    // Recheck against the references at this tick, not the plan's.
    if (releaseKeep(this.dir, ready.keep).includes(item.name)) return;
    const path = join(this.dir, item.name);
    const st = await lstat(path, { bigint: true });
    if (!st.isDirectory() || `${st.dev}:${st.ino}` !== item.stamp)
      throw new Error("Release changed");
    return removeTree(path, st.dev, preview);
  }
  private async snapshot(item: Item, ready: Ready, preview: boolean) {
    const fresh = (await this.snapshots(ready)).candidates.find(
      (s) => s.name === item.name,
    );
    if (!fresh || fresh.stamp !== item.stamp) return;
    if (!preview) {
      // Pin the verified file: unlink only while the name still is that inode.
      const fd = await open(
        join(this.dir, item.name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const st = await fd.stat({ bigint: true });
        if (`${st.dev}` !== fresh.device || `${st.ino}` !== fresh.inode)
          throw new Error("Snapshot changed");
        await unlink(join(this.dir, item.name));
      } finally {
        await fd.close();
      }
    }
    return fresh.size_bytes;
  }
  private finish() {
    const round = this.round;
    this.finished = this.attempt;
    this.queue = [];
    delete this.round;
    if (!round || (!round.removed.length && !round.failed.length)) return;
    const preview = this.policy.mode === "preview";
    const sum = (kind?: Item["kind"]) =>
      round.removed
        .filter((r) => !kind || r.kind === kind)
        .reduce((n, r) => n + r.freed_bytes, 0);
    const count = (kind: Item["kind"]) =>
      round.removed.filter((r) => r.kind === kind).length;
    const freed = sum();
    const gb = `${(freed / 1024 ** 3).toFixed(1)} GB`;
    const notice = `${preview ? "预览：可" : "已"}清理旧发布 ${count("release")} 个、数据库备份 ${count("snapshot")} 份，${preview ? "约可" : ""}腾出 ${gb}${round.failed.length ? `；${round.failed.length} 项未能删除，下次部署后重试` : ""}`;
    this.store.uow.run((tx) =>
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project),
        type: RETENTION_ROUND,
        actor: { kind: "system", project_id: project },
        created_at: new Date(this.now()).toISOString(),
        payload: {
          scope: "deployment",
          mode: this.policy.mode,
          attempt: this.attempt,
          started_at: round.started_at,
          policy: {
            release_keep: this.policy.release_keep,
            backup_days: this.policy.backup_days,
            backup_min: this.policy.backup_min,
          },
          releases: { removed: count("release"), freed_bytes: sum("release") },
          snapshots: {
            removed: count("snapshot"),
            freed_bytes: sum("snapshot"),
          },
          kept_releases: round.kept_releases,
          removed: round.removed.length,
          freed_bytes: freed,
          names: round.removed.slice(0, LISTED).map((r) => r.name),
          failed: round.failed.slice(0, LISTED),
          notice,
        },
      }),
    );
  }
}
