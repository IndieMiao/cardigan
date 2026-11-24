import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  VIDEO_HEADS,
  VIDEO_MIMES,
  videoBytes,
} from "../test-support/video-fixtures.js";
import {
  attachmentMimeForExtension,
  prepareAttachmentFile,
} from "./attachments.js";
import { checkVideoContent, isVideoMime, sniffVideo } from "./video-format.js";

test.each(Object.entries(VIDEO_MIMES))(
  "C-683: %s content is accepted as %s and its extension maps to it",
  (kind, mime) => {
    expect(() =>
      checkVideoContent(mime, videoBytes(kind as keyof typeof VIDEO_MIMES)),
    ).not.toThrow();
    expect(attachmentMimeForExtension(`.${kind}`)).toBe(mime);
    expect(attachmentMimeForExtension(kind.toUpperCase())).toBe(mime);
    expect(isVideoMime(`${mime}; codecs="avc1"`)).toBe(true);
  },
);

test.each([
  ["video/mp4", "png"],
  ["video/mp4", "webm"],
  ["video/quicktime", "matroska"],
  ["video/webm", "mp4"],
  ["video/webm", "matroska"],
  ["video/x-m4v", "png"],
] as const)("C-683: %s with %s content is refused", (mime, kind) => {
  expect(() => checkVideoContent(mime, VIDEO_HEADS[kind])).toThrow(
    /does not match the content/u,
  );
});

test("C-683: old QuickTime atoms and short or empty files", () => {
  const moov = Buffer.concat([
    Buffer.from([0, 0, 0, 8]),
    Buffer.from("moov"),
    Buffer.alloc(8),
  ]);
  expect(sniffVideo(moov)).toBe("iso");
  expect(sniffVideo(Buffer.alloc(0))).toBeUndefined();
  expect(sniffVideo(VIDEO_HEADS.webm.subarray(0, 3))).toBeUndefined();
  expect(() => checkVideoContent("video/mp4", Buffer.alloc(0))).toThrow();
});

test("C-683: other types are not sniffed (old uploads keep working)", () => {
  expect(() =>
    checkVideoContent("image/png", Buffer.from("not a png")),
  ).not.toThrow();
  expect(() =>
    checkVideoContent("video/x-msvideo", Buffer.from("RIFF")),
  ).not.toThrow();
  expect(isVideoMime("image/png")).toBe(false);
});

test("C-683: the shared base64 preflight checks a video's head", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cardigan-video-format-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await expect(
    prepareAttachmentFile(
      videoBytes("png").toString("base64"),
      dir,
      undefined,
      "video/mp4",
    ),
  ).rejects.toThrow(/does not match the content/u);
  await expect(
    prepareAttachmentFile(
      videoBytes("mp4").toString("base64"),
      dir,
      undefined,
      "video/mp4",
    ),
  ).resolves.toMatchObject({ size: 4096 });
  // Images are unchanged by the video check.
  await expect(
    prepareAttachmentFile(
      Buffer.from("png").toString("base64"),
      dir,
      undefined,
      "image/png",
    ),
  ).resolves.toMatchObject({ size: 3 });
});
