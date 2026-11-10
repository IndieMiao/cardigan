import { createHash } from "node:crypto";
import {
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
import { MAX_AVATAR_BYTES } from "@cardigan/domain";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fileAvatarStore, readAvatarFile } from "./avatars.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cardigan-avatars-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("stores global content-addressed images without re-encoding and reuses identical bytes", async () => {
  const store = fileAvatarStore(dataDir);
  const sha256 = createHash("sha256").update(png).digest("hex");
  expect(await store.put(png)).toBe(`upload:${sha256}`);
  expect(await store.put(png)).toBe(`upload:${sha256}`);
  expect(await readdir(join(dataDir, "avatars"))).toEqual([`${sha256}.png`]);
  expect(await readFile(join(dataDir, "avatars", `${sha256}.png`))).toEqual(
    png,
  );
  expect(await store.get(sha256)).toEqual({ bytes: png, mime: "image/png" });
  const webp = await readFile(
    new URL(
      "../../../apps/web/public/avatars/v1/guan-yu/head-64.webp",
      import.meta.url,
    ),
  );
  const reference = await store.put(webp);
  expect(await store.get(reference.slice(7))).toEqual({
    bytes: webp,
    mime: "image/webp",
  });
});

test("size is bounded on reads and writes, and non-bitmap or truncated bytes are rejected", async () => {
  const store = fileAvatarStore(dataDir);
  for (const bytes of [
    Buffer.from("<svg></svg>"),
    Buffer.from("GIF89a"),
    Buffer.from("<html>image.png</html>"),
    png.subarray(0, 32),
    Buffer.alloc(0),
  ]) {
    await expect(store.put(bytes)).rejects.toThrow("只支持 PNG、WebP 或 JPEG");
  }
  await expect(store.put(Buffer.alloc(MAX_AVATAR_BYTES + 1))).rejects.toThrow(
    "2 MiB",
  );
  const source = join(dataDir, "large.png");
  await writeFile(source, Buffer.alloc(MAX_AVATAR_BYTES + 1));
  await expect(readAvatarFile(source)).rejects.toThrow("2 MiB");
  await expect(readAvatarFile(dataDir)).rejects.toThrow("普通图片文件");
});

test("invalid hashes cannot select paths and corrupt or linked blobs are never returned", async () => {
  const store = fileAvatarStore(dataDir);
  for (const value of [
    "../secret",
    "a".repeat(63),
    "A".repeat(64),
    `${"a".repeat(64)}.png`,
  ]) {
    expect(await store.get(value)).toBeUndefined();
  }
  expect(await store.get("0".repeat(64))).toBeUndefined();
  const ref = await store.put(png);
  const path = join(dataDir, "avatars", `${ref.slice(7)}.png`);
  await writeFile(path, Buffer.from("corrupt"));
  await expect(store.get(ref.slice(7))).rejects.toThrow("校验失败");
  await expect(store.put(png)).rejects.toThrow("校验失败");
  await rm(path);
  const target = join(dataDir, "target");
  await writeFile(target, png);
  await symlink(target, path);
  await expect(store.get(ref.slice(7))).rejects.toThrow();
  await expect(store.put(png)).rejects.toThrow();
  expect(await readFile(target)).toEqual(png);
});

test("the avatar directory cannot redirect writes through a symlink", async () => {
  const target = join(dataDir, "elsewhere");
  await mkdir(target);
  await symlink(target, join(dataDir, "avatars"));
  await expect(fileAvatarStore(dataDir).put(png)).rejects.toThrow("普通目录");
  expect(await readdir(target)).toEqual([]);
});

test("JPEG bytes are stored as jpg, independent of their original filename", async () => {
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIIA6Lf/2Q==",
    "base64",
  );
  const store = fileAvatarStore(dataDir);
  const ref = await store.put(jpeg);
  expect(await readdir(join(dataDir, "avatars"))).toEqual([
    `${ref.slice(7)}.jpg`,
  ]);
  expect(await store.get(ref.slice(7))).toEqual({
    bytes: jpeg,
    mime: "image/jpeg",
  });
});
