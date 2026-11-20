import type { IncomingMessage, ServerResponse } from "node:http";
import type { AttachmentId, ProjectId } from "@cardigan/domain";
import {
  ATTACHMENT_EXTENSIONS,
  fileAttachmentStore,
  sendArtifact,
} from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import { INLINE_MIME_TYPES } from "./read.js";

/**
 * Attachment download (M5 plan §3.2: XSS through Agent-written content).
 *
 * Only known bitmap types may be rendered inline by the browser; SVG, HTML and
 * everything else is served as a download, because an SVG in an `<img>` is one
 * navigation away from executing script in this origin. Every response carries
 * `Content-Disposition: attachment` unless the type is on that allow-list, and
 * `nosniff` is already set globally.
 */

export interface AttachmentDownloadContext {
  readonly store: Store;
  readonly project_id: ProjectId;
  readonly attachment_id: string;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly dataDir: string;
}

/** Safe file name for the download: the readable id plus a neutral extension. */
function downloadName(id: string, mime: string): string {
  const extension = ATTACHMENT_EXTENSIONS[mime.toLowerCase()] ?? "bin";
  return `${id.replace(/[^A-Za-z0-9._-]/gu, "_")}.${extension}`;
}

/**
 * Serve one attachment, or return `false` when the project does not have it.
 *
 * The blob is read from the content-addressed attachment store the MCP upload
 * path writes to, and its digest is verified there, so a corrupted file is an
 * error rather than a silently wrong download.
 */
export async function serveAttachment(
  context: AttachmentDownloadContext,
): Promise<boolean> {
  const { store, project_id, attachment_id, res } = context;
  const attachment = store.uow.read((tx) =>
    tx.attachments.get(project_id, attachment_id as AttachmentId),
  );
  if (attachment === undefined) {
    return false;
  }
  if (attachment.streamed_artifact) {
    if (attachment.streamed_artifact.expired) return false;
    await sendArtifact(
      context.dataDir,
      attachment,
      res,
      context.req.method === "HEAD",
    );
    return true;
  }
  const blob = await fileAttachmentStore(context.dataDir).get(
    attachment.sha256,
  );
  if (blob === undefined) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: { code: "not_found", message: "attachment content is missing" },
      }),
    );
    return true;
  }

  const mime = attachment.mime.toLowerCase();
  const inline = INLINE_MIME_TYPES.has(mime);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": blob.byteLength,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${downloadName(
      attachment.id,
      mime,
    )}"`,
    // Agent-written content must not be cached as an executable document.
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  res.end(context.req.method === "HEAD" ? undefined : Buffer.from(blob));
  return true;
}
