import type { IncomingMessage, ServerResponse } from "node:http";
import type { AttachmentId, AttachmentStore } from "@cardigan/domain";
import { sendArtifact } from "./artifact-files.js";
import { ToolError } from "./errors.js";
import { artifactKey, attachmentKey, offsiteFor } from "./offsite/offsite.js";
import {
  accessibleAttachment,
  readVerifiedAttachment,
} from "./tools/read-attachment.js";
import { auditReferenceRead, referenceCard } from "./tools/reference-read.js";
import type { ToolContext } from "./tools/types.js";

/** C-614: request header of helpers that can fetch from a signed OSS URL. */
export const SIGNED_DOWNLOAD_HEADER = "x-cardigan-download";
export const SIGNED_DOWNLOAD_TYPE =
  "application/vnd.cardigan.signed-download+json";

function sendSigned(
  res: ServerResponse,
  a: { id: string; sha256: string; size: number },
  url: string,
  artifact: boolean,
  sourceCard: string | undefined,
) {
  const body = Buffer.from(JSON.stringify({ url }));
  res.writeHead(200, {
    "Content-Type": SIGNED_DOWNLOAD_TYPE,
    "Content-Length": body.byteLength,
    "X-Attachment-Id": a.id,
    "X-Attachment-Sha256": a.sha256,
    "X-Attachment-Size": a.size,
    ...(artifact ? { "X-Artifact-Size": a.size } : {}),
    ...(sourceCard ? { "X-Source-Card-Id": sourceCard } : {}),
  });
  res.end(body);
}

/** Binary transport for the existing read_attachment capability. No paths or
 * caller-supplied identities are accepted; authorization is shared with MCP.
 *
 * C-614: a helper that sends `x-cardigan-download: signed-url` may instead get
 * a short-lived signed OSS URL for a verified off-site copy, after exactly the
 * same authorization and audit. Requests without the header (older helpers)
 * and objects without a verified copy keep the byte response unchanged. */
export async function serveAttachmentDownload(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  attachments: Pick<AttachmentStore, "get">,
  context: ToolContext,
  allowedHosts: readonly string[],
  dataDir?: string,
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
    const a = accessibleAttachment(ids[0] as AttachmentId, context);
    const signed =
      req.headers[SIGNED_DOWNLOAD_HEADER] === "signed-url"
        ? offsiteFor(dataDir)
        : undefined;
    if (a.streamed_artifact) {
      const blob = a.streamed_artifact.blob_id;
      const entry = signed?.synced(artifactKey(blob));
      const location =
        entry?.sha256 === a.sha256 && entry.size === a.size
          ? signed?.signedUrl(artifactKey(blob))
          : undefined;
      if (location) {
        accessibleAttachment(a.id, context);
        const { provenance } = context.store.uow.read((tx) =>
          referenceCard(tx, context, a.card_id),
        );
        auditReferenceRead(context, [a.card_id], "read_attachment");
        sendSigned(res, a, location, true, provenance.source_card_id);
        return;
      }
      await sendArtifact(dataDir, a, res, false, () => {
        accessibleAttachment(a.id, context);
        const { provenance } = context.store.uow.read((tx) =>
          referenceCard(tx, context, a.card_id),
        );
        if (provenance.source_card_id)
          res.setHeader("X-Source-Card-Id", provenance.source_card_id);
        auditReferenceRead(context, [a.card_id], "read_attachment");
      });
      return;
    }
    const { attachment, content, provenance } = await readVerifiedAttachment(
      a,
      attachments,
      context,
    );
    const location =
      signed?.synced(attachmentKey(attachment.sha256))?.size === attachment.size
        ? signed.signedUrl(attachmentKey(attachment.sha256))
        : undefined;
    if (location) {
      sendSigned(res, attachment, location, false, provenance?.source_card_id);
      return;
    }
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
    if (res.headersSent) {
      res.destroy();
      return;
    }
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
