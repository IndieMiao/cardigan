/** C-540: attachment thumbnails are rendered once, cached and access-checked. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, CardId, TimelineEntry } from "@cardigan/domain";
import sharp from "sharp";
import { afterEach, expect, test } from "vitest";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import {
  renderThumbnail,
  THUMBNAIL_WIDTH,
  ThumbnailCache,
} from "./thumbnails.js";

const RED = { r: 255, g: 0, b: 0 },
  BLUE = { r: 0, g: 0, b: 255 };
const solid = (width: number, height: number, background = RED) =>
  sharp({ create: { width, height, channels: 3, background } });
/** A long screenshot: red top, blue everything below `top` pixels. */
const stitched = (width: number, height: number, top: number) =>
  solid(width, height, BLUE)
    .composite([
      {
        input: { create: { width, height: top, channels: 3, background: RED } },
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
const size = async (bytes: Uint8Array) => {
  const { width, height, format } = await sharp(bytes).metadata();
  return { width, height, format };
};
const digest = (n: number) => n.toString(16).padStart(64, "0");

const PASSWORD = "thumbnail-test-password";
let h: WebHarness | undefined;
const directories: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
}, 30_000);
const temporary = async () => {
  const directory = await mkdtemp(join(tmpdir(), "cardigan-thumbnails-"));
  directories.push(directory);
  return directory;
};

test("thumbnails cap the width, keep small images and never enlarge", async () => {
  expect(
    await size(await renderThumbnail(await solid(1440, 900).png().toBuffer())),
  ).toEqual({ width: THUMBNAIL_WIDTH, height: 300, format: "webp" });
  expect(
    await size(await renderThumbnail(await solid(120, 60).jpeg().toBuffer())),
  ).toEqual({ width: 120, height: 60, format: "webp" });
  // Portrait up to 3:4 keeps its whole frame.
  expect(
    await size(await renderThumbnail(await solid(600, 800).webp().toBuffer())),
  ).toEqual({ width: 480, height: 640, format: "webp" });
  expect(
    await size(await renderThumbnail(await solid(40, 30).gif().toBuffer())),
  ).toEqual({ width: 40, height: 30, format: "webp" });
});

test("long screenshots keep their top at 3:4 instead of shrinking to a sliver", async () => {
  // 390 wide, 20 screens tall: the original rendered as a 2px column.
  const thumbnail = await renderThumbnail(await stitched(390, 16000, 600));
  expect(await size(thumbnail)).toEqual({
    width: 390,
    height: 520,
    format: "webp",
  });
  const { channels } = await sharp(thumbnail).stats();
  // Only the red top survives: no blue below the 520px crop.
  expect(channels[0]?.min).toBeGreaterThan(200);
  expect(channels[2]?.max).toBeLessThan(60);
  expect(
    await size(await renderThumbnail(await stitched(1440, 12000, 100))),
  ).toEqual({ width: 480, height: 640, format: "webp" });
});

test("undecodable, truncated or non-bitmap content is rejected", async () => {
  const png = await solid(400, 400).png().toBuffer();
  for (const input of [
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>',
    ),
    Buffer.from("not an image"),
    png.subarray(0, png.byteLength / 2),
  ])
    await expect(renderThumbnail(input)).rejects.toThrow();
});

test("the cache renders each blob once, across concurrent requests and restarts", async () => {
  const dataDir = await temporary(),
    png = await solid(900, 600).png().toBuffer();
  let renders = 0,
    reads = 0;
  const render = (input: Uint8Array) => {
    renders++;
    return renderThumbnail(input);
  };
  const source = async () => {
    reads++;
    return png;
  };
  const cache = new ThumbnailCache(dataDir, render);
  const [first, second] = await Promise.all([
    cache.get(digest(1), source),
    cache.get(digest(1), source),
  ]);
  expect(renders).toBe(1);
  expect(Buffer.isBuffer(first) && first.equals(second as Buffer)).toBe(true);
  expect(await cache.get(digest(1), source)).toEqual(first);
  // A new process finds the file and neither reads the original nor renders.
  const restarted = new ThumbnailCache(dataDir, render);
  expect(await restarted.get(digest(1), source)).toEqual(first);
  expect({ renders, reads }).toEqual({ renders: 1, reads: 1 });
  expect(await readdir(join(dataDir, "attachment-thumbnails", "v1"))).toEqual([
    `${digest(1)}.webp`,
  ]);
  // The original blob is untouched.
  expect(png.equals(await solid(900, 600).png().toBuffer())).toBe(true);
});

test("failures are remembered and a missing blob is reported separately", async () => {
  const dataDir = await temporary();
  let renders = 0;
  const cache = new ThumbnailCache(dataDir, async () => {
    renders++;
    throw new Error("broken");
  });
  const source = async () => Buffer.from("broken");
  expect(await cache.get(digest(2), source)).toBe("unavailable");
  expect(await cache.get(digest(2), source)).toBe("unavailable");
  expect(renders).toBe(1);
  expect(await cache.get(digest(3), async () => undefined)).toBe("missing");
  expect(() => cache.get("../../etc/passwd", source)).toThrow();
});

test("the thumbnail route has the original's session and project checks", async () => {
  h = await webHarness({ password: PASSWORD });
  seedWebProject(h.store, h.dataDir);
  // A real long screenshot next to the seeded fake PNG (F-1) and SVG (F-3).
  const original = await stitched(390, 16000, 600),
    sha = createHash("sha256").update(original).digest("hex");
  await mkdir(join(h.dataDir, "attachments"), { recursive: true });
  await writeFile(join(h.dataDir, "attachments", sha), original);
  h.store.uow.run((tx) =>
    tx.attachments.put(project_id, {
      id: "F-9" as Attachment["id"],
      sha256: sha,
      mime: "image/png",
      size: original.byteLength,
      card_id: "C-1" as CardId,
      uploaded_by: "assignment:A-1",
      storage_path: `attachments/${sha}`,
      attach_to: { kind: "timeline_entry", id: "C-1#1" as TimelineEntry["id"] },
      kind: "evidence",
    }),
  );
  const at = (suffix: string, scope = project_id as string) =>
      `/api/projects/${scope}${suffix}`,
    path = at("/attachments/F-9/thumbnail");
  expect((await call(h.port, path)).status).toBe(401);
  expect(
    (await call(h.port, path, { cookie: "cardigan_session=invalid" })).status,
  ).toBe(401);
  expect(
    (await call(h.port, path, { headers: { authorization: "Bearer fixture" } }))
      .status,
  ).toBe(401);
  const cookie = await h.login(PASSWORD);

  const response = await call(h.port, path, { cookie });
  expect(response.status).toBe(200);
  expect(response.headers).toMatchObject({
    "content-type": "image/webp",
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
  });
  expect(String(response.headers["content-security-policy"])).toContain(
    "sandbox",
  );
  expect(await size(response.bytes)).toEqual({
    width: 390,
    height: 520,
    format: "webp",
  });
  expect(response.bytes.byteLength).toBeLessThan(original.byteLength / 4);
  const etag = String(response.headers.etag);
  expect(
    (await call(h.port, path, { cookie, headers: { "if-none-match": etag } }))
      .status,
  ).toBe(304);
  // Revalidation still needs a session.
  expect(
    (await call(h.port, path, { headers: { "if-none-match": etag } })).status,
  ).toBe(401);
  expect(
    (
      await call(h.port, path, {
        cookie,
        method: "POST",
        headers: { origin: h.server.url },
      })
    ).status,
  ).toBe(405);

  // Opening or downloading still gets the original bytes.
  const download = await call(h.port, at("/attachments/F-9"), { cookie });
  expect(download.status).toBe(200);
  expect(download.bytes.equals(original)).toBe(true);

  // Another project cannot reach this attachment through its thumbnail.
  h.store.createProject({ id: "other", name: "Other" });
  expect(
    (await call(h.port, at("/attachments/F-9/thumbnail", "other"), { cookie }))
      .status,
  ).toBe(404);
  expect(
    (await call(h.port, at("/attachments/absent/thumbnail"), { cookie }))
      .status,
  ).toBe(404);
  // Non-bitmap attachments have no thumbnail; broken bitmaps fail cleanly.
  expect(
    (await call(h.port, at("/attachments/F-3/thumbnail"), { cookie })).status,
  ).toBe(404);
  const failed = await call(h.port, at("/attachments/F-1/thumbnail"), {
    cookie,
  });
  expect(failed.status).toBe(422);
  expect(failed.json).toMatchObject({
    error: { code: "thumbnail_unavailable" },
  });
});
