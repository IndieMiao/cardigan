/**
 * C-683: what the uploader's browser measures about a video before it is
 * sent — duration and size from a `<video>` element, a cover frame drawn on
 * a canvas, and the codecs named in the container. The host stores these
 * with the attachment and never decodes the video itself.
 */
export interface VideoMeasurements {
  readonly duration_seconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly video_codec?: string;
  readonly audio_codec?: string;
}

export interface MeasuredVideo {
  readonly video: VideoMeasurements;
  /** Canonical base64 JPEG, at most `MAX_POSTER_BYTES`. */
  readonly poster?: string;
}

/** The server's `MAX_VIDEO_POSTER_BYTES`. */
export const MAX_POSTER_BYTES = 512 * 1024;
export const POSTER_WIDTH = 640;

const CODECS: Readonly<Record<string, string>> = {
  avc1: "h264",
  avc3: "h264",
  hvc1: "hevc",
  hev1: "hevc",
  vp08: "vp8",
  vp09: "vp9",
  av01: "av1",
  mp4v: "mpeg4",
  mp4a: "aac",
  Opus: "opus",
  "ac-3": "ac3",
  "ec-3": "eac3",
  fLaC: "flac",
  V_VP8: "vp8",
  V_VP9: "vp9",
  V_AV1: "av1",
  "V_MPEG4/ISO/AVC": "h264",
  A_OPUS: "opus",
  A_VORBIS: "vorbis",
  A_AAC: "aac",
};
const AUDIO = new Set([
  "mp4a",
  "Opus",
  "ac-3",
  "ec-3",
  "fLaC",
  "A_OPUS",
  "A_VORBIS",
  "A_AAC",
  "lpcm",
  "sowt",
  "twos",
  ".mp3",
]);
/** A container code as a short name the server accepts. */
const codecName = (code: string) =>
  CODECS[code] ??
  (code.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 32) || undefined);

async function bytes(file: Blob, start: number, end: number) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}
const u32 = (b: Uint8Array, i: number) =>
  ((b[i] ?? 0) * 2 ** 24 +
    ((b[i + 1] ?? 0) << 16) +
    ((b[i + 2] ?? 0) << 8) +
    (b[i + 3] ?? 0)) >>>
  0;
const text = (b: Uint8Array, i: number, n: number) =>
  String.fromCharCode(...b.subarray(i, i + n));

/**
 * Sample-entry codes of an ISO base media file (mp4, mov, m4v): find the
 * top-level `moov` by box headers only, then every `stsd`'s first entry.
 */
async function isoCodes(file: Blob): Promise<string[]> {
  let at = 0;
  for (let boxes = 0; at + 8 <= file.size && boxes < 64; boxes++) {
    const head = await bytes(file, at, at + 16);
    let size = u32(head, 0);
    const type = text(head, 4, 4);
    if (size === 1) size = u32(head, 8) * 2 ** 32 + u32(head, 12);
    else if (size === 0) size = file.size - at;
    if (size < 8) return [];
    if (type === "moov") {
      if (size > 64 * 1024 * 1024) return [];
      const moov = await bytes(file, at, at + size);
      const codes: string[] = [];
      for (let i = 4; i + 24 <= moov.length; i++)
        if (text(moov, i, 4) === "stsd") codes.push(text(moov, i + 16, 4));
      return codes;
    }
    at += size;
  }
  return [];
}

/** CodecID strings (`V_VP9`, `A_OPUS`) in the head of a webm file. */
async function webmCodes(file: Blob): Promise<string[]> {
  const head = await bytes(file, 0, Math.min(file.size, 1024 * 1024));
  const codes: string[] = [];
  for (let i = 0; i + 3 < head.length; i++) {
    if (head[i] !== 0x86) continue;
    const length = (head[i + 1] ?? 0) & 0x7f;
    const value = text(head, i + 2, length);
    if (length > 2 && /^[VA]_[A-Z0-9/]+$/u.test(value)) codes.push(value);
  }
  return codes;
}

/** Video and audio codec names from the container, when it names them. */
export async function containerCodecs(
  file: Blob,
  mime: string,
): Promise<Pick<VideoMeasurements, "video_codec" | "audio_codec">> {
  try {
    const codes =
      mime === "video/webm" ? await webmCodes(file) : await isoCodes(file);
    const video = codes.find((c) => !AUDIO.has(c));
    const audio = codes.find((c) => AUDIO.has(c));
    const v = video === undefined ? undefined : codecName(video);
    const a = audio === undefined ? undefined : codecName(audio);
    return {
      ...(v ? { video_codec: v } : {}),
      ...(a ? { audio_codec: a } : {}),
    };
  } catch {
    return {};
  }
}

const once = (target: EventTarget, ok: string, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("timeout")), ms);
    const done = (error?: Error) => {
      clearTimeout(timer);
      target.removeEventListener(ok, onOk);
      target.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onOk = () => done();
    const onError = () => done(new Error("error"));
    target.addEventListener(ok, onOk);
    target.addEventListener("error", onError);
  });

async function jpegBase64(
  canvas: HTMLCanvasElement,
): Promise<string | undefined> {
  for (const quality of [0.8, 0.6, 0.4]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (!blob) return undefined;
    if (blob.size <= MAX_POSTER_BYTES) {
      const data = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of data) binary += String.fromCharCode(byte);
      return btoa(binary);
    }
  }
  return undefined;
}

/**
 * Duration, size and a cover frame from the browser's own decoder, plus the
 * container's codec names. Anything the browser cannot read (an unsupported
 * codec, a timeout) is left out; the upload goes on without it.
 */
export async function measureVideo(
  file: File,
  mime: string,
  timeoutMs = 15_000,
): Promise<MeasuredVideo> {
  const codecs = await containerCodecs(file, mime);
  if (
    typeof document === "undefined" ||
    typeof URL.createObjectURL !== "function"
  )
    return { video: codecs };
  const url = URL.createObjectURL(file);
  const element = document.createElement("video");
  try {
    element.muted = true;
    element.preload = "metadata";
    element.playsInline = true;
    element.src = url;
    await once(element, "loadedmetadata", timeoutMs);
    const duration = Number.isFinite(element.duration)
      ? element.duration
      : undefined;
    const measured: VideoMeasurements = {
      ...(duration === undefined
        ? {}
        : { duration_seconds: Math.round(duration * 1000) / 1000 }),
      ...(element.videoWidth ? { width: element.videoWidth } : {}),
      ...(element.videoHeight ? { height: element.videoHeight } : {}),
      ...codecs,
    };
    let poster: string | undefined;
    try {
      // Skip a black first frame without passing the end of a short clip.
      element.currentTime =
        duration === undefined ? 0 : Math.min(1, duration / 10);
      await once(element, "seeked", timeoutMs);
      const scale = Math.min(
        1,
        POSTER_WIDTH / (element.videoWidth || POSTER_WIDTH),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(
        1,
        Math.round((element.videoWidth || POSTER_WIDTH) * scale),
      );
      canvas.height = Math.max(
        1,
        Math.round((element.videoHeight || 360) * scale),
      );
      canvas
        .getContext("2d")
        ?.drawImage(element, 0, 0, canvas.width, canvas.height);
      poster = await jpegBase64(canvas);
    } catch {
      poster = undefined;
    }
    return { video: measured, ...(poster ? { poster } : {}) };
  } catch {
    return { video: codecs };
  } finally {
    element.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}
