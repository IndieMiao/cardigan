import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  setImmediate as nextTurn,
  setTimeout as sleep,
} from "node:timers/promises";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";
import { acquireRepositoryFlock } from "@cardigan/host";
import {
  ARTIFACT_BLOB_ID,
  artifactKey,
  attachmentKey,
  type Offsite,
  type OssClient,
  OssError,
  processLoopDelay,
  type SyncedLedger,
  type SyncStatus,
  writeSyncStatus,
} from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

/**
 * C-614: copy every recorded attachment blob and streamed artifact to the
 * private OSS bucket, after the fact and without ever blocking the write.
 *
 * The queue is the local files that a committed attachment record references
 * (the same rule the orphan sweep uses), minus the synced ledger of the
 * current target. Uploads made while OSS was down, the one-time backfill of
 * existing files, a restart in the middle of either and a switch to another
 * bucket all resume the same way. A blob whose upload was rejected, or not yet
 * committed, stays local only. Each object is hashed locally first (a corrupt
 * local file is never copied), uploaded with `x-oss-forbid-overwrite` and
 * `Content-MD5`, and only then recorded. Failures back off per object and show
 * on the host health page; while idle, OSS is probed at a bounded rate so an
 * outage or a revoked key still shows. Nothing is deleted locally or remotely.
 *
 * C-628: the backfill must not starve the host. Only one process at a time
 * scans and hashes (a host-wide flock; another holder means standby), each
 * tick is capped in files and bytes, reading for the hash and the upload is
 * paced and yields the event loop every few milliseconds, and the directory
 * listing is reused between rescans instead of being re-read every tick.
 */
const DIGEST = /^[a-f0-9]{64}$/u;
export const OFFSITE_SYNC_INTERVAL_MS = 30_000;
/** One tick stops starting new uploads after this long. */
export const OFFSITE_TICK_BUDGET_MS = 120_000;
const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
/** While nothing is uploaded, OSS is checked at most this often. */
export const OFFSITE_IDLE_PROBE_MS = 5 * 60_000;
const RECORDS_CACHE_MS = 60_000;
/** C-628: the data directories are re-listed at most this often. */
export const OFFSITE_RESCAN_MS = 60_000;
/** C-628: one tick starts at most this many uploads... */
export const OFFSITE_TICK_MAX_FILES = 200;
/** ...and at most this many bytes, though always at least one object. */
export const OFFSITE_TICK_MAX_BYTES = 512 * 1024 * 1024;
/** C-628: local bytes read (hash and upload) per second; 0 is unpaced. */
export const OFFSITE_READ_BYTES_PER_SECOND = 128 * 1024 * 1024;
/** C-628: hashing yields the event loop after this much continuous work. */
export const OFFSITE_SLICE_MS = 10;
const READ_CHUNK_BYTES = 256 * 1024;

/**
 * Hold the host-wide sync lock: a release function, or undefined while
 * another process (or another sync in this one) holds it.
 */
export type OffsiteSyncLock = () => Promise<(() => Promise<void>) | undefined>;
export const offsiteSyncLockPath = (dataDir: string) =>
  join(dataDir, "locks", "offsite-sync.lock");
/**
 * flock(2) on `<dataDir>/locks/offsite-sync.lock`, without waiting. Elsewhere
 * than Linux (development only) there is no cross-process layer.
 */
export function offsiteSyncFlock(dataDir: string): OffsiteSyncLock {
  return async () => {
    if (process.platform !== "linux") return async () => undefined;
    try {
      return await acquireRepositoryFlock(offsiteSyncLockPath(dataDir), 1);
    } catch (error) {
      if (error instanceof RepositoryLockTimeoutError) return undefined;
      throw error;
    }
  };
}

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
  readonly maxFilesPerTick?: number;
  readonly maxBytesPerTick?: number;
  /** 0 disables pacing; yielding still applies. */
  readonly readBytesPerSecond?: number;
  readonly sliceMs?: number;
  readonly rescanMs?: number;
  /** Defaults to `offsiteSyncFlock(offsite.dataDir)`. */
  readonly lock?: OffsiteSyncLock;
  /** Process role for the log lines (`background`, `server`). */
  readonly role?: string;
  /** One JSON-able line per lock change and per tick that uploaded. */
  readonly log?: (line: Readonly<Record<string, unknown>>) => void;
}

/**
 * C-628: reads at most `rate` bytes per second, and gives the event loop a
 * turn after `sliceMs` of continuous work, so hashing a 1 GB artifact never
 * holds the MCP endpoint for long.
 */
class Pacer {
  private readonly started = performance.now();
  private slice = performance.now();
  private bytes = 0;
  constructor(
    private readonly rate: number,
    private readonly sliceMs: number,
    private readonly signal: AbortSignal,
  ) {}
  async step(bytes: number) {
    this.bytes += bytes;
    const now = performance.now();
    if (this.rate > 0) {
      const due = this.started + (this.bytes / this.rate) * 1000 - now;
      if (due >= 1) {
        await sleep(due, undefined, { signal: this.signal });
        this.slice = performance.now();
        return;
      }
    }
    if (now - this.slice >= this.sliceMs) {
      await nextTurn(undefined, { signal: this.signal });
      this.slice = performance.now();
    }
  }
}

/** Fresh buffers of one file, paced; at most `size` bytes. */
async function* pacedChunks(file: FileHandle, size: number, pacer: Pacer) {
  let position = 0;
  while (position < size) {
    const buffer = Buffer.allocUnsafe(
      Math.min(READ_CHUNK_BYTES, size - position),
    );
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
    await pacer.step(bytesRead);
  }
}

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

interface Listing {
  readonly at: number;
  readonly target: string;
  readonly items: readonly Candidate[];
}

interface Records {
  readonly at: number;
  /** Digests of committed attachment records (not streamed artifacts). */
  readonly attachments: ReadonlySet<string>;
  /** Unexpired streamed artifacts by blob id. */
  readonly artifacts: ReadonlyMap<string, { sha256: string; size: number }>;
}

export class OffsiteSync {
  private failures = new Map<string, Failure>();
  private readonly abort = new AbortController();
  private target: string | undefined;
  private lastSuccess: string | undefined;
  /** Last time OSS answered at all (ms), for the idle probe. */
  private lastContact: number | undefined;
  private reachable = true;
  private more = false;
  private idleState: string | undefined;
  private records: Records | undefined;
  /** C-628: candidates of the last directory scan, reused until a rescan. */
  private listing: Listing | undefined;
  /** Size and mtime by path; blobs are content-addressed and never rewritten. */
  private stats = new Map<string, { size: number; mtime: number }>();
  private lockState: "owner" | "standby" | undefined;
  private readonly lock: OffsiteSyncLock;
  private pacer: Pacer | undefined;

  constructor(private readonly options: OffsiteSyncOptions) {
    this.lock = options.lock ?? offsiteSyncFlock(options.offsite.dataDir);
  }

  private log(line: Record<string, unknown>) {
    this.options.log?.({
      ...line,
      role: this.options.role ?? "server",
      pid: process.pid,
      ts: this.now().toISOString(),
    });
  }

  private noteLock(state: "owner" | "standby") {
    if (this.lockState === state) return;
    this.lockState = state;
    this.log({ event: "offsite_sync_lock", state });
  }

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

  /**
   * One round under the host-wide lock. While another process holds it this
   * one stays on standby: no scan, no hash, no upload and no status write.
   */
  async tick(): Promise<void> {
    if (this.abort.signal.aborted) return;
    const release = await this.lock();
    if (!release) {
      this.more = false;
      this.noteLock("standby");
      return;
    }
    this.noteLock("owner");
    try {
      await this.round();
    } finally {
      await release();
    }
  }

  private async round(): Promise<void> {
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
    const target = offsite.target();
    if (!client || !target) return;
    // Another bucket (or endpoint, or region) starts over: its own ledger,
    // failures and reachability.
    if (target !== this.target) {
      this.target = target;
      this.failures = new Map();
      this.lastSuccess = undefined;
      this.lastContact = undefined;
      this.reachable = true;
      this.listing = undefined;
    }
    // The ledger and client of this target, even if the file changes mid-tick.
    const ledger = offsite.ledger.refresh();
    const pending = await this.candidates(ledger, target);
    const started = Date.now();
    const budget = this.options.tickBudgetMs ?? OFFSITE_TICK_BUDGET_MS;
    const maxFiles = this.options.maxFilesPerTick ?? OFFSITE_TICK_MAX_FILES;
    const maxBytes = this.options.maxBytesPerTick ?? OFFSITE_TICK_MAX_BYTES;
    this.pacer = new Pacer(
      this.options.readBytesPerSecond ?? OFFSITE_READ_BYTES_PER_SECOND,
      this.options.sliceMs ?? OFFSITE_SLICE_MS,
      this.abort.signal,
    );
    let done = 0,
      attempted = 0,
      bytes = 0;
    const gone = new Set<string>();
    for (const item of pending) {
      if (this.abort.signal.aborted || Date.now() - started > budget) break;
      const failure = this.failures.get(item.key);
      if (failure && failure.next > this.now().getTime()) continue;
      // The first object always goes, however large; then the caps apply.
      if (
        attempted > 0 &&
        (attempted >= maxFiles || bytes + item.size > maxBytes)
      )
        break;
      attempted++;
      bytes += item.size;
      try {
        await this.upload(item, client, ledger);
        this.failures.delete(item.key);
        this.lastSuccess = this.now().toISOString();
        this.lastContact = this.now().getTime();
        this.reachable = true;
        done++;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        // Removed since the last scan: no longer queued, not a failure.
        if (missing(error)) {
          gone.add(item.key);
          this.failures.delete(item.key);
          continue;
        }
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
        // Any other answer came from OSS.
        if (error instanceof OssError) this.lastContact = this.now().getTime();
      }
    }
    // Nothing was tried: a HEAD of an arbitrary key (404 counts as reachable)
    // tells whether an earlier outage is over, or whether an idle copy has
    // lost its connection or key since. Every tick while down, otherwise at
    // most once per `OFFSITE_IDLE_PROBE_MS`.
    const now = this.now().getTime();
    if (
      attempted === 0 &&
      !this.abort.signal.aborted &&
      (!this.reachable ||
        this.lastContact === undefined ||
        now - this.lastContact >= OFFSITE_IDLE_PROBE_MS ||
        now < this.lastContact)
    ) {
      this.reachable = await client
        .head(attachmentKey("0".repeat(64)), this.abort.signal)
        .then(
          () => true,
          () => false,
        );
      offsite.usage.add({ requests: 1 });
      if (this.reachable) this.lastContact = now;
    }
    if (gone.size && this.listing)
      this.listing = {
        ...this.listing,
        items: this.listing.items.filter((c) => !gone.has(c.key)),
      };
    const remaining = pending.filter(
      (c) => !ledger.get(c.key) && !gone.has(c.key),
    );
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
    if (attempted > 0)
      this.log({
        event: "offsite_sync_tick",
        attempted,
        uploaded: done,
        bytes,
        pending: remaining.length,
        duration_ms: Date.now() - started,
        loop_p99_ms: processLoopDelay().snapshot()?.p99_ms ?? null,
      });
  }

  private status(
    configured: SyncStatus["configured"],
    remaining: readonly Candidate[],
  ): SyncStatus {
    let last: Failure | undefined;
    for (const f of this.failures.values())
      if (!last || f.at > last.at) last = f;
    const delay = processLoopDelay().snapshot();
    return {
      checked_at: this.now().toISOString(),
      ...(configured === "ready" && this.target ? { target: this.target } : {}),
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
      ...(delay ? { loop_delay: delay } : {}),
    };
  }

  /**
   * Recorded local files not yet in `ledger`; attachments first, oldest
   * first. Blobs without a committed record are never copied. The listing of
   * the last scan is reused for `OFFSITE_RESCAN_MS` (C-628); a file written
   * or committed meanwhile waits for the next scan, a removed one leaves the
   * queue when its upload finds it gone.
   */
  private async candidates(
    ledger: SyncedLedger,
    target: string,
  ): Promise<Candidate[]> {
    const at = this.now().getTime();
    const listing = this.listing;
    if (
      listing &&
      listing.target === target &&
      at - listing.at < (this.options.rescanMs ?? OFFSITE_RESCAN_MS) &&
      at >= listing.at
    )
      return listing.items.filter((c) => !ledger.get(c.key));
    const items = await this.scan(ledger);
    this.listing = { at, target, items };
    return [...items];
  }

  private async scan(ledger: SyncedLedger): Promise<Candidate[]> {
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
    const stats = new Map<string, { size: number; mtime: number }>();
    const stat = async (path: string) => {
      const known = this.stats.get(path);
      if (known) {
        stats.set(path, known);
        return known;
      }
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile()) return undefined;
      const value = { size: info.size, mtime: info.mtimeMs };
      stats.set(path, value);
      return value;
    };
    const out: (Candidate & { mtime: number; order: number })[] = [];
    const attachmentsDir = join(dataDir, "attachments");
    const digests = (await list(attachmentsDir, DIGEST)).filter(
      (e) => !ledger.get(attachmentKey(e.name)),
    );
    const artifactsDir = join(dataDir, "artifacts");
    const blobs = (await list(artifactsDir, ARTIFACT_BLOB_ID)).filter(
      (e) => !ledger.get(artifactKey(e.name)),
    );
    if (!digests.length && !blobs.length) {
      this.stats = stats;
      return [];
    }
    const records = this.recorded();
    for (const e of digests) {
      // No committed record (rejected, in flight or orphaned): stays local.
      if (!records.attachments.has(e.name)) continue;
      const path = join(attachmentsDir, e.name);
      const info = await stat(path);
      if (!info) continue;
      out.push({
        key: attachmentKey(e.name),
        path,
        sha256: e.name,
        size: info.size,
        mtime: info.mtime,
        order: 0,
      });
    }
    for (const e of blobs) {
      const record = records.artifacts.get(e.name);
      // No record yet (upload in flight or never committed) or expired.
      if (!record) continue;
      const path = join(artifactsDir, e.name);
      const info = await stat(path);
      if (!info) continue;
      out.push({
        key: artifactKey(e.name),
        path,
        sha256: record.sha256,
        size: record.size,
        mtime: info.mtime,
        order: 1,
      });
    }
    // Only files still queued keep a cached stat.
    this.stats = stats;
    return out
      .sort((a, b) => a.order - b.order || a.mtime - b.mtime)
      .map(({ key, path, sha256, size }) => ({ key, path, sha256, size }));
  }

  /**
   * Committed records, re-read at most once a minute (files without a record
   * wait until it is committed). One read transaction per project.
   */
  private recorded(): Records {
    const at = this.now().getTime();
    if (
      this.records &&
      at - this.records.at < RECORDS_CACHE_MS &&
      at >= this.records.at
    )
      return this.records;
    const attachments = new Set<string>();
    const artifacts = new Map<string, { sha256: string; size: number }>();
    for (const project of this.options.store.listProjects())
      for (const a of this.options.store.uow.read((tx) =>
        tx.attachments.list(project.id),
      )) {
        if (!a.streamed_artifact) {
          attachments.add(a.sha256);
          // C-683: a video's cover frame is a blob of its own.
          if (a.video?.poster_sha256) attachments.add(a.video.poster_sha256);
        } else if (!a.streamed_artifact.expired)
          artifacts.set(a.streamed_artifact.blob_id, {
            sha256: a.sha256,
            size: a.size,
          });
      }
    this.records = { at, attachments, artifacts };
    return this.records;
  }

  /** Stream the existing object and compare its length and SHA-256. */
  private async verifyRemote(client: OssClient, item: Candidate) {
    const { offsite } = this.options;
    let bytes = 0;
    try {
      const res = await client.get(
        item.key,
        Math.max(120_000, Math.ceil(item.size / 1024)),
        this.abort.signal,
      );
      const hash = createHash("sha256");
      try {
        for await (const chunk of res as AsyncIterable<Buffer>) {
          bytes += chunk.length;
          if (bytes > item.size) throw new OssError("integrity");
          hash.update(chunk);
          await this.pace(chunk.length);
        }
      } finally {
        res.destroy();
      }
      if (bytes !== item.size || hash.digest("hex") !== item.sha256)
        throw new OssError("integrity");
    } catch (error) {
      if (error instanceof OssError) throw error;
      // A body cut off mid-stream: try again later like any other outage.
      throw new OssError("network");
    } finally {
      offsite.usage.add({ requests: 1, egress_bytes: bytes });
    }
  }

  private pace(bytes: number) {
    return this.pacer?.step(bytes);
  }
  private chunks(file: FileHandle, size: number) {
    this.pacer ??= new Pacer(0, OFFSITE_SLICE_MS, this.abort.signal);
    return pacedChunks(file, size, this.pacer);
  }

  private async upload(
    item: Candidate,
    client: OssClient,
    ledger: SyncedLedger,
  ) {
    const { offsite } = this.options;
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
      // Paced and yielding (C-628); one byte past the record is enough to
      // tell that the file grew.
      for await (const chunk of this.chunks(file, item.size + 1)) {
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
        Readable.from(this.chunks(file, item.size), { objectMode: false }),
        meta,
        this.abort.signal,
      );
      offsite.usage.add({ requests: 1 });
      if (result === "exists") {
        // Never overwritten or deleted: the object counts as a copy only if
        // its actual content hashes to the recorded digest. Metadata alone
        // (size, `x-oss-meta-sha256`) can match a damaged body.
        await this.verifyRemote(client, item);
      }
      ledger.record({
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
