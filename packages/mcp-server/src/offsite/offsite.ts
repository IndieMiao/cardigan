import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type OffsiteConfig, readOffsiteConfig } from "./config.js";
import {
  bucketOrigin,
  OssClient,
  type OssCredentials,
  OssError,
  type OssTransport,
} from "./oss.js";
import {
  monthUsage,
  readSyncStatus,
  type SyncedEntry,
  SyncedLedger,
  type SyncStatus,
  UsageMeter,
  usageMonth,
} from "./state.js";

/**
 * C-614: one process's view of the off-site copy. The local data directory
 * stays the primary store; this only adds a second copy and a second way to
 * fetch it. Every method degrades to "not available" instead of throwing, so
 * an absent, misconfigured or unreachable OSS never blocks an upload, a read,
 * a review or a dispatch.
 */
export interface OffsiteOptions {
  readonly dataDir: string;
  /** `<config dir>/storage` */
  readonly storageDir: string;
  /** Usage file suffix: `web`, `background` or `server`. */
  readonly role: string;
  readonly now?: () => Date;
  readonly transport?: OssTransport;
}

export const attachmentKey = (digest: string) => `attachments/${digest}`;
export const artifactKey = (blobId: string) => `artifacts/${blobId}`;

/** OSS renders the grid thumbnail: 480 px wide at most, top 4:3 kept, WebP. */
export const THUMBNAIL_PROCESS =
  "image/auto-orient,1/resize,w_480,limit_1/crop,w_480,h_640,g_north/format,webp/quality,q_75";
/** Lightbox preview: bounded width, original format. */
export const PREVIEW_PROCESS = "image/auto-orient,1/resize,w_2048,limit_1";
const THUMBNAIL_ESTIMATE_BYTES = 64 * 1024;
const CONFIG_CACHE_MS = 30_000;
/** A key OSS answered 404 for is not asked again for this long. */
const MISSING_RETRY_MS = 10 * 60_000;
const MISSING_LIMIT = 10_000;

/**
 * Identity of one off-site target: endpoint, bucket and region. The ledger and
 * the sync status are kept per target, so a copy in one bucket never counts as
 * a copy in another.
 */
export function offsiteTarget(
  c: Pick<OssCredentials, "bucket" | "region" | "endpoint">,
) {
  const origin = (c.endpoint ?? bucketOrigin(c)).replace(/\/$/u, "");
  return createHash("sha256")
    .update(`${origin}\n${c.bucket}\n${c.region}`)
    .digest("hex")
    .slice(0, 16);
}
/** Ledger of a host without a valid configuration; nothing is recorded there. */
const NO_TARGET = "0".repeat(16);

/** One target's client and ledger, fixed for the length of a read. */
interface Source {
  readonly client: OssClient;
  readonly target: string;
  readonly ledger: SyncedLedger;
}

/** A signed URL and how many more seconds it stays valid. */
export interface SignedLink {
  readonly url: string;
  readonly valid_for_seconds: number;
}

export class Offsite {
  readonly dataDir: string;
  readonly usage: UsageMeter;
  private cached:
    | { at: number; value: OffsiteConfig; client?: OssClient }
    | undefined;
  private readonly now: () => Date;
  private readonly ledgers = new Map<string, SyncedLedger>();
  /** Keys OSS did not have, until when they are not asked again. */
  private readonly missing = new Map<string, number>();

  constructor(private readonly options: OffsiteOptions) {
    this.dataDir = resolve(options.dataDir);
    this.now = options.now ?? (() => new Date());
    this.usage = new UsageMeter(this.dataDir, options.role, this.now);
  }

  /** Target of the current configuration, or undefined without a valid one. */
  target(): string | undefined {
    const c = this.config();
    return c.state === "ready"
      ? offsiteTarget(c.settings.credentials)
      : undefined;
  }

  /** Verified objects of the current target (empty without a configuration). */
  get ledger(): SyncedLedger {
    return this.ledgerFor(this.target() ?? NO_TARGET);
  }

  private ledgerFor(target: string): SyncedLedger {
    let ledger = this.ledgers.get(target);
    if (!ledger) {
      ledger = new SyncedLedger(this.dataDir, target);
      this.ledgers.set(target, ledger);
    }
    return ledger;
  }

  config(): OffsiteConfig {
    const at = this.now().getTime();
    if (
      !this.cached ||
      at - this.cached.at >= CONFIG_CACHE_MS ||
      at < this.cached.at
    ) {
      const value = readOffsiteConfig(this.options.storageDir);
      this.cached = {
        at,
        value,
        ...(value.state === "ready"
          ? {
              client: new OssClient(
                value.settings.credentials,
                this.options.transport,
                this.now,
              ),
            }
          : {}),
      };
    }
    return this.cached.value;
  }

  client(): OssClient | undefined {
    this.config();
    return this.cached?.client;
  }

  /** The bucket origin browsers must be allowed to load images from. */
  imageOrigin(): string | undefined {
    const c = this.config();
    if (c.state !== "ready") return undefined;
    const { bucket, region, endpoint } = c.settings.credentials;
    return endpoint ?? `https://${bucket}.oss-${region}.aliyuncs.com`;
  }

  /** A verified copy of `key` in the current target, when OSS is configured. */
  synced(key: string): SyncedEntry | undefined {
    if (this.config().state !== "ready") return undefined;
    return this.ledger.refresh().get(key);
  }

  /** The background sync's last status, if it describes the current target. */
  private syncStatus(): SyncStatus | undefined {
    const status = readSyncStatus(this.dataDir);
    return status && status.target === this.target() ? status : undefined;
  }

  private reachable() {
    return this.syncStatus()?.reachable !== false;
  }

  /**
   * Where to read `key` from: the client, target and ledger of the current
   * configuration, taken together once. A read keeps this source to the end,
   * so a configuration switched to another bucket meanwhile never receives
   * its result. Undefined when OSS is not configured, known to be down, or
   * answered "missing" for this key in this target recently. Without a ledger
   * entry (for example after the data directory was restored) the
   * deterministic key is still tried; the caller's record supplies the digest
   * the bytes must match.
   */
  private source(key: string): Source | undefined {
    const config = this.config();
    const client = this.cached?.client;
    if (config.state !== "ready" || !client || !this.reachable())
      return undefined;
    const target = offsiteTarget(config.settings.credentials);
    const missing = `${target}/${key}`;
    const until = this.missing.get(missing);
    if (until !== undefined) {
      if (until > this.now().getTime()) return undefined;
      this.missing.delete(missing);
    }
    return { client, target, ledger: this.ledgerFor(target).refresh() };
  }

  private noteMissing(source: Source, key: string, error: unknown) {
    if (!(error instanceof OssError && error.code === "not_found")) return;
    if (this.missing.size >= MISSING_LIMIT) this.missing.clear();
    this.missing.set(
      `${source.target}/${key}`,
      this.now().getTime() + MISSING_RETRY_MS,
    );
  }

  /**
   * A verified read proves the copy in the target it came from (never the
   * current one, if that changed meanwhile): later reads may use signed URLs.
   */
  private remember(source: Source, key: string, sha256: string, size: number) {
    if (source.ledger.refresh().get(key)) return;
    try {
      source.ledger.record({
        key,
        sha256,
        size,
        at: this.now().toISOString(),
      });
    } catch {
      // Only the bookkeeping is lost; the verified bytes are still used.
    }
  }

  /**
   * A signed GET URL for one verified object, or undefined. `stable` rounds
   * the signing time so a page reload reuses the same URL (and the browser's
   * cache) for at least half the lifetime.
   */
  signedUrl(
    key: string,
    options: {
      readonly query?: Readonly<Record<string, string>>;
      readonly stable?: boolean;
      readonly usage?: { egress: number; process?: number };
    } = {},
  ): SignedLink | undefined {
    const entry = this.synced(key);
    const config = this.config();
    const client = this.client();
    if (!entry || config.state !== "ready" || !client || !this.reachable())
      return undefined;
    const ttl = config.settings.signed_url_ttl_seconds;
    const now = this.now().getTime();
    const window = Math.floor(ttl / 2) * 1000;
    const at = new Date(options.stable ? now - (now % window) : now);
    try {
      const url = client.presign(key, {
        expires: ttl,
        at,
        ...(options.query ? { query: options.query } : {}),
      });
      this.usage.add({
        requests: 1,
        egress_bytes: options.usage?.egress ?? entry.size,
        ...(options.usage?.process === undefined
          ? {}
          : { process_bytes: options.usage.process, process_count: 1 }),
      });
      return {
        url,
        valid_for_seconds: Math.floor((at.getTime() + ttl * 1000 - now) / 1000),
      };
    } catch {
      return undefined;
    }
  }

  thumbnailUrl(digest: string): SignedLink | undefined {
    const entry = this.synced(attachmentKey(digest));
    return entry
      ? this.signedUrl(attachmentKey(digest), {
          stable: true,
          query: {
            "x-oss-process": THUMBNAIL_PROCESS,
            "response-cache-control": "private, max-age=600",
          },
          usage: {
            egress: Math.min(entry.size, THUMBNAIL_ESTIMATE_BYTES),
            process: entry.size,
          },
        })
      : undefined;
  }

  previewUrl(digest: string, mime: string): SignedLink | undefined {
    const entry = this.synced(attachmentKey(digest));
    return entry
      ? this.signedUrl(attachmentKey(digest), {
          stable: true,
          query: {
            "x-oss-process": PREVIEW_PROCESS,
            "response-content-type": mime,
            "response-cache-control": "private, max-age=600",
          },
          usage: { egress: entry.size, process: entry.size },
        })
      : undefined;
  }

  /**
   * Bytes of an attachment blob that is gone locally, at most `limit` bytes.
   * The key is the digest itself, so the copy is used only when its bytes hash
   * to `digest`; anything else returns undefined, exactly as a missing blob.
   */
  async fetchAttachment(
    digest: string,
    limit: number,
  ): Promise<Buffer | undefined> {
    if (!/^[a-f0-9]{64}$/u.test(digest)) return undefined;
    const key = attachmentKey(digest);
    const source = this.source(key);
    if (!source) return undefined;
    const entry = source.ledger.get(key);
    if (entry && (entry.sha256 !== digest || entry.size > limit))
      return undefined;
    const expected = entry?.size;
    let size = 0;
    try {
      const res = await source.client.get(key, 60_000);
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of res as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > (expected ?? limit)) throw new OssError("integrity");
          chunks.push(chunk);
        }
      } finally {
        res.destroy();
      }
      const content = Buffer.concat(chunks);
      if (
        (expected !== undefined && content.length !== expected) ||
        createHash("sha256").update(content).digest("hex") !== digest
      )
        return undefined;
      this.remember(source, key, digest, content.length);
      return content;
    } catch (error) {
      this.noteMissing(source, key, error);
      return undefined;
    } finally {
      this.usage.add({ requests: 1, egress_bytes: size });
    }
  }

  /**
   * Restore a streamed artifact file at `path` from its verified copy.
   * True once a complete, verified file is in place (or already was).
   */
  async restoreArtifact(
    path: string,
    blobId: string,
    size: number,
    sha256: string,
  ): Promise<boolean> {
    const key = artifactKey(blobId);
    if (!/^[a-f0-9]{64}$/u.test(sha256)) return false;
    const source = this.source(key);
    if (!source) return false;
    // A ledger entry that disagrees with the record is never trusted; no entry
    // at all (restored data directory) still tries the deterministic key.
    const entry = source.ledger.get(key);
    if (entry && (entry.sha256 !== sha256 || entry.size !== size)) return false;
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const res = await source.client.get(
        key,
        Math.max(120_000, Math.ceil(size / 1024)),
      );
      const hash = createHash("sha256");
      let bytes = 0;
      file = await open(temporary, "wx", 0o600);
      try {
        for await (const chunk of res as AsyncIterable<Buffer>) {
          bytes += chunk.length;
          if (bytes > size) throw new OssError("integrity");
          hash.update(chunk);
          await file.write(chunk);
        }
      } finally {
        res.destroy();
        this.usage.add({ requests: 1, egress_bytes: bytes });
      }
      await file.sync();
      if (bytes !== size || hash.digest("hex") !== sha256) return false;
      await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      this.remember(source, key, sha256, size);
      return true;
    } catch (error) {
      this.noteMissing(source, key, error);
      return false;
    } finally {
      await file?.close();
      await rm(temporary, { force: true });
    }
  }

  /** Health-page summary; contains no secret, path or URL. */
  status(): OffsiteStatusView {
    const config = this.config();
    const sync = this.syncStatus();
    this.ledger.refresh();
    const now = this.now();
    const month = usageMonth(now);
    this.usage.flush();
    const used = monthUsage(this.dataDir, month);
    const prices =
      config.state === "ready" ? config.settings.prices : undefined;
    const budget =
      config.state === "ready"
        ? config.settings.monthly_budget_yuan
        : undefined;
    const gib = 1024 ** 3;
    const estimate = prices
      ? (this.ledger.totalBytes / gib) * prices.storage_gb_month +
        (used.egress_bytes / gib) * prices.egress_gb +
        (used.process_bytes / gib) * prices.image_process_gb +
        // Requests are charged in the month they happen; only storage
        // carries over from month to month.
        (used.requests / 10_000) * prices.requests_10k
      : 0;
    const alerts: OffsiteAlert[] = [];
    if (config.state === "invalid") alerts.push("config_invalid");
    if (config.state === "ready") {
      if (sync?.reachable === false) alerts.push("unreachable");
      if ((sync?.failed.count ?? 0) > 0) alerts.push("sync_failed");
      if (budget !== undefined && estimate > budget) alerts.push("over_budget");
    }
    return {
      configured: config.state,
      ...(config.state === "ready"
        ? {
            bucket: config.settings.credentials.bucket,
            region: config.settings.credentials.region,
          }
        : {}),
      synced: { count: this.ledger.count, bytes: this.ledger.totalBytes },
      pending: sync?.pending ?? { count: 0, bytes: 0 },
      failed: sync?.failed ?? { count: 0 },
      ...(sync?.last_success_at
        ? { last_success_at: sync.last_success_at }
        : {}),
      ...(sync ? { checked_at: sync.checked_at } : {}),
      usage: {
        month,
        egress_bytes: used.egress_bytes,
        process_bytes: used.process_bytes,
        requests: used.requests,
        estimated_yuan: Math.round(estimate * 100) / 100,
        ...(budget === undefined ? {} : { budget_yuan: budget }),
      },
      alerts,
    };
  }
}

export type OffsiteAlert =
  | "config_invalid"
  | "unreachable"
  | "sync_failed"
  | "over_budget";
export interface OffsiteStatusView {
  readonly configured: SyncStatus["configured"];
  readonly bucket?: string;
  readonly region?: string;
  readonly synced: { readonly count: number; readonly bytes: number };
  readonly pending: { readonly count: number; readonly bytes: number };
  readonly failed: SyncStatus["failed"];
  readonly last_success_at?: string;
  readonly checked_at?: string;
  readonly usage: {
    readonly month: string;
    readonly egress_bytes: number;
    readonly process_bytes: number;
    readonly requests: number;
    readonly estimated_yuan: number;
    readonly budget_yuan?: number;
  };
  readonly alerts: readonly OffsiteAlert[];
}

/**
 * Process-wide registration, keyed by the resolved data directory. Readers
 * that only know a data directory (attachment and artifact stores) find the
 * off-site copy here; nothing is registered unless the host wires it.
 */
const registry = new Map<string, Offsite>();
export function registerOffsite(offsite: Offsite) {
  registry.set(offsite.dataDir, offsite);
  return () => {
    if (registry.get(offsite.dataDir) === offsite) {
      offsite.usage.flush();
      registry.delete(offsite.dataDir);
    }
  };
}
export function offsiteFor(dataDir: string | undefined): Offsite | undefined {
  return registry.get(
    resolve(dataDir ?? process.env.CARDIGAN_DATA_DIR ?? ".data"),
  );
}
