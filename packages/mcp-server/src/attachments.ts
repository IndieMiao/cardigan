import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AttachmentStore,
  MAX_VIDEO_POSTER_BYTES,
  prepareAttachment,
} from "@cardigan/domain";
import {
  formatAttachmentLimit,
  MAX_STORED_ATTACHMENT_BYTES,
  resolveAttachmentLimits,
} from "./attachment-limits.js";
import { ToolError } from "./errors.js";
import { offsiteFor } from "./offsite/offsite.js";
import { checkVideoContent, VIDEO_EXTENSIONS } from "./video-format.js";

/** Resolved once per process from the host environment (C-616); invalid values fail at startup. */
export const ATTACHMENT_LIMITS = resolveAttachmentLimits(process.env);
export const MAX_ATTACHMENT_BYTES = ATTACHMENT_LIMITS.bytes;
export const MAX_ATTACHMENT_BASE64 = ATTACHMENT_LIMITS.base64;
// Leave room for the JSON-RPC envelope while keeping the HTTP body bounded.
export const MAX_MCP_BODY_BYTES = ATTACHMENT_LIMITS.bodyBytes;
/**
 * C-616: 413 text for an MCP request body over `MAX_MCP_BODY_BYTES`, naming
 * both the body bound and the ordinary attachment limit it is derived from.
 */
export const mcpBodyTooLargeMessage = (
  bodyBytes = MAX_MCP_BODY_BYTES,
  attachmentBytes = MAX_ATTACHMENT_BYTES,
) =>
  `Payload Too Large: request body must not exceed ${bodyBytes} bytes; attachments are limited to ${formatAttachmentLimit(attachmentBytes)} (larger files use the artifact upload)`;
/** Exact text of the over-limit refusal; the CLI translates it by this key. */
export const attachmentTooLargeMessage = (bytes = MAX_ATTACHMENT_BYTES) =>
  `Attachment exceeds ${formatAttachmentLimit(bytes)}`;
export const sha256 = (content: Uint8Array) =>
  createHash("sha256").update(content).digest("hex");

/** File types recognized by Workbench downloads and human CLI uploads. */
export const ATTACHMENT_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
  "application/json": "json",
  "application/pdf": "pdf",
  // C-717: downloads as .zip and the CLI takes .zip; never inline.
  "application/zip": "zip",
  // C-683: videos (own limit, chunked or streamed uploads).
  ...VIDEO_EXTENSIONS,
};

export function attachmentMimeForExtension(
  extension: string,
): string | undefined {
  const normalized = extension.replace(/^\./u, "").toLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    jpeg: "jpg",
    htm: "html",
    markdown: "md",
    log: "txt",
  };
  return Object.entries(ATTACHMENT_EXTENSIONS).find(
    ([, ext]) => ext === (aliases[normalized] ?? normalized),
  )?.[0];
}

/** Shared Workbench/CLI preflight, outside the database transaction. */
export async function prepareAttachmentFile(
  file: string,
  dataDir: string,
  expected?: string,
  mime?: string,
) {
  const { content, digest } = decodeAttachment(file, expected);
  // C-683: a video's first bytes must show the claimed container.
  if (mime !== undefined) checkVideoContent(mime, content);
  const result = await prepareAttachment(
    digest,
    content,
    fileAttachmentStore(dataDir),
  );
  if (!result.ok) throw new ToolError(result.error.code, result.error.message);
  return result.value;
}

/**
 * C-683: a video's cover frame from the uploader's browser: canonical base64
 * of a JPEG of at most `MAX_VIDEO_POSTER_BYTES`, stored as its own blob. The
 * host checks the JPEG marker only and never decodes the image.
 */
export async function preparePoster(file: string, dataDir: string) {
  const { content, digest } = decodeAttachment(
    file,
    undefined,
    MAX_VIDEO_POSTER_BYTES,
  );
  if (
    content.length < 4 ||
    content[0] !== 0xff ||
    content[1] !== 0xd8 ||
    content[2] !== 0xff
  )
    throw ToolError.validation("The poster must be a JPEG image");
  const result = await prepareAttachment(
    digest,
    content,
    fileAttachmentStore(dataDir),
  );
  if (!result.ok) throw new ToolError(result.error.code, result.error.message);
  return result.value;
}

export function decodeAttachment(
  file: string,
  expected?: string,
  maxBytes = MAX_ATTACHMENT_BYTES,
) {
  // Refuse by length before Buffer.from allocates a decoded copy.
  if (file.length > 4 * Math.ceil(maxBytes / 3))
    throw ToolError.validation(attachmentTooLargeMessage(maxBytes));
  const content = Buffer.from(file, "base64");
  if (content.byteLength > maxBytes)
    throw ToolError.validation(attachmentTooLargeMessage(maxBytes));
  // Buffer.from alone silently accepts whitespace, bad padding and other junk.
  if (content.toString("base64") !== file)
    throw ToolError.validation("File must be canonical padded base64");
  const digest = sha256(content);
  if (expected !== undefined && expected !== digest)
    throw ToolError.validation("Attachment sha256 does not match content");
  return { content, digest };
}

/** Content-addressed blobs outlive failed DB transactions; shared blobs are never removed. */
export function fileAttachmentStore(
  dataDir = process.env.CARDIGAN_DATA_DIR ?? ".data",
  maxBytes = MAX_ATTACHMENT_BYTES,
): AttachmentStore {
  const directory = resolve(dataDir, "attachments");
  const path = (digest: string) => {
    if (digest.length !== 64 || !/^[a-f0-9]{64}$/u.test(digest))
      throw ToolError.validation("Invalid attachment sha256");
    return join(directory, digest);
  };
  const local = async (digest: string) => {
    const target = path(digest);
    try {
      // Never follow a blob symlink or block while opening a special file.
      const file = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_STORED_ATTACHMENT_BYTES)
          throw ToolError.validation(
            `Stored attachment must be a file up to ${formatAttachmentLimit(MAX_STORED_ATTACHMENT_BYTES)}`,
          );
        // Bound the read even if another process grows the file after stat.
        // One extra byte detects growth without ever using an unbounded readFile.
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
        if (size !== info.size)
          throw ToolError.validation(
            "Stored attachment size changed during read",
          );
        const content = buffer.subarray(0, size);
        if (sha256(content) !== digest)
          throw ToolError.validation("Stored attachment checksum mismatch");
        return content;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof ToolError) throw error;
      // Filesystem errors may contain host paths; keep them off the wire.
      throw ToolError.validation("Stored attachment could not be read");
    }
  };
  /**
   * C-614: local first. A blob missing here is fetched from the verified
   * off-site copy, checked against its digest and cached locally; an absent
   * or failing OSS leaves the result exactly as before (missing).
   */
  const get = async (digest: string) => {
    const found = await local(digest);
    if (found !== undefined) return found;
    // C-616: a restore is a read of an accepted blob, so it is bounded by the
    // stored ceiling rather than the current upload limit.
    const remote = await offsiteFor(dataDir)?.fetchAttachment(
      digest,
      MAX_STORED_ATTACHMENT_BYTES,
    );
    if (remote === undefined || sha256(remote) !== digest) return undefined;
    // A full disk costs only the cache; the verified bytes are still served.
    await publish(digest, remote, MAX_STORED_ATTACHMENT_BYTES).catch(
      () => undefined,
    );
    return remote;
  };
  /** Writes a verified blob of at most `limit` bytes; see `put`. */
  async function publish(
    digest: string,
    content: Uint8Array,
    limit: number,
  ): Promise<{ storage_path: string }> {
    const target = path(digest);
    if (content.byteLength > limit)
      throw ToolError.validation(attachmentTooLargeMessage(limit));
    if (sha256(content) !== digest)
      throw ToolError.validation("Invalid attachment content");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await linkBlob(temporary, target, async () => !!(await local(digest)));
    } finally {
      await rm(temporary, { force: true });
    }
    return { storage_path: `attachments/${digest}` };
  }
  return {
    get,
    // New blobs follow the current host limit; only reads keep the ceiling.
    put: (digest, content) => publish(digest, content, maxBytes),
  };
}

/**
 * Publish a complete file atomically without overwriting another upload. An
 * existing blob is reused only when `existing` vouches for it. Two retries
 * cover a blob the attachment sweep removes in between.
 */
async function linkBlob(
  source: string,
  target: string,
  existing: () => Promise<boolean>,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await link(source, target);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await existing())) throw new Error("Attachment disappeared");
      // Reusing an existing blob refreshes its modification time, so the
      // sweep's 24 hour grace period covers the record this upload is
      // about to write (§9.3). Without it an old rejected blob could be
      // deleted right after being reused.
      try {
        const now = new Date();
        await utimes(target, now, now);
        return;
      } catch (touched) {
        if ((touched as NodeJS.ErrnoException).code !== "ENOENT") throw touched;
        if (attempt >= 1) throw new Error("Attachment disappeared");
        // The blob vanished between the check and the touch: publish again.
      }
    }
  }
}

/** `<dataDir>/attachments/<sha256>`; the digest is checked first. */
export function attachmentBlobPath(dataDir: string, digest: string) {
  if (!/^[a-f0-9]{64}$/u.test(digest))
    throw ToolError.validation("Invalid attachment sha256");
  return join(resolve(dataDir), "attachments", digest);
}

const OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * C-683: publish a file the caller already hashed to `digest` (a finished
 * chunked upload or a streamed CLI copy) into the content-addressed store
 * by hard link, without reading it into memory. An existing blob of the same
 * size is reused; the caller removes `source` afterwards.
 */
export async function publishAttachmentFile(
  dataDir: string,
  digest: string,
  size: number,
  source: string,
): Promise<{ storage_path: string }> {
  const target = attachmentBlobPath(dataDir, digest);
  await mkdir(join(resolve(dataDir), "attachments"), {
    recursive: true,
    mode: 0o700,
  });
  try {
    await linkBlob(source, target, async () => {
      const file = await open(target, OPEN_FLAGS).catch(() => undefined);
      if (!file) return false;
      try {
        const info = await file.stat();
        return info.isFile() && info.size === size;
      } finally {
        await file.close();
      }
    });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw ToolError.validation("Attachment storage failed");
  }
  return { storage_path: `attachments/${digest}` };
}

/**
 * C-683: an open handle on a stored blob of exactly `size` bytes, for reads
 * that stream (videos). A blob gone locally is restored from its verified
 * off-site copy (C-614) first. Undefined when neither has it.
 */
export async function openAttachmentFile(
  dataDir: string,
  digest: string,
  size: number,
) {
  const path = attachmentBlobPath(dataDir, digest);
  const attempt = () =>
    open(path, OPEN_FLAGS).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw ToolError.validation("Stored attachment could not be read");
    });
  let file = await attempt();
  if (
    !file &&
    (await offsiteFor(dataDir)?.restoreAttachment(path, digest, size))
  )
    file = await attempt();
  if (!file) return undefined;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== size)
      throw ToolError.validation("Stored attachment size mismatch");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
