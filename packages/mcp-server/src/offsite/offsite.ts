import { createHash, randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type OffsiteConfig, readOffsiteConfig } from "./config.js";
import { OssClient, OssError, type OssTransport } from "./oss.js";
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

export class Offsite {
  readonly dataDir: string;
  readonly ledger: SyncedLedger;
  readonly usage: UsageMeter;
  private cached:
    | { at: number; value: OffsiteConfig; client?: OssClient }
    | undefined;
  private readonly now: () => Date;

  constructor(private readonly options: OffsiteOptions) {
    this.dataDir = resolve(options.dataDir);
    this.now = options.now ?? (() => new Date());
    this.ledger = new SyncedLedger(this.dataDir);
    this.usage = new UsageMeter(this.dataDir, options.role, this.now);
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

  /** A verified copy of `key`, when OSS is configured and not known to be failing. */
  synced(key: string): SyncedEntry | undefined {
    if (this.config().state !== "ready") return undefined;
    return this.ledger.refresh().get(key);
  }

  private reachable() {
    return readSyncStatus(this.dataDir)?.reachable !== false;
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
  ): string | undefined {
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
      return url;
    } catch {
      return undefined;
    }
  }

  thumbnailUrl(digest: string): string | undefined {
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

  previewUrl(digest: string, mime: string): string | undefined {
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
   * Bytes of a small attachment that is gone locally. Returns undefined
   * unless the object was synced and its size and digest match exactly.
   */
  async fetchAttachment(
    digest: string,
    limit: number,
  ): Promise<Buffer | undefined> {
    const key = attachmentKey(digest);
    const entry = this.synced(key);
    const client = this.client();
    if (!entry || !client || entry.sha256 !== digest || entry.size > limit)
      return undefined;
    try {
      const res = await client.get(key, 60_000);
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of res as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > entry.size) throw new OssError("integrity");
          chunks.push(chunk);
        }
      } finally {
        res.destroy();
      }
      const content = Buffer.concat(chunks);
      this.usage.add({ requests: 1, egress_bytes: size });
      if (
        content.length !== entry.size ||
        createHash("sha256").update(content).digest("hex") !== digest
      )
        return undefined;
      return content;
    } catch {
      return undefined;
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
    const entry = this.synced(key);
    const client = this.client();
    if (!entry || !client || entry.sha256 !== sha256 || entry.size !== size)
      return false;
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const res = await client.get(
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
      return true;
    } catch {
      return false;
    } finally {
      await file?.close();
      await rm(temporary, { force: true });
    }
  }

  /** Health-page summary; contains no secret, path or URL. */
  status(): OffsiteStatusView {
    const config = this.config();
    const sync = readSyncStatus(this.dataDir);
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
        ((used.requests + this.ledger.count) / 10_000) * prices.requests_10k
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
