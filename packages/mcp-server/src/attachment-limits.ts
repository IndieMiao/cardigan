/**
 * C-616: the ordinary attachment limit is host configuration
 * (`CARDIGAN_ATTACHMENT_MAX_MIB`, whole MiB). Everything derived from it —
 * base64 length, MCP and Workbench request bodies, CLI and helper checks —
 * comes from here. Imports nothing, so the prebuilt agent tools stay small.
 */
export const ATTACHMENT_MAX_MIB_ENV = "CARDIGAN_ATTACHMENT_MAX_MIB";
export const DEFAULT_ATTACHMENT_MAX_MIB = 10;
/** Largest configurable limit; larger files use the artifact upload channel. */
export const ATTACHMENT_MAX_MIB_CEILING = 64;
const MIB = 1024 * 1024;
/**
 * Reads of already stored blobs (store, metadata, downloads) are bounded by the
 * ceiling, not the current limit, so lowering the limit later keeps every
 * accepted attachment readable.
 */
export const MAX_STORED_ATTACHMENT_BYTES = ATTACHMENT_MAX_MIB_CEILING * MIB;

export interface AttachmentLimits {
  readonly mib: number;
  readonly bytes: number;
  /** Canonical padded base64 length of `bytes`. */
  readonly base64: number;
  /** A full JSON request carrying one attachment: base64 plus 1 MiB envelope. */
  readonly bodyBytes: number;
}

export const base64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);

export function attachmentLimits(
  mib = DEFAULT_ATTACHMENT_MAX_MIB,
): AttachmentLimits {
  if (!Number.isSafeInteger(mib) || mib < 1 || mib > ATTACHMENT_MAX_MIB_CEILING)
    throw new Error(
      `${ATTACHMENT_MAX_MIB_ENV} must be an integer from 1 to ${ATTACHMENT_MAX_MIB_CEILING}`,
    );
  const bytes = mib * MIB;
  const base64 = base64Length(bytes);
  return Object.freeze({ mib, bytes, base64, bodyBytes: base64 + MIB });
}

/** Unset or blank means the default; anything but a plain integer is refused. */
export function resolveAttachmentLimits(
  env: Readonly<Record<string, string | undefined>>,
): AttachmentLimits {
  const text = env[ATTACHMENT_MAX_MIB_ENV]?.trim();
  if (!text) return attachmentLimits();
  if (!/^\d{1,3}$/u.test(text)) return attachmentLimits(Number.NaN);
  return attachmentLimits(Number(text));
}

/** Human-readable limit for error messages and hints, e.g. `30 MiB`. */
export const formatAttachmentLimit = (bytes: number) =>
  bytes < MIB
    ? `${bytes} bytes`
    : bytes % MIB === 0
      ? `${bytes / MIB} MiB`
      : `${(bytes / MIB).toFixed(1)} MiB`;

/**
 * Inverse of the published base64 bound: host limits are whole MiB, so round
 * down to one; sub-MiB bounds (tests, odd servers) stay exact.
 */
export function limitFromBase64Length(maxLength: number): number {
  const bytes = Math.floor(maxLength / 4) * 3;
  return bytes >= MIB ? Math.floor(bytes / MIB) * MIB : bytes;
}

/**
 * C-683: videos have their own limit (`CARDIGAN_VIDEO_MAX_MIB`, whole MiB).
 * They never travel as one base64 JSON request: every client sends them in
 * chunks of `VIDEO_CHUNK_BYTES` (Workbench, Agents) or streams a local file
 * (CLI), and reads stream from disk instead of loading the blob.
 */
export const VIDEO_MAX_MIB_ENV = "CARDIGAN_VIDEO_MAX_MIB";
export const DEFAULT_VIDEO_MAX_MIB = 1024;
/** Same ceiling as streamed artifacts (`MAX_ARTIFACT_BYTES`). */
export const VIDEO_MAX_MIB_CEILING = 2048;
/** Largest stored video any reader accepts, whatever the current limit. */
export const MAX_STORED_VIDEO_BYTES = VIDEO_MAX_MIB_CEILING * MIB;
/** One chunk of a resumable upload. */
export const VIDEO_CHUNK_BYTES = 8 * MIB;

/** Unset or blank means the default; anything but a plain integer is refused. */
export function resolveVideoMaxBytes(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const text = env[VIDEO_MAX_MIB_ENV]?.trim();
  if (!text) return DEFAULT_VIDEO_MAX_MIB * MIB;
  const mib = /^\d{1,4}$/u.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(mib) || mib < 1 || mib > VIDEO_MAX_MIB_CEILING)
    throw new Error(
      `${VIDEO_MAX_MIB_ENV} must be an integer from 1 to ${VIDEO_MAX_MIB_CEILING}`,
    );
  return mib * MIB;
}
