import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ARTIFACT_BLOB_ID,
  artifactKey,
  attachmentKey,
  type Offsite,
  OssError,
  type SyncStatus,
  writeSyncStatus,
} from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

/**
 * C-614: copy every local attachment blob and streamed artifact to the
 * private OSS bucket, after the fact and without ever blocking the write.
 *
 * The queue is the difference between the local files and the synced ledger,
 * so uploads made while OSS was down, the one-time backfill of existing files
 * and a restart in the middle of either all resume the same way. Each object
 * is hashed locally first (a corrupt local file is never copied), uploaded
 * with `x-oss-forbid-overwrite` and `Content-MD5`, and only then recorded.
 * Failures back off per object and show on the host health page; nothing is
 * deleted locally or remotely.
 */
const DIGEST = /^[a-f0-9]{64}$/u;
export const OFFSITE_SYNC_INTERVAL_MS = 30_000;
/** One tick stops starting new uploads after this long. */
export const OFFSITE_TICK_BUDGET_MS = 120_000;
const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

interface Candidate {
  readonly key: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}
interface Failure {
  readonly count: number;
  readonly next: number;
  readonly code: string;
  readonly at: string;
}

export interface OffsiteSyncOptions {
  readonly offsite: Offsite;
  /** Read-only: maps an artifact file back to its recorded size and digest. */
  readonly store: Pick<Store, "listProjects" | "uow">;
  readonly now?: () => Date;
  readonly tickBudgetMs?: number;
}

export class OffsiteSync {
  private readonly failures = new Map<string, Failure>();
  private readonly abort = new AbortController();
  private lastSuccess: string | undefined;
  private reachable = true;
  private more = false;
  private idleState: string | undefined;
  private records:
    | { at: number; map: Map<string, { sha256: string; size: number }> }
    | undefined;

  constructor(private readonly options: OffsiteSyncOptions) {}

  private get now() {
    return this.options.now ?? (() => new Date());
  }
  /** More work is queued and OSS answered: run the next tick soon. */
  get continueSoon() {
    return this.more && this.reachable;
  }

  /** Abort an upload in flight; used on shutdown. */
  stop() {
    this.abort.abort();
  }

  async tick(): Promise<void> {
    const { offsite } = this.options;
    const config = offsite.config();
    const dataDir = offsite.dataDir;
    if (config.state !== "ready") {
      this.more = false;
      // Written once per change, so a host without OSS keeps a quiet disk.
      if (this.idleState !== config.state)
        writeSyncStatus(dataDir, this.status(config.state, []));
      this.idleState = config.state;
      return;
    }
    this.idleState = undefined;
    const client = offsite.client();
    if (!client) return;
    offsite.ledger.refresh();
    const pending = await this.candidates();
    const started = Date.now();
    const budget = this.options.tickBudgetMs ?? OFFSITE_TICK_BUDGET_MS;
    let done = 0,
      attempted = 0;
    for (const item of pending) {
      if (this.abort.signal.aborted || Date.now() - started > budget) break;
      const failure = this.failures.get(item.key);
      if (failure && failure.next > this.now().getTime()) continue;
      attempted++;
      try {
        await this.upload(item);
        this.failures.delete(item.key);
        this.lastSuccess = this.now().toISOString();
        this.reachable = true;
        done++;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        const code =
          error instanceof OssError ? error.code : "local_unreadable";
        const count = (failure?.count ?? 0) + 1;
        this.failures.set(item.key, {
          count,
          code,
          at: this.now().toISOString(),
          next:
            this.now().getTime() +
            Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (count - 1)),
        });
        // OSS itself is unavailable: stop for this tick instead of trying
        // every other object against the same outage.
        if (code === "network" || code === "timeout" || code === "denied") {
          this.reachable = false;
          break;
        }
      }
    }
    // Nothing was due: a HEAD of an arbitrary key (404 counts as reachable)
    // tells whether an earlier outage is over, so signed URLs resume.
    if (!this.reachable && attempted === 0 && !this.abort.signal.aborted)
      this.reachable = await client
        .head(attachmentKey("0".repeat(64)), this.abort.signal)
        .then(
          () => true,
          () => false,
        );
    const remaining = pending.filter((c) => !offsite.ledger.get(c.key));
    // Forget failures of objects that are no longer queued.
    const queued = new Set(remaining.map((c) => c.key));
    for (const key of this.failures.keys())
      if (!queued.has(key)) this.failures.delete(key);
    this.more =
      done > 0 &&
      remaining.some(
        (c) => (this.failures.get(c.key)?.next ?? 0) <= this.now().getTime(),
      );
    writeSyncStatus(dataDir, this.status("ready", remaining));
  }

  private status(
    configured: SyncStatus["configured"],
    remaining: readonly Candidate[],
  ): SyncStatus {
    let last: Failure | undefined;
    for (const f of this.failures.values())
      if (!last || f.at > last.at) last = f;
    return {
      checked_at: this.now().toISOString(),
      configured,
      pending: {
        count: remaining.length,
        bytes: remaining.reduce((sum, c) => sum + c.size, 0),
      },
      failed: {
        count: this.failures.size,
        ...(last ? { last_code: last.code, last_at: last.at } : {}),
      },
      ...(this.lastSuccess ? { last_success_at: this.lastSuccess } : {}),
      reachable: configured === "ready" ? this.reachable : true,
    };
  }

  /** Local files not yet in the ledger; attachments first, oldest first. */
  private async candidates(): Promise<Candidate[]> {
    const { offsite } = this.options;
    const dataDir = offsite.dataDir;
    const list = async (dir: string, pattern: RegExp) => {
      try {
        return (await readdir(dir, { withFileTypes: true })).filter(
          (e) => e.isFile() && pattern.test(e.name),
        );
      } catch {
        return [];
      }
    };
    const out: (Candidate & { mtime: number; order: number })[] = [];
    const attachmentsDir = join(dataDir, "attachments");
    for (const e of await list(attachmentsDir, DIGEST)) {
      if (offsite.ledger.get(attachmentKey(e.name))) continue;
      const info = await lstat(join(attachmentsDir, e.name)).catch(
        () => undefined,
      );
      if (!info?.isFile()) continue;
      out.push({
        key: attachmentKey(e.name),
        path: join(attachmentsDir, e.name),
        sha256: e.name,
        size: info.size,
        mtime: info.mtimeMs,
        order: 0,
      });
    }
    const artifactsDir = join(dataDir, "artifacts");
    const blobs = (await list(artifactsDir, ARTIFACT_BLOB_ID)).filter(
      (e) => !offsite.ledger.get(artifactKey(e.name)),
    );
    if (blobs.length) {
      const records = this.artifactRecords();
      for (const e of blobs) {
        const record = records.get(e.name);
        // No record yet (upload in flight or never committed) or expired.
        if (!record) continue;
        const info = await lstat(join(artifactsDir, e.name)).catch(
          () => undefined,
        );
        if (!info?.isFile()) continue;
        out.push({
          key: artifactKey(e.name),
          path: join(artifactsDir, e.name),
          sha256: record.sha256,
          size: record.size,
          mtime: info.mtimeMs,
          order: 1,
        });
      }
    }
    return out
      .sort((a, b) => a.order - b.order || a.mtime - b.mtime)
      .map(({ key, path, sha256, size }) => ({ key, path, sha256, size }));
  }

  /** Re-read at most once a minute: artifact files without a record wait. */
  private artifactRecords() {
    const at = this.now().getTime();
    if (this.records && at - this.records.at < 60_000 && at >= this.records.at)
      return this.records.map;
    const records = new Map<string, { sha256: string; size: number }>();
    for (const project of this.options.store.listProjects())
      for (const a of this.options.store.uow.read((tx) =>
        tx.attachments.list(project.id),
      ))
        if (a.streamed_artifact && !a.streamed_artifact.expired)
          records.set(a.streamed_artifact.blob_id, {
            sha256: a.sha256,
            size: a.size,
          });
    this.records = { at, map: records };
    return records;
  }

  private async upload(item: Candidate) {
    const { offsite } = this.options;
    const client = offsite.client();
    if (!client) throw new OssError("rejected");
    const file = await open(
      item.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== item.size)
        throw new OssError("integrity");
      const sha = createHash("sha256"),
        md5 = createHash("md5");
      let bytes = 0;
      for await (const chunk of file.createReadStream({
        start: 0,
        autoClose: false,
      }) as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        sha.update(chunk);
        md5.update(chunk);
      }
      // A local file that does not match its name or record is never copied.
      if (bytes !== item.size || sha.digest("hex") !== item.sha256)
        throw new OssError("integrity");
      const meta = {
        size: item.size,
        sha256: item.sha256,
        md5: md5.digest("base64"),
      };
      const result = await client.put(
        item.key,
        file.createReadStream({ start: 0, autoClose: false }),
        meta,
        this.abort.signal,
      );
      offsite.usage.add({ requests: 1 });
      if (result === "exists") {
        // Never overwritten: accept the object only if it is the same bytes.
        const head = await client.head(item.key, this.abort.signal);
        offsite.usage.add({ requests: 1 });
        if (head?.size !== item.size || head.sha256 !== item.sha256)
          throw new OssError("integrity");
      }
      offsite.ledger.record({
        key: item.key,
        sha256: item.sha256,
        size: item.size,
        at: this.now().toISOString(),
      });
    } finally {
      await file.close();
    }
  }
}
