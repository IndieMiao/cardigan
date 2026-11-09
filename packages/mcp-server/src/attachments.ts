import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type AttachmentStore, prepareAttachment } from "@cardigan/domain";
import { ToolError } from "./errors.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_BASE64 = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);
// Leave room for the JSON-RPC envelope while keeping the HTTP body bounded.
export const MAX_MCP_BODY_BYTES = MAX_ATTACHMENT_BASE64 + 1024 * 1024;
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
) {
  const { content, digest } = decodeAttachment(file, expected);
  const result = await prepareAttachment(
    digest,
    content,
    fileAttachmentStore(dataDir),
  );
  if (!result.ok) throw new ToolError(result.error.code, result.error.message);
  return result.value;
}

export function decodeAttachment(file: string, expected?: string) {
  const content = Buffer.from(file, "base64");
  if (content.byteLength > MAX_ATTACHMENT_BYTES)
    throw ToolError.validation("Attachment exceeds 10 MiB");
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
): AttachmentStore {
  const directory = resolve(dataDir, "attachments");
  const path = (digest: string) => {
    if (!/^[a-f0-9]{64}$/u.test(digest))
      throw ToolError.validation("Invalid attachment sha256");
    return join(directory, digest);
  };
  const get = async (digest: string) => {
    try {
      const content = await readFile(path(digest));
      if (sha256(content) !== digest)
        throw ToolError.validation("Stored attachment checksum mismatch");
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  return {
    get,
    async put(digest, content) {
      const target = path(digest);
      if (
        content.byteLength > MAX_ATTACHMENT_BYTES ||
        sha256(content) !== digest
      )
        throw ToolError.validation("Invalid attachment content");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
        try {
          // Publish a complete file atomically without overwriting another upload.
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!(await get(digest))) throw new Error("Attachment disappeared");
        }
      } finally {
        await rm(temporary, { force: true });
      }
      return { storage_path: `attachments/${digest}` };
    },
  };
}
