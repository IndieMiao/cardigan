import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runAgentTool } from "../test-support/agent-tools.js";
import { fakeVideoTools, videoBytes } from "../test-support/video-fixtures.js";
import { sha256 } from "./attachments.js";
import {
  extractFrames,
  FrameError,
  frameTimes,
  parseFrameArgs,
} from "./video-frames.js";

/**
 * C-683: Agents take frames on their own worker: the download helper saves
 * the verified video and runs that worker's ffmpeg, or says clearly that
 * the worker has none.
 */
let dir: string;
let servers: Server[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cardigan-frames-"));
  servers = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(dir, { recursive: true, force: true });
});

test("frame times — requested, every n seconds, or spread; never past the end", () => {
  expect(frameTimes(74.5, {})).toEqual([0, 14.89, 29.78, 44.67, 59.56, 74.45]);
  expect(frameTimes(74.5, { max: 1 })).toEqual([37.225]);
  expect(frameTimes(74.5, { at: [3, 30, 999] })).toEqual([3, 30, 74.45]);
  expect(frameTimes(74.5, { every: 30 })).toEqual([0, 30, 60]);
  expect(frameTimes(74.5, { every: 1, max: 4 })).toEqual([0, 1, 2, 3]);
  expect(frameTimes(74.5, { every: 0, max: 2 })).toEqual([0, 0.04]);
  expect(frameTimes(null, {})).toEqual([0]);
  expect(frameTimes(10, { max: 99 })).toHaveLength(24);
});

test("frame options are checked before anything is downloaded", () => {
  expect(parseFrameArgs([])).toBeUndefined();
  expect(
    parseFrameArgs(["--frames", "out", "--every", "10", "--width", "640"]),
  ).toEqual({
    directory: "out",
    request: { every: 10, max: undefined, width: 640 },
  });
  expect(
    parseFrameArgs(["--frames", "out", "--at", "3,30.5"])?.request,
  ).toMatchObject({
    at: [3, 30.5],
  });
  for (const bad of [
    ["--every", "10"],
    ["--frames", "out", "--at", "3,x"],
    ["--frames", "out", "--at", "1", "--every", "2"],
    ["--frames", "out", "--max", "0"],
    ["--frames", "out", "--width", "99999"],
    ["--frames", "out", "--frames", "again"],
    ["--frames", "out", "--rm", "-rf"],
    ["--frames"],
  ])
    expect(() => parseFrameArgs(bad)).toThrow(FrameError);
});

test("frames are written by the worker's ffmpeg into a new directory", async () => {
  const fake = await fakeVideoTools(dir);
  const video = join(dir, "clip.mp4");
  await writeFile(video, videoBytes("mp4"));
  const out = join(dir, "frames");
  const made = await extractFrames(
    video,
    out,
    { at: [3, 30], width: 480 },
    fake,
  );
  expect(made.duration_seconds).toBe(74.5);
  expect(made.frames.map((f) => f.at_seconds)).toEqual([3, 30]);
  expect(await readdir(out)).toEqual([
    "frame-01-3.000s.jpg",
    "frame-02-30.000s.jpg",
  ]);
  expect(
    (await readFile(join(out, "frame-02-30.000s.jpg")))
      .subarray(2, -2)
      .toString(),
  ).toBe("30.000|scale='min(480,iw)':-2");
  // An existing directory is never reused.
  await expect(extractFrames(video, out, {}, fake)).rejects.toThrow(
    /\[directory\]/u,
  );
});

test("a worker without ffmpeg gets a clear message", async () => {
  const video = join(dir, "clip.mp4");
  await writeFile(video, videoBytes("mp4"));
  await expect(
    extractFrames(
      video,
      join(dir, "frames"),
      {},
      {
        ffmpeg: join(dir, "none"),
        ffprobe: join(dir, "none"),
      },
    ),
  ).rejects.toThrow(
    /\[ffmpeg\].*not installed on this worker.*本机没有 ffmpeg/su,
  );
});

async function videoServer(body: Buffer) {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-length": body.length,
      "x-attachment-id": "F-7",
      "x-attachment-sha256": sha256(body),
      "x-artifact-size": body.length,
    });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

test("the prebuilt download helper saves the video and its frames on the worker", async () => {
  const fake = await fakeVideoTools(dir);
  vi.stubEnv("PATH", `${fake.dir}:${process.env.PATH ?? ""}`);
  const body = videoBytes("mov", 50_000);
  const url = await videoServer(body);
  const file = join(dir, "demo.mov");
  const frames = join(dir, "demo-frames");
  const result = await runAgentTool(
    "download-attachment",
    [url, "F-7", file, "--frames", frames, "--every", "30"],
    "worker-token",
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    attachment_id: "F-7",
    size: body.length,
    duration_seconds: 74.5,
    frames: [
      { at_seconds: 0, file: join(frames, "frame-01-0.000s.jpg") },
      { at_seconds: 30, file: join(frames, "frame-02-30.000s.jpg") },
      { at_seconds: 60, file: join(frames, "frame-03-60.000s.jpg") },
    ],
  });
  expect((await readFile(file)).equals(body)).toBe(true);
});

test("without ffmpeg the helper still saves the video and says what is missing", async () => {
  vi.stubEnv("PATH", "/nonexistent");
  const body = videoBytes("webm", 2000);
  const url = await videoServer(body);
  const file = join(dir, "demo.webm");
  const result = await runAgentTool(
    "download-attachment",
    [url, "F-7", file, "--frames", join(dir, "f")],
    "worker-token",
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/\[ffmpeg\].*本机没有 ffmpeg/su);
  expect((await readFile(file)).equals(body)).toBe(true);
  // Unknown options fail before any download.
  const refused = await runAgentTool(
    "download-attachment",
    [url, "F-7", join(dir, "x.webm"), "--frames"],
    "worker-token",
  );
  expect(refused.stderr).toMatch(/\[arguments\]/u);
});
