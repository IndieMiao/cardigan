import { expect, test } from "vitest";
import { containerCodecs, measureVideo } from "./video-probe.js";

/** C-683: codec names come from the container's own records, read in the browser. */
const box = (type: string, ...children: Uint8Array[]) => {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const stsd = (code: string) =>
  box(
    "stsd",
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
    box(code, Buffer.alloc(16)),
  );

test("mp4/mov: the moov box at the end still names both codecs", async () => {
  const file = new Blob([
    box("ftyp", Buffer.from("isom\0\0\x02\0", "latin1")),
    box("mdat", Buffer.alloc(4096, 7)),
    box(
      "moov",
      box("trak", box("mdia", box("minf", box("stbl", stsd("avc1"))))),
      box("trak", box("mdia", box("minf", box("stbl", stsd("mp4a"))))),
    ),
  ]);
  expect(await containerCodecs(file, "video/mp4")).toEqual({
    video_codec: "h264",
    audio_codec: "aac",
  });
  const hevc = new Blob([
    box("ftyp", Buffer.from("qt  \0\0\0\0", "latin1")),
    box("moov", stsd("hvc1")),
  ]);
  expect(await containerCodecs(hevc, "video/quicktime")).toEqual({
    video_codec: "hevc",
  });
});

test("webm: CodecID elements in the head", async () => {
  const id = (value: string) =>
    Buffer.concat([
      Buffer.from([0x86, 0x80 | value.length]),
      Buffer.from(value),
    ]);
  const file = new Blob([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.alloc(40),
    id("V_VP9"),
    Buffer.alloc(10),
    id("A_OPUS"),
  ]);
  expect(await containerCodecs(file, "video/webm")).toEqual({
    video_codec: "vp9",
    audio_codec: "opus",
  });
});

test("unreadable containers name nothing, and no document means codecs only", async () => {
  expect(
    await containerCodecs(new Blob([Buffer.alloc(3)]), "video/mp4"),
  ).toEqual({});
  expect(
    await containerCodecs(
      new Blob([box("free", Buffer.alloc(4))]),
      "video/mp4",
    ),
  ).toEqual({});
  // Outside a browser (no document) only the container is read.
  expect(
    await measureVideo(
      new File([box("moov", stsd("vp09"))], "a.mp4", { type: "video/mp4" }),
      "video/mp4",
    ),
  ).toEqual({ video: { video_codec: "vp9" } });
});
