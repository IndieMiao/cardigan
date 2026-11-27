/** C-540: attachment thumbnails are rendered once, cached and access-checked. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  expect(
    await size(await renderThumbnail(await solid(64, 48).avif().toBuffer())),
  ).toEqual({ width: 64, height: 48, format: "webp" });
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
    await solid(16, 16).tiff().toBuffer(),
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>',
    ),
    Buffer.from("not an image"),
    png.subarray(0, png.byteLength / 2),
  ])
    await expect(renderThumbnail(input)).rejects.toThrow();
});

test("AVIF is recognised by a compatible brand inside the file type box", async () => {
  const avif = await solid(32, 24).avif().toBuffer();
  const box = avif.readUInt32BE(0);
  expect(avif.toString("latin1", 4, box)).toBe("ftypavif\0\0\0\0mif1avifmiaf");
  // Major brand mif1, avif only among the compatible brands.
  const mif1 = Buffer.from(avif);
  mif1.write("mif1", 8, "latin1");
  expect(await size(await renderThumbnail(mif1))).toEqual({
    width: 32,
    height: 24,
    format: "webp",
  });
  // No AVIF brand anywhere in the box (an HEIC-style file) is still refused.
  const heic = Buffer.from(avif);
  heic.write("heic", 8, "latin1");
  heic.write("mif1heicmiaf", 16, "latin1");
  await expect(renderThumbnail(heic)).rejects.toThrow("unsupported format");
  // A brand outside the declared box does not count.
  const short = Buffer.from(mif1);
  short.writeUInt32BE(20, 0);
  await expect(renderThumbnail(short)).rejects.toThrow("unsupported format");
  // Nor does a box claiming more bytes than the file has.
  const long = Buffer.from(mif1.subarray(0, box));
  long.writeUInt32BE(box + 4, 0);
  await expect(renderThumbnail(long)).rejects.toThrow("unsupported format");
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

test("cold renders read the original only once a render slot is free", async () => {
  const dataDir = await temporary();
  const releases: (() => void)[] = [];
  const read: number[] = [];
  const cache = new ThumbnailCache(
    dataDir,
    () =>
      new Promise<Buffer>((done) =>
        releases.push(() => done(Buffer.from("RIFF\x04\0\0\0WEBP", "latin1"))),
      ),
  );
  const settle = () => new Promise((ready) => setTimeout(ready, 20));
  const results = [4, 5, 6, 7].map((n) =>
    cache.get(digest(n), async () => {
      read.push(n);
      return Buffer.from("original");
    }),
  );
  await settle();
  // Two renders hold their originals; the others have not read theirs yet.
  expect(read).toEqual([4, 5]);
  releases.shift()?.();
  await settle();
  expect(read).toEqual([4, 5, 6]);
  for (; releases.length > 0 || read.length < 4; await settle())
    releases.shift()?.();
  expect(read).toEqual([4, 5, 6, 7]);
  expect((await Promise.all(results)).every(Buffer.isBuffer)).toBe(true);
});

test("cache entries that are not plain bounded WebP files are never served", async () => {
  const dataDir = await temporary(),
    png = await solid(300, 200).png().toBuffer();
  const directory = join(dataDir, "attachment-thumbnails", "v1");
  await mkdir(directory, { recursive: true });
  const secret = join(dataDir, "secret.webp");
  // A valid WebP outside the cache: following a link would leak it.
  const outside = await solid(10, 10, BLUE).webp().toBuffer();
  await writeFile(secret, outside);
  let renders = 0;
  const cache = () =>
    new ThumbnailCache(dataDir, (input) => {
      renders++;
      return renderThumbnail(input);
    });
  const fresh = await renderThumbnail(png);
  const entry = (n: number) => join(directory, `${digest(n)}.webp`);

  await symlink(secret, entry(10));
  execFileSync("mkfifo", [entry(11)]);
  const huge = Buffer.alloc(2 * 1024 * 1024);
  huge.write("RIFF", 0, "latin1");
  huge.writeUInt32LE(huge.byteLength - 8, 4);
  huge.write("WEBP", 8, "latin1");
  await writeFile(entry(12), huge);
  await writeFile(entry(13), Buffer.from("<script>alert(1)</script>"));
  await writeFile(entry(14), outside.subarray(0, outside.byteLength - 4));
  for (const n of [10, 11, 12, 13, 14]) {
    const before = renders;
    const output = await cache().get(digest(n), async () => png);
    expect(Buffer.isBuffer(output) && output.equals(fresh)).toBe(true);
    expect(renders).toBe(before + 1);
    // The bad entry was replaced by the rendered thumbnail, not written through.
    expect((await lstat(entry(n))).isFile()).toBe(true);
    expect(await cache().get(digest(n), async () => png)).toEqual(fresh);
    expect(renders).toBe(before + 1);
  }
  expect((await readFile(secret)).equals(outside)).toBe(true);

  // A symlinked cache directory is neither read nor written.
  const elsewhere = join(dataDir, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, `${digest(15)}.webp`), outside);
  await rm(directory, { recursive: true });
  await symlink(elsewhere, directory);
  const linked = cache();
  for (let i = 0; i < 2; i++)
    expect(await linked.get(digest(15), async () => png)).toEqual(fresh);
  expect(await readdir(elsewhere)).toEqual([`${digest(15)}.webp`]);
  expect(
    (await readFile(join(elsewhere, `${digest(15)}.webp`))).equals(outside),
  ).toBe(true);
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

test("C-809: a streamed image whose header matched is shown like an ordinary upload; others stay downloads", async () => {
  h = await webHarness({ password: PASSWORD });
  seedWebProject(h.store, h.dataDir);
  const original = await solid(64, 48).png().toBuffer();
  await mkdir(join(h.dataDir, "artifacts"), { recursive: true });
  const streamed = async (
    id: string,
    mime: string,
    body: Buffer,
    inline_image: boolean,
  ) => {
    const blob_id = randomUUID();
    await writeFile(join(h?.dataDir ?? "", "artifacts", blob_id), body);
    h?.store.uow.run((tx) =>
      tx.attachments.put(project_id, {
        id: id as Attachment["id"],
        sha256: createHash("sha256").update(body).digest("hex"),
        mime,
        size: body.byteLength,
        card_id: "C-1" as CardId,
        uploaded_by: "assignment:A-1",
        storage_path: `artifacts/${blob_id}`,
        attach_to: {
          kind: "timeline_entry",
          id: "C-1#1" as TimelineEntry["id"],
        },
        kind: "evidence",
        streamed_artifact: {
          blob_id,
          run_id: "R-1" as never,
          created_at: "2026-11-27T00:00:00.000Z" as never,
          ...(inline_image ? { inline_image: true as const } : {}),
        },
      }),
    );
  };
  // S-1 passed the upload's header check; S-2 is the same PNG recorded
  // without that mark (uploaded before C-809, or its header did not match);
  // S-3 is an SVG.
  await streamed("S-1", "image/png", original, true);
  await streamed("S-2", "image/png", original, false);
  await streamed("S-3", "image/svg+xml", Buffer.from("<svg/>"), false);
  h.store.uow.run((tx) => {
    const q = tx.decisions.get(project_id, "D-1" as never);
    if (!q) throw new Error("Missing seeded decision");
    tx.decisions.put(project_id, {
      ...q,
      attachment_ids: ["S-1", "S-2", "S-3"] as Attachment["id"][],
    });
  });
  const cookie = await h.login(PASSWORD);
  const at = (suffix: string) => `/api/projects/${project_id}${suffix}`;
  type View = {
    id: string;
    inline: boolean;
    thumbnail_path: string | null;
    preview_path: string | null;
  };
  const shown = (views: readonly View[]) =>
    Object.fromEntries(
      views
        .filter((v) => v.id.startsWith("S-"))
        .map((v) => [v.id, [v.inline, v.thumbnail_path, v.preview_path]]),
    );
  const expected = {
    "S-1": [
      true,
      at("/attachments/S-1/thumbnail"),
      at("/attachments/S-1/preview"),
    ],
    "S-2": [false, null, null],
    "S-3": [false, null, null],
  };
  // The card's attachment page and the decision card use the same rule.
  const detail = (await call(h.port, at("/cards/C-1"), { cookie })).json as {
    attachments: View[];
    decisions: { id: string; attachments: View[] }[];
  };
  expect(shown(detail.attachments)).toEqual(expected);
  expect(
    shown(detail.decisions.find((q) => q.id === "D-1")?.attachments ?? []),
  ).toEqual(expected);
  const needs = (await call(h.port, at("/needs-you"), { cookie })).json as {
    decisions: { id: string; attachments: View[] }[];
  };
  expect(
    shown(needs.decisions.find((q) => q.id === "D-1")?.attachments ?? []),
  ).toEqual(expected);

  const download = await call(h.port, at("/attachments/S-1"), { cookie });
  expect(download.status).toBe(200);
  // The same headers an ordinary inline image gets (seeded F-1).
  const ordinary = await call(h.port, at("/attachments/F-1"), { cookie });
  for (const [name, value] of [
    ["content-type", "image/png"],
    ["content-disposition", 'inline; filename="S-1.png"'],
    ["cache-control", "private, no-store"],
    ["content-security-policy", "default-src 'none'; sandbox"],
    ["x-content-type-options", "nosniff"],
  ] as const) {
    expect(download.headers[name], name).toBe(value);
    expect(ordinary.headers[name], name).toBe(value.replace("S-1", "F-1"));
  }
  expect(download.bytes.equals(original)).toBe(true);
  const preview = await call(h.port, at("/attachments/S-1/preview"), {
    cookie,
  });
  expect(preview.status).toBe(200);
  expect(preview.bytes.equals(original)).toBe(true);
  const thumbnail = await call(h.port, at("/attachments/S-1/thumbnail"), {
    cookie,
  });
  expect(thumbnail.status).toBe(200);
  expect(await size(thumbnail.bytes)).toEqual({
    width: 64,
    height: 48,
    format: "webp",
  });

  for (const id of ["S-2", "S-3"]) {
    const file = await call(h.port, at(`/attachments/${id}`), { cookie });
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/octet-stream");
    expect(String(file.headers["content-disposition"])).toMatch(/^attachment/);
    for (const route of ["thumbnail", "preview"])
      expect(
        (await call(h.port, at(`/attachments/${id}/${route}`), { cookie }))
          .status,
      ).toBe(404);
  }
});
