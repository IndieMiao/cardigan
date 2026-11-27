import { expect, test } from "vitest";
import {
  artifactUploadRun,
  prepareStreamedArtifact,
  uploadAttachment,
} from "./commands/attachments.js";
import { postComment } from "./commands/coordination.js";
import {
  actor,
  apply,
  fixture,
  id,
  ports,
  value,
} from "./commands/test-fixtures.js";
import {
  IMAGE_SIGNATURE_BYTES,
  imageMatchesMime,
  imageSignatureMime,
  MAX_INLINE_STREAMED_IMAGE_BYTES,
} from "./image-signature.js";

const bytes = (text: string, length = 32) => {
  const out = new Uint8Array(Math.max(length, text.length));
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
};
const avif = (major: string, compatible: string[]) =>
  bytes(
    `\x00\x00\x00${String.fromCharCode(16 + 4 * compatible.length)}ftyp${major}\x00\x00\x00\x00${compatible.join("")}`,
  );
const PNG = bytes("\x89PNG\r\n\x1a\n");
const JPEG = bytes("\xff\xd8\xff\xe0");
const GIF = bytes("GIF89a");
const WEBP = bytes("RIFF\x10\x00\x00\x00WEBPVP8 ");
const AVIF = avif("mif1", ["mif1", "avif"]);
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg">');

test("C-809: each inline bitmap type is recognised by its leading bytes", () => {
  expect(imageSignatureMime(PNG)).toBe("image/png");
  expect(imageSignatureMime(JPEG)).toBe("image/jpeg");
  expect(imageSignatureMime(bytes("GIF87a"))).toBe("image/gif");
  expect(imageSignatureMime(GIF)).toBe("image/gif");
  expect(imageSignatureMime(WEBP)).toBe("image/webp");
  expect(imageSignatureMime(AVIF)).toBe("image/avif");
  expect(imageSignatureMime(avif("avis", []))).toBe("image/avif");
  for (const other of [
    SVG,
    bytes("%PDF-1.7"),
    bytes("II*\x00"),
    avif("heic", ["mif1"]),
    // A box claiming more bytes than were read is not trusted.
    bytes("\x00\x00\x08\x00ftypavif"),
    new Uint8Array(0),
  ])
    expect(imageSignatureMime(other)).toBeUndefined();
});

test("C-809: the bytes must match the declared type, which must be an inline type", () => {
  expect(imageMatchesMime(PNG, "image/png")).toBe(true);
  expect(imageMatchesMime(PNG, "IMAGE/PNG")).toBe(true);
  expect(imageMatchesMime(JPEG, "image/png")).toBe(false);
  expect(imageMatchesMime(SVG, "image/svg+xml")).toBe(false);
  expect(imageMatchesMime(PNG, "application/octet-stream")).toBe(false);
});

async function streamed(
  mime: string,
  header: Uint8Array | undefined,
  size = 2048,
) {
  const io = ports();
  const posted = value(
    postComment(
      fixture(),
      actor(),
      { card_id: id("card", 1), body: "Shot" },
      io,
    ),
  );
  if (!posted.data) throw new Error("Missing comment");
  const state = apply(fixture(), posted);
  const target = {
    card_id: id("card", 1),
    mime,
    kind: "evidence" as const,
    attach_to: { kind: "timeline_entry" as const, id: posted.data.id },
  };
  const run = value(artifactUploadRun(state, actor(), target)).data;
  const receipt = await prepareStreamedArtifact(run, async () => ({
    sha256: "b".repeat(64),
    size,
    id: "473bd8c2-5552-44a5-ad33-8b5492ee15b3",
    ...(header ? { header } : {}),
  }));
  return value(uploadAttachment(state, actor(), target, receipt, io)).data;
}

test("C-809: a streamed upload is marked inline only when its header matches its image type", async () => {
  expect((await streamed("image/png", PNG)).streamed_artifact).toMatchObject({
    inline_image: true,
  });
  expect(
    (await streamed("image/avif", AVIF)).streamed_artifact?.inline_image,
  ).toBe(true);
  for (const [mime, header, size] of [
    ["image/png", JPEG, 2048],
    ["image/png", SVG, 2048],
    ["image/svg+xml", SVG, 2048],
    ["application/octet-stream", PNG, 2048],
    ["image/png", undefined, 2048],
    ["image/png", PNG, MAX_INLINE_STREAMED_IMAGE_BYTES + 1],
  ] as const) {
    const attachment = await streamed(mime, header, size);
    expect(attachment.streamed_artifact).toBeDefined();
    expect(attachment.streamed_artifact).not.toHaveProperty("inline_image");
  }
});

test("C-809: the receipt keeps only the leading bytes the check needs", async () => {
  const header = new Uint8Array(IMAGE_SIGNATURE_BYTES * 4);
  header.set(PNG);
  const receipt = await prepareStreamedArtifact("R-1" as never, async () => ({
    sha256: "c".repeat(64),
    size: header.length,
    id: "473bd8c2-5552-44a5-ad33-8b5492ee15b3",
    header,
  }));
  expect(receipt.header?.byteLength).toBe(IMAGE_SIGNATURE_BYTES);
  // Never stored on the record itself.
  expect(receipt.stream).not.toHaveProperty("header");
});
