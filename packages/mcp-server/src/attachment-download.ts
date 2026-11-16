import type { IncomingMessage, ServerResponse } from "node:http";
import type { AttachmentStore } from "@cardigan/domain";
import { ToolError } from "./errors.js";
import { readVerifiedAttachment } from "./tools/read-attachment.js";
import type { ToolContext } from "./tools/types.js";

/** Binary transport for the existing read_attachment capability. No paths or
 * caller-supplied identities are accepted; authorization is shared with MCP. */
export async function serveAttachmentDownload(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  attachments: Pick<AttachmentStore, "get">,
  context: ToolContext,
  allowedHosts: readonly string[],
) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  try {
    // Mirror the MCP transport's Host fence. Browser origins additionally must
    // match the requested origin; this route has no cookie auth or CORS grant.
    if (
      !allowedHosts.includes(req.headers.host ?? "") ||
      (req.headers.origin !== undefined && req.headers.origin !== url.origin)
    ) {
      res.writeHead(403).end();
      return;
    }
    const ids = url.searchParams.getAll("attachment_id");
    if (
      ids.length !== 1 ||
      !ids[0] ||
      [...url.searchParams.keys()].some((key) => key !== "attachment_id")
    )
      throw ToolError.validation("Provide only one attachment_id");
    const { attachment, content, provenance } = await readVerifiedAttachment(
      ids[0],
      attachments,
      context,
    );
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${attachment.id.replace(/[^A-Za-z0-9._-]/gu, "_")}.bin"`,
      "Content-Length": content.byteLength,
      "X-Attachment-Id": attachment.id,
      "X-Attachment-Sha256": attachment.sha256,
      ...(provenance?.source_card_id
        ? { "X-Source-Card-Id": provenance.source_card_id }
        : {}),
    });
    res.end(Buffer.from(content));
  } catch (error) {
    const safe =
      error instanceof ToolError
        ? error
        : ToolError.validation("Attachment download failed");
    const status =
      safe.code === "unauthorized"
        ? 401
        : safe.code === "forbidden_tool"
          ? 403
          : safe.code === "not_found"
            ? 404
            : 400;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: safe.toDomainError() }));
  }
}
