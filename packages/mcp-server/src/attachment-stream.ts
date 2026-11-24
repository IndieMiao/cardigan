import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { openAttachmentFile } from "./attachments.js";
import { ToolError } from "./errors.js";

/**
 * C-683: one byte range of a stored blob, as `Range: bytes=a-b`, `a-` or
 * `-n`. Undefined sends the whole file (no header, several ranges, or a unit
 * other than bytes: a server may ignore those); `false` is unsatisfiable.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | false | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) return undefined;
  const [, first = "", last = ""] = match;
  if (!first && !last) return false;
  if (!first) {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0)
      return false;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last ? Math.min(Number(last), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || start >= size || end < start)
    return false;
  return { start, end };
}

/**
 * Stream an open blob of `size` bytes, honouring one `Range` (video players
 * seek with it). The handle is closed afterwards. `headers` are sent as is
 * with the status and length added here.
 */
export async function sendFileRange(
  req: IncomingMessage,
  res: ServerResponse,
  file: FileHandle,
  size: number,
  headers: Readonly<Record<string, string | number>>,
) {
  try {
    const range = byteRange(
      typeof req.headers.range === "string" ? req.headers.range : undefined,
      size,
    );
    if (range === false) {
      res.writeHead(416, {
        ...headers,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${size}`,
        "Content-Length": 0,
      });
      res.end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const length = size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, {
      ...headers,
      "Accept-Ranges": "bytes",
      "Content-Length": length,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === "HEAD" || length === 0) {
      res.end();
      return;
    }
    await pipeline(
      file.createReadStream({ start, end, autoClose: false }),
      res,
    );
  } finally {
    await file.close();
  }
}

/** Rehash a stored blob of `size` bytes by streaming it; for explicit checks. */
export async function hashAttachmentFile(
  dataDir: string,
  digest: string,
  size: number,
) {
  const file = await openAttachmentFile(dataDir, digest, size);
  if (!file) throw ToolError.notFound("Attachment content is missing");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of file.createReadStream({
      autoClose: false,
      end: size,
    })) {
      bytes += (chunk as Buffer).length;
      hash.update(chunk as Buffer);
    }
  } finally {
    await file.close();
  }
  return bytes === size && hash.digest("hex") === digest;
}
