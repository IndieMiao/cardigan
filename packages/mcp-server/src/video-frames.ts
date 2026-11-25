import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * C-683: frames of a downloaded video, made on the Agent's own worker with
 * its ffmpeg — never on the host. Part of the prebuilt download helper, so
 * it only imports Node built-ins. Frames are JPEG files in a new directory;
 * nothing existing is overwritten.
 */
export interface FrameRequest {
  /** Seconds from the start; at most `MAX_FRAMES`. */
  readonly at?: readonly number[] | undefined;
  /** One frame every this many seconds, from 0. */
  readonly every?: number | undefined;
  /** Upper bound on frames (default `DEFAULT_FRAMES`). */
  readonly max?: number | undefined;
  /** Output width in pixels; the height keeps the aspect ratio. */
  readonly width?: number | undefined;
}

export const MAX_FRAMES = 24;
export const DEFAULT_FRAMES = 6;
export const DEFAULT_FRAME_WIDTH = 960;
const TIMEOUT_MS = 60_000;

export class FrameError extends Error {
  constructor(
    readonly stage: "ffmpeg" | "arguments" | "directory" | "decode",
    detail: string,
  ) {
    super(`Frame extraction failed [${stage}]: ${detail}`);
  }
}

const NO_FFMPEG =
  "ffmpeg (with ffprobe) is not installed on this worker, so no frames were made; the video itself was saved. Use a worker with ffmpeg or report a blocker. 本机没有 ffmpeg，无法抽帧（视频已保存）；请换装有 ffmpeg 的 worker 或报告阻塞。";

/** Run a tool; stdout as text. ENOENT/EACCES mean the tool is missing. */
function run(
  command: string,
  args: readonly string[],
  limit = 1024 * 1024,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new FrameError("decode", `${command} timed out`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (out.length < limit) out += chunk.toString("utf8");
    });
    child.stderr.resume();
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === "ENOENT" || error.code === "EACCES"
          ? new FrameError("ffmpeg", NO_FFMPEG)
          : new FrameError("decode", `${command} could not start`),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else
        reject(
          new FrameError(
            "decode",
            `${command} could not read the video (damaged or unsupported codec)`,
          ),
        );
    });
  });
}

/**
 * The times to take frames at: the requested ones (clamped into the video),
 * every `every` seconds, or `max` spread over the duration; never more than
 * `MAX_FRAMES` and never past the end.
 */
export function frameTimes(
  duration: number | null,
  request: FrameRequest,
): number[] {
  const max = Math.min(request.max ?? DEFAULT_FRAMES, MAX_FRAMES);
  const last = duration === null ? undefined : Math.max(0, duration - 0.05);
  const clamp = (t: number) =>
    Math.round(Math.max(0, last === undefined ? t : Math.min(t, last)) * 1000) /
    1000;
  if (request.at?.length) return request.at.slice(0, max).map(clamp);
  if (request.every !== undefined) {
    // At least one video frame apart, so the loop always ends.
    const step = Math.max(request.every, 0.04);
    const times: number[] = [];
    for (let t = 0; times.length < max; t += step) {
      if (last !== undefined && t > last) break;
      times.push(clamp(t));
    }
    return times;
  }
  if (last === undefined) return [0];
  if (max === 1) return [clamp(last / 2)];
  return Array.from({ length: max }, (_, i) => clamp((last * i) / (max - 1)));
}

/** `--frames <dir> [--every s | --at s,s] [--max n] [--width px]`. */
export function parseFrameArgs(args: readonly string[]):
  | {
      readonly directory: string;
      readonly request: FrameRequest;
    }
  | undefined {
  if (!args.length) return undefined;
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i] ?? "";
    const value = args[i + 1];
    if (
      !["--frames", "--every", "--at", "--max", "--width"].includes(name) ||
      value === undefined ||
      values.has(name)
    )
      throw new FrameError("arguments", "unknown or repeated option");
    values.set(name, value);
  }
  const directory = values.get("--frames");
  if (!directory)
    throw new FrameError("arguments", "--frames <new directory> is required");
  const number = (name: string, min: number, max: number, integer: boolean) => {
    const text = values.get(name);
    if (text === undefined) return undefined;
    const n = Number(text);
    if (
      !Number.isFinite(n) ||
      n < min ||
      n > max ||
      (integer && !Number.isInteger(n))
    )
      throw new FrameError("arguments", `${name} is out of range`);
    return n;
  };
  const at = values
    .get("--at")
    ?.split(",")
    .map((t) => {
      const n = Number(t);
      if (!t.trim() || !Number.isFinite(n) || n < 0)
        throw new FrameError("arguments", "--at takes seconds like 3,30");
      return n;
    });
  if (at && values.has("--every"))
    throw new FrameError("arguments", "use --at or --every, not both");
  return {
    directory,
    request: {
      ...(at ? { at } : {}),
      every: number("--every", 0.1, 86_400, false),
      max: number("--max", 1, MAX_FRAMES, true),
      width: number("--width", 160, 3840, true),
    },
  };
}

/**
 * Write JPEG frames of `video` into the new directory `directory` with the
 * worker's ffmpeg. Fails with a clear message when ffmpeg is missing.
 */
export async function extractFrames(
  video: string,
  directory: string,
  request: FrameRequest,
  tools: { ffmpeg?: string; ffprobe?: string } = {},
): Promise<{
  duration_seconds: number | null;
  frames: { at_seconds: number; file: string }[];
}> {
  const ffmpeg = tools.ffmpeg ?? "ffmpeg";
  const ffprobe = tools.ffprobe ?? "ffprobe";
  const probe = await run(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    `file:${resolve(video)}`,
  ]);
  const parsed = Number(probe.trim());
  const duration = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  await mkdir(directory, { mode: 0o700 }).catch(() => {
    throw new FrameError(
      "directory",
      "could not create a new directory; existing ones are never reused",
    );
  });
  const width = request.width ?? DEFAULT_FRAME_WIDTH;
  const frames: { at_seconds: number; file: string }[] = [];
  for (const [index, at] of frameTimes(duration, request).entries()) {
    const file = join(
      directory,
      `frame-${String(index + 1).padStart(2, "0")}-${at.toFixed(3)}s.jpg`,
    );
    await run(ffmpeg, [
      "-nostdin",
      "-v",
      "error",
      "-ss",
      at.toFixed(3),
      "-i",
      `file:${resolve(video)}`,
      "-frames:v",
      "1",
      "-vf",
      `scale='min(${width},iw)':-2`,
      "-q:v",
      "3",
      "-n",
      `file:${resolve(file)}`,
    ]);
    frames.push({ at_seconds: at, file });
  }
  return { duration_seconds: duration, frames };
}
