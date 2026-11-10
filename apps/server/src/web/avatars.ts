import type { IncomingMessage, ServerResponse } from "node:http";
import { fileAvatarStore } from "@cardigan/store";
import { HttpRejection, methodNotAllowed } from "./http.js";

/** Caller must authenticate before entering, including conditional requests. */
export async function serveAvatar(
  req: IncomingMessage,
  res: ServerResponse,
  dataDir: string,
  sha256: string,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD")
    methodNotAllowed(["GET", "HEAD"]);
  const avatar = await fileAvatarStore(dataDir).get(sha256);
  if (!avatar) throw new HttpRejection(404, "not_found", "头像不存在");
  const etag = `"${sha256}"`;
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("ETag", etag);
  res.setHeader("Content-Type", avatar.mime);
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  res.setHeader("Content-Length", avatar.bytes.byteLength);
  res.writeHead(200);
  res.end(req.method === "HEAD" ? undefined : Buffer.from(avatar.bytes));
}
