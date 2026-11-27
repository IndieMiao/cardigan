import type { IncomingMessage, ServerResponse } from "node:http";
import type { AttachmentId, ProjectId } from "@cardigan/domain";
import {
  ATTACHMENT_EXTENSIONS,
  fileAttachmentStore,
  isVideoMime,
  offsiteFor,
  openAttachmentFile,
  sendArtifact,
  sendFileRange,
} from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import { inlineImageAttachment } from "./read.js";
import { localOnly, redirectToOffsite } from "./thumbnails.js";

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

function missingContent(res: ServerResponse) {
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      error: { code: "not_found", message: "attachment content is missing" },
    }),
  );
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
      undefined,
      inlineImageAttachment(attachment)
        ? { mime: attachment.mime.toLowerCase() }
        : undefined,
    );
    return true;
  }
  if (isVideoMime(attachment.mime)) {
    // C-683: a video streams from disk, with ranges for seeking; the page
    // plays it in a <video> element, so it is served inline.
    const mime = attachment.mime.toLowerCase();
    const file = await openAttachmentFile(
      context.dataDir,
      attachment.sha256,
      attachment.size,
    ).catch(() => undefined);
    if (!file) {
      missingContent(res);
      return true;
    }
    await sendFileRange(context.req, res, file, attachment.size, {
      "Content-Type": mime,
      "Content-Disposition": `inline; filename="${downloadName(attachment.id, mime)}"`,
      "Cache-Control": "private, no-store",
      // A tab opening it loads the file into the browser's player; a video
      // type under nosniff never runs as a page.
      "Content-Security-Policy": "default-src 'none'; media-src 'self'",
    });
    return true;
  }
  const blob = await fileAttachmentStore(context.dataDir).get(
    attachment.sha256,
  );
  if (blob === undefined) {
    missingContent(res);
    return true;
  }

  const mime = attachment.mime.toLowerCase();
  const inline = inlineImageAttachment(attachment);
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

/**
 * C-614: the lightbox image. A verified off-site copy is resized by OSS and
 * loaded from a signed URL; otherwise (or with `?local=1`) this is the same
 * inline original the download route serves. Only inline bitmaps qualify.
 */
export async function serveAttachmentPreview(
  context: AttachmentDownloadContext,
): Promise<boolean> {
  const { store, project_id, attachment_id, req, res } = context;
  const attachment = store.uow.read((tx) =>
    tx.attachments.get(project_id, attachment_id as AttachmentId),
  );
  if (attachment === undefined || !inlineImageAttachment(attachment))
    return false;
  // C-809: a streamed image has no off-site preview copy; it is served whole.
  const remote =
    localOnly(req) || attachment.streamed_artifact
      ? undefined
      : offsiteFor(context.dataDir)?.previewUrl(
          attachment.sha256,
          attachment.mime.toLowerCase(),
        );
  if (remote) {
    redirectToOffsite(res, remote);
    return true;
  }
  return serveAttachment(context);
}

/**
 * C-683: a video's cover frame, as the uploader's browser made it (stored
 * as its own verified blob). False when the project has no such video or it
 * has no cover; the page then shows a plain video tile. The host never
 * decodes the video or the image.
 */
export async function serveVideoPoster(
  context: AttachmentDownloadContext,
): Promise<boolean> {
  const { store, project_id, attachment_id, res } = context;
  const attachment = store.uow.read((tx) =>
    tx.attachments.get(project_id, attachment_id as AttachmentId),
  );
  const digest = attachment?.video?.poster_sha256;
  if (
    attachment === undefined ||
    attachment.streamed_artifact ||
    !isVideoMime(attachment.mime) ||
    digest === undefined
  )
    return false;
  const poster = await fileAttachmentStore(context.dataDir)
    .get(digest)
    .catch(() => undefined);
  if (poster === undefined) {
    missingContent(res);
    return true;
  }
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": poster.byteLength,
    "Cache-Control": "private, max-age=600",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  res.end(context.req.method === "HEAD" ? undefined : Buffer.from(poster));
  return true;
}
