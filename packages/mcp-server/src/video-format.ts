import { ToolError } from "./errors.js";

/**
 * C-683: the video types every upload path accepts, with the extension a
 * download is named by. Imports nothing but errors, so the Workbench, the CLI
 * and the MCP tools share one list.
 */
export const VIDEO_EXTENSIONS: Readonly<Record<string, string>> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-m4v": "m4v",
};

/** MIME without parameters, lower case. */
const bare = (mime: string) => (mime.split(";")[0] ?? "").trim().toLowerCase();

export const isVideoMime = (mime: string) =>
  Object.hasOwn(VIDEO_EXTENSIONS, bare(mime));

/** Bytes `sniffVideo` needs; a shorter file is judged by what it has. */
export const VIDEO_SNIFF_BYTES = 64;

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/**
 * The container the first bytes show: `iso` for ISO base media (mp4, m4v,
 * QuickTime mov), `webm` for an EBML file whose DocType is webm. Anything
 * else (including Matroska that is not webm) is undefined.
 */
export function sniffVideo(head: Uint8Array): "iso" | "webm" | undefined {
  if (head.length >= 12) {
    const box = ascii(head, 4, 8);
    // `ftyp` leads every mp4/m4v and modern mov; old QuickTime files may
    // start with another top-level atom.
    if (box === "ftyp") return "iso";
    if (["moov", "mdat", "wide", "free", "skip", "pnot"].includes(box))
      return "iso";
  }
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    // The EBML header carries DocType (element 0x4282) within its first bytes.
    for (let i = 4; i + 6 <= head.length; i++)
      if (head[i] === 0x42 && head[i + 1] === 0x82) {
        const length = (head[i + 2] ?? 0) & 0x7f;
        const docType = ascii(
          head,
          i + 3,
          Math.min(head.length, i + 3 + length),
        );
        return docType === "webm" ? "webm" : undefined;
      }
  }
  return undefined;
}

/**
 * Refuse a video whose content is not the claimed type: mp4, m4v and mov are
 * ISO base media, webm is EBML with DocType webm. Other types pass unchanged.
 */
export function checkVideoContent(mime: string, head: Uint8Array): void {
  const type = bare(mime);
  if (!isVideoMime(type)) return;
  const found = sniffVideo(head);
  const expected = type === "video/webm" ? "webm" : "iso";
  if (found !== expected)
    throw ToolError.validation(
      `File content is not ${VIDEO_EXTENSIONS[type]} video; the extension or type does not match the content`,
    );
}
