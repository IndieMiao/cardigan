/**
 * C-809: which bitmap types a page may show in an `<img>` (M5 plan §3.2) and
 * how a file's leading bytes prove it is one. SVG, HTML and anything else
 * stays a download. Pure: callers pass the bytes they already read.
 */
export const INLINE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/** Leading bytes enough for every signature below (AVIF brands included). */
export const IMAGE_SIGNATURE_BYTES = 1024;

/**
 * Largest streamed image shown inline: the ordinary attachment ceiling
 * (`ATTACHMENT_MAX_MIB_CEILING`, 64 MiB), so thumbnails never read more of a
 * streamed file into memory than they do of an ordinary upload.
 */
export const MAX_INLINE_STREAMED_IMAGE_BYTES = 64 * 1024 * 1024;

export const isInlineImageMime = (mime: string) =>
  INLINE_IMAGE_MIME_TYPES.has(mime.toLowerCase());

const latin1 = (input: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...input.subarray(start, end));

/**
 * The inline bitmap type the bytes start with, or `undefined` for anything
 * else (including SVG, PDF or TIFF, which image decoders would also parse).
 */
export function imageSignatureMime(input: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) => latin1(input, start, end);
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 3) === "\xff\xd8\xff") return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (avifBrand(input, ascii)) return "image/avif";
  return undefined;
}

/**
 * An ISO-BMFF file type box naming AVIF as its major or one of its compatible
 * brands (e.g. major `mif1` with `avif` listed), read within the box bounds.
 */
function avifBrand(
  input: Uint8Array,
  ascii: (start: number, end: number) => string,
): boolean {
  if (input.byteLength < 16 || ascii(4, 8) !== "ftyp") return false;
  const size =
    (((input[0] ?? 0) << 24) |
      ((input[1] ?? 0) << 16) |
      ((input[2] ?? 0) << 8) |
      (input[3] ?? 0)) >>>
    0;
  // Sizes 0 (to end of file) and 1 (64-bit) are not used for this box, and
  // real ones list a handful of brands.
  if (
    size < 16 ||
    size > Math.min(input.byteLength, IMAGE_SIGNATURE_BYTES) ||
    size % 4 !== 0
  )
    return false;
  const brands = [ascii(8, 12)];
  for (let offset = 16; offset < size; offset += 4)
    brands.push(ascii(offset, offset + 4));
  return brands.some((brand) => brand === "avif" || brand === "avis");
}

/** The bytes carry the signature of exactly the declared inline type. */
export function imageMatchesMime(input: Uint8Array, mime: string): boolean {
  const declared = mime.toLowerCase();
  return (
    INLINE_IMAGE_MIME_TYPES.has(declared) &&
    imageSignatureMime(input) === declared
  );
}
