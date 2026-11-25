import { replaceAttachmentRefs } from "@cardigan/domain";
import type { AttachmentView } from "./api.js";

/**
 * C-615: attachments in comment bodies, and the upload rules of the comment
 * box.
 *
 * A body names an attachment by its plain number (`attachment-123`), as an
 * Agent writes it in `post_comment`. A file that is only being uploaded with
 * the comment has no number yet, and a posted comment cannot be edited, so
 * the body names it `attachment-new-N`: the N-th file sent with that comment.
 * The server reads it as the number that upload got (domain
 * attachment-refs.ts), for the Workbench and for Agents alike; the timeline
 * resolves it here too, for a body read before the uploads finished.
 */

/** Upload types, as `ATTACHMENT_EXTENSIONS` of the server (mcp-server). */
export const UPLOAD_TYPES: Readonly<Record<string, string>> = {
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
  // C-717: as MCP uploads; only downloads, never previews.
  "application/zip": "zip",
  // C-683: videos go through the resumable upload, with their own limit.
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-m4v": "m4v",
};
/** Video types, sent with `CardiganClient.uploadVideo` (C-683). */
export const isVideoType = (mime: string) =>
  /^video\/(mp4|quicktime|webm|x-m4v)$/u.test(
    mime.toLowerCase().split(";")[0]?.trim() ?? "",
  );
/** The server's default video limit (`CARDIGAN_VIDEO_MAX_MIB`). */
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
/** Other spellings of an extension, as `attachmentMimeForExtension`. */
const EXTENSION_ALIASES: Readonly<Record<string, string>> = {
  jpeg: "jpg",
  htm: "html",
  markdown: "md",
  log: "txt",
};
/** The server's default single-attachment limit (`MAX_ATTACHMENT_BYTES`). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The file chooser's `accept`: every type and extension the server takes. */
export const UPLOAD_ACCEPT = [
  ...Object.keys(UPLOAD_TYPES),
  ...Object.values(UPLOAD_TYPES).map((ext) => `.${ext}`),
  ...Object.keys(EXTENSION_ALIASES).map((ext) => `.${ext}`),
].join(",");

/**
 * The MIME type to upload a file as, or undefined when the server does not
 * take it. Browsers often leave `type` empty or vendor-specific for `.md` and
 * `.log`, so the extension decides when the type is not on the list.
 */
export function uploadMime(
  file: Pick<File, "name" | "type">,
): string | undefined {
  const type = file.type.toLowerCase();
  if (UPLOAD_TYPES[type]) return type;
  const extension = /\.([^./\\]+)$/u.exec(file.name)?.[1]?.toLowerCase();
  if (!extension) return undefined;
  const normalized = EXTENSION_ALIASES[extension] ?? extension;
  return Object.entries(UPLOAD_TYPES).find(
    ([, ext]) => ext === normalized,
  )?.[0];
}

/** A byte limit in MiB, as the server states it. */
export const formatMiB = (bytes: number) =>
  bytes % 1048576 === 0
    ? `${bytes / 1048576} MiB`
    : `${(bytes / 1048576).toFixed(1)} MiB`;

/**
 * Why a file cannot be uploaded, or undefined when it can. `maxBytes` is the
 * host's published limit; null when the server does not publish one (C-616),
 * which leaves the size to the server.
 */
export function uploadProblem(
  file: Pick<File, "name" | "type" | "size">,
  maxBytes: number | null = MAX_UPLOAD_BYTES,
  videoMaxBytes: number | null = MAX_VIDEO_BYTES,
): string | undefined {
  const mime = uploadMime(file);
  if (mime === undefined)
    return "不支持这种类型，可以上传图片、视频（mp4、mov、webm、m4v）、PDF、txt/log、md、json、html、zip";
  const limit = isVideoType(mime) ? videoMaxBytes : maxBytes;
  if (limit !== null && file.size > limit) return `超过 ${formatMiB(limit)}`;
  // The server's `original_filename` rules (domain `displayText`).
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(file.name)) return "文件名含控制字符";
  if ([...uploadFilename(file.name)].length > 200) return "文件名超过 200 字符";
  return undefined;
}

/**
 * C-717: a chosen file as the form adds it, or why it was left out. Every
 * refusal carries a reason to show; nothing is dropped silently. `oversize`
 * marks a file over the limit, for the form to name another way to share it.
 */
export function checkUpload(
  file: Pick<File, "name" | "type" | "size">,
  limits: {
    readonly maxBytes: number | null;
    readonly videoMaxBytes: number | null;
    /** False when this client cannot send videos. */
    readonly video: boolean;
  },
):
  | { readonly mime: string; readonly reason?: undefined }
  | {
      readonly mime?: undefined;
      readonly reason: string;
      readonly oversize?: true;
    } {
  const mime = uploadMime(file);
  if (mime && isVideoType(mime) && !limits.video)
    return { reason: "不支持上传视频" };
  const reason = uploadProblem(file, limits.maxBytes, limits.videoMaxBytes);
  if (reason) {
    const limit =
      mime && isVideoType(mime) ? limits.videoMaxBytes : limits.maxBytes;
    return mime && limit !== null && file.size > limit
      ? { reason, oversize: true }
      : { reason };
  }
  if (!mime) return { reason: "不支持这种类型" };
  return { mime };
}

/** A file left out of a form, as `FileProblems` lists it. */
export interface FileProblem {
  readonly name: string;
  readonly reason: string;
  readonly oversize?: true;
}

/** How a file is named in a refusal, even with no name or type. */
export const fileLabel = (file: Pick<File, "name" | "type">) =>
  file.name || file.type || "未命名文件";

/** The name sent as `original_filename`: its last path part, if not blank. */
export function uploadFilename(name: string): string {
  const base = name.split(/[\\/]/u).at(-1) ?? "";
  return base.trim() ? base : "";
}

/** A file's bytes as the base64 the upload endpoint takes. */
export async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function formatBytes(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1048576).toFixed(1)} MiB`;
}

/** How a reference opens: an image previews, video/pdf/text open in a tab. */
export type AttachmentRefKind = "image" | "video" | "pdf" | "text" | "file";

export function attachmentRefKind(
  mime: string,
  inline = true,
): AttachmentRefKind {
  const type = mime.toLowerCase().split(";")[0]?.trim() ?? "";
  if (inline && /^image\/(png|jpeg|gif|webp|avif)$/u.test(type)) return "image";
  // C-683: the browser's own player opens it in a tab.
  if (isVideoType(type)) return "video";
  if (type === "application/pdf") return "pdf";
  if (["text/plain", "text/markdown", "application/json"].includes(type))
    return "text";
  // SVG and HTML could run script in this origin: they only download.
  return "file";
}

/** What a chip needs to show; `href` is absent for a file not uploaded yet. */
export interface AttachmentRefTarget {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly kind: AttachmentRefKind;
  readonly href?: string;
  readonly thumbnail?: string;
  /** C-614: lightbox image of a bitmap (may be an off-site copy). */
  readonly preview?: string;
  /** Another card's attachment. */
  readonly cardId?: string;
}

export type AttachmentRefs = ReadonlyMap<string, AttachmentRefTarget>;

export function attachmentTarget(
  attachment: AttachmentView & { readonly card_id?: string },
  cardId?: string,
): AttachmentRefTarget {
  return {
    id: attachment.id,
    name: attachment.original_filename || attachment.id,
    mime: attachment.mime,
    size: attachment.size,
    kind: attachmentRefKind(attachment.mime, attachment.inline),
    href: attachment.download_path,
    ...(attachment.thumbnail_path
      ? { thumbnail: attachment.thumbnail_path }
      : {}),
    ...(attachment.preview_path ? { preview: attachment.preview_path } : {}),
    ...(attachment.card_id && attachment.card_id !== cardId
      ? { cardId: attachment.card_id }
      : {}),
  };
}

export const pendingToken = (n: number) => `attachment-new-${n}`;

/**
 * The references a comment's body may use: every attachment the reader can
 * see by number, and `attachment-new-N` for the file the comment's author
 * uploaded to it for slot N (`ref_slot`, as the server resolves it).
 */
export function entryAttachmentRefs(
  known: AttachmentRefs,
  entry: { readonly id: string; readonly author: string },
  attachments: readonly AttachmentView[],
): AttachmentRefs {
  const own = attachments.filter(
    (a) =>
      a.ref_slot !== undefined &&
      a.attach_to.kind === "timeline_entry" &&
      a.attach_to.id === entry.id &&
      a.uploaded_by === entry.author,
  );
  if (!own.length) return known;
  const refs = new Map(known);
  for (const attachment of own) {
    const target = known.get(attachment.id);
    const token = pendingToken(attachment.ref_slot ?? 0);
    if (target && !refs.has(token)) refs.set(token, target);
  }
  return refs;
}

/** Where the `#query` the caret is in starts, and what follows the `#`. */
export interface AttachmentQuery {
  readonly start: number;
  readonly query: string;
  /** End of the text a chosen reference replaces: the caret. */
  readonly end: number;
}

/**
 * The `#query` right before the caret: a `#` at the start, after a space or
 * after a non-ASCII character (`见#`), with no space up to the caret. A `#`
 * inside a URL, a word or a Markdown heading (`# `) offers nothing.
 */
export function attachmentQuery(
  text: string,
  caret: number,
): AttachmentQuery | undefined {
  const line = text.slice(0, caret);
  const start = line.lastIndexOf("#");
  if (start < 0) return undefined;
  const before = text[start - 1];
  if (before !== undefined && /[\x21-\x7e]/u.test(before)) return undefined;
  const query = line.slice(start + 1);
  if (/[\s#]/u.test(query)) return undefined;
  return { start, query, end: caret };
}

/**
 * Replace the `#query` with the reference. A space follows unless the text
 * after it already starts with a space or with a non-ASCII character such as
 * Chinese text or punctuation (`attachment-3，`), which ends the number too.
 */
export function insertAttachmentRef(
  body: string,
  query: AttachmentQuery,
  token: string,
): { body: string; caret: number } {
  const before = body.slice(0, query.start);
  const after = body.slice(query.end);
  const space = /^\s/u.test(after);
  const joined = /^[^\p{ASCII}]/u.test(after);
  const inserted = `${token}${space || joined ? "" : " "}`;
  return {
    body: before + inserted + after,
    caret: before.length + inserted.length + (space ? 1 : 0),
  };
}

/**
 * The body to post: the draft's own `attachment-new-K` (K is the file's
 * draft number) becomes `attachment-new-N`, N the file's place among the
 * files sent. A reference to a file no longer in the box is reported. Code
 * and link destinations are literal and stay as written (domain rule).
 */
export function numberPendingRefs(
  body: string,
  drafts: readonly number[],
): { body: string; missing: readonly string[] } {
  const missing = new Set<string>();
  const next = replaceAttachmentRefs(body, (match) => {
    if (!match.pending) return undefined;
    const index = drafts.indexOf(match.number);
    if (index < 0) {
      missing.add(match.token);
      return undefined;
    }
    return pendingToken(index + 1);
  });
  return { body: next, missing: [...missing] };
}
