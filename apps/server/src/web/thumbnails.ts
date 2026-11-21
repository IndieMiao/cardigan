import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
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
/**
 * Signatures of the inline bitmap types (PNG, JPEG, GIF, WebP, AVIF). Anything
 * else never reaches libvips, whose loaders would also parse SVG, PDF or TIFF.
 */
function bitmapSignature(input: Uint8Array): boolean {
  const ascii = (start: number, end: number) =>
    Buffer.from(input.subarray(start, end)).toString("latin1");
  return (
    ascii(0, 8) === "\x89PNG\r\n\x1a\n" ||
    ascii(0, 3) === "\xff\xd8\xff" ||
    ["GIF87a", "GIF89a"].includes(ascii(0, 6)) ||
    (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") ||
    avifBrand(input, ascii)
  );
}
/**
 * An ISO-BMFF file type box naming AVIF as its major or one of its compatible
 * brands (e.g. major `mif1` with `avif` listed), read within the box bounds.
 */
function avifBrand(
  input: Uint8Array,
  ascii: (start: number, end: number) => string,
): boolean {
  if (input.byteLength < 16 || ascii(4, 8) !== "ftyp") return false;
  const size = Buffer.from(input.subarray(0, 4)).readUInt32BE(0);
  // Sizes 0 (to end of file) and 1 (64-bit) are not used for this box, and
  // real ones list a handful of brands.
  if (size < 16 || size > Math.min(input.byteLength, 1024) || size % 4 !== 0)
    return false;
  const brands = [ascii(8, 12)];
  for (let offset = 16; offset < size; offset += 4)
    brands.push(ascii(offset, offset + 4));
  return brands.some((brand) => brand === "avif" || brand === "avis");
}
/** About 1440×69000; bounds decoder memory for a hostile 10 MiB upload. */
const MAX_INPUT_PIXELS = 100_000_000;
/** Renders running at once; a page of thumbnails queues behind these. */
const MAX_RENDERS = 2;
/** Largest cache entry served; a 480×640 thumbnail is a few dozen KiB. */
const MAX_THUMBNAIL_BYTES = 1024 * 1024;
/** A complete WebP file: RIFF header whose length covers exactly `content`. */
function webpFile(content: Buffer): boolean {
  return (
    content.byteLength >= 12 &&
    content.toString("latin1", 0, 4) === "RIFF" &&
    content.toString("latin1", 8, 12) === "WEBP" &&
    content.readUInt32LE(4) + 8 === content.byteLength
  );
}

export const THUMBNAIL_MIME = "image/webp";

export type ThumbnailResult = Buffer | "missing" | "unavailable";

/** Render the thumbnail bytes, or throw when the image cannot be decoded. */
export async function renderThumbnail(input: Uint8Array): Promise<Buffer> {
  if (!bitmapSignature(input)) throw new Error("unsupported format");
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
    const cached = await this.cached(path);
    if (cached !== undefined) return cached;
    // The original is read only once a render slot is free, so a page of cold
    // thumbnails holds at most MAX_RENDERS originals in memory.
    const output = await this.limited<ThumbnailResult>(async () => {
      const input = await source();
      if (input === undefined) return "missing";
      try {
        return await this.render(input);
      } catch {
        this.failed.add(digest);
        return "unavailable";
      }
    });
    if (typeof output === "string") return output;
    // A full disk costs only the cache; the thumbnail is still served.
    await this.store(path, output).catch(() => undefined);
    return output;
  }

  /**
   * A cache entry fit to serve: a regular WebP file of bounded size inside
   * real cache directories. Anything else is a miss and gets rendered again.
   */
  private async cached(path: string): Promise<Buffer | undefined> {
    if ((await this.directoryState()) !== "ready") return undefined;
    try {
      // Never follow a symlink or block while opening a special file.
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_THUMBNAIL_BYTES) return undefined;
        // One extra byte detects growth after stat without an unbounded read.
        const buffer = Buffer.alloc(info.size + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            size,
            buffer.length - size,
            size,
          );
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        const content = buffer.subarray(0, size);
        return size === info.size && webpFile(content) ? content : undefined;
      } finally {
        await file.close();
      }
    } catch {
      return undefined;
    }
  }

  /**
   * `ready` when both cache directories are real directories, `absent` before
   * the first write, `untrusted` when either is a symlink or another file;
   * an untrusted cache is neither read nor written.
   */
  private async directoryState(): Promise<"ready" | "absent" | "untrusted"> {
    for (const directory of [dirname(this.directory), this.directory]) {
      try {
        if (!(await lstat(directory)).isDirectory()) return "untrusted";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "absent"
          : "untrusted";
      }
    }
    return "ready";
  }

  private async store(path: string, output: Buffer) {
    if ((await this.directoryState()) === "untrusted") return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await this.directoryState()) !== "ready") return;
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
