import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { AttachmentId, ProjectId } from "@cardigan/domain";
import { fileAttachmentStore } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import sharp from "sharp";
import { INLINE_MIME_TYPES } from "./read.js";

/**
 * C-540: small previews for image attachments.
 *
 * Grids, timelines and decisions used to load the original screenshot (often
 * several hundred KiB) for a box about 160×112 CSS pixels. The server now
 * renders one WebP per attachment blob, caches it next to the blobs and serves
 * it behind the same session and project lookup as the original. Opening the
 * preview or downloading still uses the original.
 */

/** Widest thumbnail: the 1440 grid boxes are under 240 CSS px at 2× DPR. */
export const THUMBNAIL_WIDTH = 480;
/**
 * Tallest kept aspect (height / width). Longer images keep their top, the part
 * a stitched screenshot starts with, instead of shrinking to a sliver.
 */
export const THUMBNAIL_MAX_RATIO = 4 / 3;
/** Part of the cache path: change it whenever the rendering changes. */
const VERSION = "v1";
/** Decoders allowed to run; never SVG or other formats behind a bitmap MIME. */
const DECODABLE = new Set(["png", "jpeg", "gif", "webp", "heif"]);
/** About 1440×69000; bounds decoder memory for a hostile 10 MiB upload. */
const MAX_INPUT_PIXELS = 100_000_000;
/** Renders running at once; a page of thumbnails queues behind these. */
const MAX_RENDERS = 2;

export const THUMBNAIL_MIME = "image/webp";

export type ThumbnailResult = Buffer | "missing" | "unavailable";

/** Render the thumbnail bytes, or throw when the image cannot be decoded. */
export async function renderThumbnail(input: Uint8Array): Promise<Buffer> {
  const image = sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "error",
  });
  const metadata = await image.metadata();
  if (!DECODABLE.has(metadata.format)) throw new Error("unsupported format");
  const { width, height } = metadata.autoOrient;
  const targetWidth = Math.min(THUMBNAIL_WIDTH, width);
  const targetHeight = Math.max(
    1,
    Math.round(targetWidth * Math.min(height / width, THUMBNAIL_MAX_RATIO)),
  );
  return image
    .autoOrient()
    .resize(targetWidth, targetHeight, { fit: "cover", position: "top" })
    .webp({ quality: 75 })
    .toBuffer();
}

/**
 * Thumbnail cache for one data directory. Keyed by the blob digest, so the
 * same content renders once however many attachments or projects share it;
 * callers must have checked access to an attachment with that digest.
 */
export class ThumbnailCache {
  private readonly pending = new Map<string, Promise<ThumbnailResult>>();
  /** Undecodable blobs are not retried until the process restarts. */
  private readonly failed = new Set<string>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly directory: string;

  constructor(
    dataDir: string,
    private readonly render: (
      input: Uint8Array,
    ) => Promise<Buffer> = renderThumbnail,
  ) {
    this.directory = resolve(dataDir, "attachment-thumbnails", VERSION);
  }

  /**
   * The cached thumbnail, rendering it from `source` on first use: `missing`
   * when the source blob is gone, `unavailable` when it cannot be decoded.
   */
  get(
    digest: string,
    source: () => Promise<Uint8Array | undefined>,
  ): Promise<ThumbnailResult> {
    if (!/^[a-f0-9]{64}$/u.test(digest))
      throw new Error("Invalid attachment sha256");
    if (this.failed.has(digest)) return Promise.resolve("unavailable");
    const running = this.pending.get(digest);
    if (running) return running;
    const next = this.load(digest, source).finally(() =>
      this.pending.delete(digest),
    );
    this.pending.set(digest, next);
    return next;
  }

  private async load(
    digest: string,
    source: () => Promise<Uint8Array | undefined>,
  ): Promise<ThumbnailResult> {
    const path = join(this.directory, `${digest}.webp`);
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const input = await source();
    if (input === undefined) return "missing";
    let output: Buffer;
    try {
      output = await this.limited(() => this.render(input));
    } catch {
      this.failed.add(digest);
      return "unavailable";
    }
    // A full disk costs only the cache; the thumbnail is still served.
    await this.store(path, output).catch(() => undefined);
    return output;
  }

  private async store(path: string, output: Buffer) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, output, { flag: "wx", mode: 0o600 });
      // Readers only ever see a complete file.
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_RENDERS)
      await new Promise<void>((ready) => this.waiting.push(ready));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const caches = new Map<string, ThumbnailCache>();
function cacheFor(dataDir: string) {
  const key = resolve(dataDir);
  const cache = caches.get(key) ?? new ThumbnailCache(dataDir);
  caches.set(key, cache);
  return cache;
}

export interface ThumbnailContext {
  readonly store: Store;
  readonly project_id: ProjectId;
  readonly attachment_id: string;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly dataDir: string;
}

/**
 * Serve one attachment's thumbnail, or return `false` when the project has no
 * such previewable attachment. The caller has already required a session, and
 * the lookup is the same project-scoped one the original download uses.
 */
export async function serveAttachmentThumbnail(
  context: ThumbnailContext,
): Promise<boolean> {
  const { store, project_id, attachment_id, req, res, dataDir } = context;
  const attachment = store.uow.read((tx) =>
    tx.attachments.get(project_id, attachment_id as AttachmentId),
  );
  if (
    attachment === undefined ||
    attachment.streamed_artifact ||
    !INLINE_MIME_TYPES.has(attachment.mime.toLowerCase())
  )
    return false;
  const digest = attachment.sha256;
  const etag = `"${digest}-${VERSION}"`;
  const headers = {
    ETag: etag,
    "Cache-Control": "private, no-cache",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  // The tag names the rendered bytes, so revalidation needs no rendering.
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  const output = await cacheFor(dataDir).get(digest, () =>
    fileAttachmentStore(dataDir).get(digest),
  );
  if (typeof output === "string") {
    const [status, code, message] =
      output === "missing"
        ? [404, "not_found", "attachment content is missing"]
        : [422, "thumbnail_unavailable", "thumbnail could not be rendered"];
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify({ error: { code, message } }));
    return true;
  }
  res.writeHead(200, {
    ...headers,
    "Content-Type": THUMBNAIL_MIME,
    "Content-Length": output.byteLength,
    "Content-Disposition": `inline; filename="${attachment.id.replace(/[^A-Za-z0-9._-]/gu, "_")}-thumbnail.webp"`,
  });
  res.end(output);
  return true;
}
