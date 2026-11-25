import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * C-683: the first bytes of each supported container (enough for the
 * server's format check), followed by filler, and fake ffprobe/ffmpeg
 * executables for hosts without the real tools.
 */
const box = (type: string, brand: string) =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from(type, "latin1"),
    Buffer.from(brand, "latin1"),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from("isomiso2", "latin1"),
  ]);
const ebml = (docType: string) =>
  Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]),
    Buffer.from([0x42, 0x82, 0x80 | docType.length]),
    Buffer.from(docType, "latin1"),
  ]);

export const VIDEO_HEADS = {
  mp4: box("ftyp", "isom"),
  mov: box("ftyp", "qt  "),
  m4v: box("ftyp", "M4V "),
  webm: ebml("webm"),
  matroska: ebml("matroska"),
  png: Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]),
} as const;

export const VIDEO_MIMES = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
} as const;

/** A "video" of `size` bytes with the container's head. */
export function videoBytes(
  kind: keyof typeof VIDEO_HEADS,
  size = 4096,
): Buffer {
  const head = VIDEO_HEADS[kind];
  const body = Buffer.alloc(Math.max(0, size - head.length));
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) % 251;
  return Buffer.concat([head, body]).subarray(0, Math.max(size, head.length));
}

/**
 * Fake ffprobe/ffmpeg in `dir`: ffprobe prints a duration; ffmpeg writes a
 * "JPEG" (FF D8 … FF D9) naming the `-ss` time and filter it was asked for
 * to its last argument. Every call appends its arguments to `calls.log`, so
 * a test can also prove that nothing called them (C-683: never the host).
 */
export async function fakeVideoTools(dir: string, duration = "74.5") {
  const log = join(dir, "calls.log");
  const script = (body: string) =>
    `#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([require("node:path").basename(process.argv[1]), ...args]) + "\\n");\nconst input = args.find((a, i) => args[i - 1] === "-i" || (a.startsWith("file:") && i === args.length - 1 && !args.includes("-i")));\nif (!input || !fs.statSync(input.replace(/^file:/, "")).isFile()) process.exit(3);\n${body}\n`;
  const ffprobe = join(dir, "ffprobe");
  const ffmpeg = join(dir, "ffmpeg");
  await writeFile(
    ffprobe,
    script(`process.stdout.write(${JSON.stringify(`${duration}\n`)});`),
  );
  await writeFile(
    ffmpeg,
    script(
      `const at = args[args.indexOf("-ss") + 1];\nconst vf = args[args.indexOf("-vf") + 1];\nconst out = args[args.length - 1].replace(/^file:/, "");\nfs.writeFileSync(out, Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(at + "|" + vf), Buffer.from([0xff, 0xd9])]), { flag: "wx" });`,
    ),
  );
  await chmod(ffprobe, 0o755);
  await chmod(ffmpeg, 0o755);
  return { dir, ffprobe, ffmpeg, log };
}

/** A tiny JPEG-looking poster (the host checks the marker only). */
export const POSTER_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("poster"),
  Buffer.from([0xff, 0xd9]),
]);
