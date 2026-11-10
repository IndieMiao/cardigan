import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Clock } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { startTimerLoop, type TimerLoop } from "./loop.js";
import { systemClock } from "./merge-loop.js";

/**
 * Attachment blob garbage collection (Phase 2 plan §7 leftover item 1; §9.3).
 *
 * Uploads publish the content-addressed blob before the domain transaction
 * decides whether the attachment may exist: a rejected upload keeps the file,
 * because another upload may share the same digest. Nothing else ever removed
 * those files, so `<dataDir>/attachments` grew without bound.
 *
 * The sweep only touches files that no project's attachment record references.
 * A 24-hour grace period keeps in-flight uploads safe — the blob exists before
 * its record does — and the reference check is repeated inside a transaction
 * immediately before each unlink, so a record written after the scan still wins.
 * Only regular files named like a sha256 digest are candidates: symlinks,
 * directories, temporary `.uuid.tmp` files and anything else stay put.
 */
export const DEFAULT_ATTACHMENT_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Blobs younger than this may belong to an upload that has no record yet. */
export const ATTACHMENT_GC_GRACE_MS = 24 * 60 * 60 * 1000;
/** Bound one sweep so a huge backlog is spread over several rounds. */
export const DEFAULT_ATTACHMENT_GC_LIMIT = 200;

const DIGEST = /^[a-f0-9]{64}$/u;

export interface AttachmentGcOptions {
  readonly dataDir: string;
  /** Only reads project ids and attachment rows; never closes the store. */
  readonly store: Pick<Store, "listProjects" | "uow">;
  readonly clock?: Clock;
  readonly graceMs?: number;
  readonly limit?: number;
  /** Operational log line; only counts and digest prefixes are reported. */
  readonly report?: (message: string) => void;
}

export interface AttachmentSweep {
  /** Files in the directory that were examined. */
  readonly scanned: number;
  /** Unreferenced, old, regular digest files that were candidates. */
  readonly candidates: number;
  /** Digests removed in this round. */
  readonly deleted: readonly string[];
  /** True when the per-round limit stopped the sweep early. */
  readonly truncated: boolean;
}

export class AttachmentGc {
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly options: AttachmentGcOptions) {}

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }
  private get directory(): string {
    return resolve(this.options.dataDir, "attachments");
  }
  private report(message: string): void {
    this.options.report?.(message);
  }

  /** Sweeps are serialized: two rounds never delete the same file twice. */
  tick(): Promise<AttachmentSweep> {
    const next = this.serial.then(() => this.sweep());
    this.serial = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Every digest a project still records: one read transaction per project. */
  private referenced(): Set<string> {
    const digests = new Set<string>();
    for (const project of this.options.store.listProjects()) {
      const attachments = this.options.store.uow.read((tx) =>
        tx.attachments.list(project.id),
      );
      for (const attachment of attachments) digests.add(attachment.sha256);
    }
    return digests;
  }

  /** Confirmation read for one digest, taken right before its unlink (§9.3). */
  private referencedNow(digest: string): boolean {
    for (const project of this.options.store.listProjects())
      if (
        this.options.store.uow.read((tx) =>
          tx.attachments
            .list(project.id)
            .some((attachment) => attachment.sha256 === digest),
        )
      )
        return true;
    return false;
  }

  private async sweep(): Promise<AttachmentSweep> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { scanned: 0, candidates: 0, deleted: [], truncated: false };
      throw error;
    }
    const now = Date.parse(this.clock.now());
    const grace = this.options.graceMs ?? ATTACHMENT_GC_GRACE_MS;
    const limit = this.options.limit ?? DEFAULT_ATTACHMENT_GC_LIMIT;
    if (!Number.isSafeInteger(grace) || grace < 0)
      throw new Error("Invalid attachment grace period");
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Invalid attachment sweep limit");

    const referenced = this.referenced();
    const candidates: { readonly digest: string; readonly mtimeMs: number }[] =
      [];
    for (const entry of entries) {
      // Directories, symlinks (even to regular files) and odd names are
      // skipped: readdir does not follow links, so a symlink is not a file.
      if (!entry.isFile()) continue;
      if (!DIGEST.test(entry.name)) continue;
      // The scan-level check avoids a stat for the common, referenced case.
      if (referenced.has(entry.name)) continue;
      const path = join(this.directory, entry.name);
      let stats: Stats;
      try {
        stats = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      // Re-check the type after the stat: a swap for a symlink must not pass.
      if (!stats.isFile()) continue;
      if (now - stats.mtimeMs < grace) continue;
      candidates.push({ digest: entry.name, mtimeMs: stats.mtimeMs });
    }
    candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);

    const deleted: string[] = [];
    for (const candidate of candidates.slice(0, limit)) {
      // §9.3: confirm inside a transaction right before removing the blob, so an
      // attachment recorded after the scan is never orphaned.
      if (this.referencedNow(candidate.digest)) continue;
      try {
        await unlink(join(this.directory, candidate.digest));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      deleted.push(candidate.digest);
    }
    const truncated = candidates.length > limit;
    if (deleted.length > 0 || truncated)
      this.report(
        `Attachment cleanup: removed ${deleted.length} orphaned blob(s)` +
          (deleted.length > 0
            ? ` (${deleted.map((digest) => digest.slice(0, 8)).join(", ")})`
            : "") +
          (truncated
            ? `; ${candidates.length - limit} more wait for the next round`
            : ""),
      );
    return {
      scanned: entries.length,
      candidates: candidates.length,
      deleted,
      truncated,
    };
  }
}

export interface AttachmentLoop {
  readonly executor: AttachmentGc;
  readonly loop: TimerLoop;
}

export function startAttachmentLoop(
  options: AttachmentGcOptions & {
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
    readonly onError?: (error: unknown) => void;
  },
): AttachmentLoop {
  const executor = new AttachmentGc(options);
  const loop = startTimerLoop({
    tick: () => executor.tick().then(() => undefined),
    intervalMs: options.intervalMs ?? DEFAULT_ATTACHMENT_GC_INTERVAL_MS,
    onError: options.onError ?? (() => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { executor, loop };
}
