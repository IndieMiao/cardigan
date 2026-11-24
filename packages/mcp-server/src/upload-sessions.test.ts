import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, test } from "vitest";
import { videoBytes } from "../test-support/video-fixtures.js";
import { ToolError } from "./errors.js";
import { importVideoFile, UploadSessions } from "./upload-sessions.js";

let dir: string;
let now: number;
let sessions: UploadSessions;
const MIB = 1024 * 1024;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const chunks = (...parts: Buffer[]) => Readable.from(parts);
/** A source that sends `bytes` and then breaks, like a dropped connection. */
async function* broken(bytes: Buffer) {
  yield bytes;
  throw new Error("socket hang up");
}
const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error as ToolError;
  }
  throw new Error("expected a refusal");
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cardigan-uploads-"));
  now = Date.parse("2026-11-24T00:00:00Z");
  sessions = new UploadSessions(dir, {
    maxBytes: 4 * MIB,
    chunkBytes: 1024,
    now: () => now,
  });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test("C-683: a video over the limit is refused with the actual limit", async () => {
  const error = await failure(
    sessions.create("web:p/M-1", { size: 4 * MIB + 1, mime: "video/mp4" }),
  );
  expect(error).toBeInstanceOf(ToolError);
  expect(error.message).toBe("Video exceeds 4 MiB");
  expect(error.details).toEqual({ max_bytes: 4 * MIB });
  // Only video types use resumable uploads.
  expect(
    (
      await failure(
        sessions.create("web:p/M-1", { size: 10, mime: "image/png" }),
      )
    ).message,
  ).toMatch(/Only mp4, mov, webm and m4v/u);
  expect(new UploadSessions(dir).maxBytes).toBe(1024 * MIB);
});

test("C-683: chunks resume after an interrupted chunk and publish the checked file", async () => {
  const video = videoBytes("mp4", 2500);
  const owner = "web:p/M-1";
  const opened = await sessions.create(owner, {
    size: video.length,
    mime: "video/mp4",
  });
  expect(opened).toMatchObject({
    received: 0,
    chunk_bytes: 1024,
    complete: false,
  });
  const id = opened.upload_id;
  expect(
    await sessions.append(owner, id, 0, chunks(video.subarray(0, 1024))),
  ).toMatchObject({ received: 1024, complete: false });
  // The second chunk breaks part way: what it wrote is cut off again.
  const broke = await failure(
    sessions.append(owner, id, 1024, broken(video.subarray(1024, 1500))),
  );
  expect(broke.message).toMatch(/interrupted/u);
  expect(await sessions.status(owner, id)).toMatchObject({ received: 1024 });
  // A resend of an old chunk is told where to continue.
  const stale = await failure(
    sessions.append(owner, id, 0, chunks(video.subarray(0, 1024))),
  );
  expect(stale.code).toBe("stale_target");
  expect(stale.details).toMatchObject({ received: 1024, size: 2500 });
  // A chunk larger than allowed is refused and leaves nothing behind.
  expect(
    (
      await failure(
        sessions.append(owner, id, 1024, chunks(video.subarray(1024, 2049))),
      )
    ).message,
  ).toMatch(/at most 1024 bytes/u);
  expect(await sessions.status(owner, id)).toMatchObject({ received: 1024 });
  await sessions.append(owner, id, 1024, chunks(video.subarray(1024, 2048)));
  const done = await sessions.append(
    owner,
    id,
    2048,
    chunks(video.subarray(2048)),
  );
  expect(done).toMatchObject({
    received: 2500,
    complete: true,
    sha256: sha(video),
  });
  // Another owner cannot see, extend or publish it.
  expect((await failure(sessions.status("web:p/M-2", id))).code).toBe(
    "not_found",
  );
  expect((await failure(sessions.publish("web:p/M-2", id))).code).toBe(
    "not_found",
  );
  const published = await sessions.publish(owner, id);
  expect(published).toEqual({
    sha256: sha(video),
    size: 2500,
    mime: "video/mp4",
    storage_path: `attachments/${sha(video)}`,
  });
  expect(await readFile(join(dir, published.storage_path))).toEqual(video);
  // Publishing again (a retried record write) reuses the same blob.
  expect(await sessions.publish(owner, id)).toEqual(published);
  await sessions.remove(owner, id);
  expect(await readdir(join(dir, "uploads"))).toEqual([]);
  expect(await readFile(join(dir, published.storage_path))).toEqual(video);
});

test("C-683: wrong content or checksum never becomes publishable", async () => {
  const owner = "assignment:p/A-1";
  const png = videoBytes("png", 600);
  const a = await sessions.create(owner, { size: 600, mime: "video/mp4" });
  const mismatch = await failure(
    sessions.append(owner, a.upload_id, 0, chunks(png)),
  );
  expect(mismatch.message).toMatch(/does not match the content/u);
  expect((await failure(sessions.status(owner, a.upload_id))).code).toBe(
    "not_found",
  );
  const video = videoBytes("webm", 600);
  const b = await sessions.create(owner, {
    size: 600,
    mime: "video/webm",
    sha256: "0".repeat(64),
  });
  expect(
    (await failure(sessions.append(owner, b.upload_id, 0, chunks(video))))
      .message,
  ).toMatch(/sha256 does not match/u);
  const c = await sessions.create(owner, { size: 600, mime: "video/webm" });
  expect((await failure(sessions.publish(owner, c.upload_id))).message).toMatch(
    /not complete/u,
  );
  expect(await readdir(dir)).not.toContain("attachments");
});

test("C-683: the same key resumes the owner's upload; different parameters conflict", async () => {
  const owner = "assignment:p/A-1";
  const input = {
    size: 900,
    mime: "video/quicktime",
    sha256: "a".repeat(64),
    key: "k-1",
    target: { card_id: "C-1" },
  };
  const first = await sessions.create(owner, input);
  await sessions.append(
    owner,
    first.upload_id,
    0,
    chunks(videoBytes("mov", 900).subarray(0, 500)),
  );
  expect(await sessions.create(owner, input)).toMatchObject({
    upload_id: first.upload_id,
    received: 500,
  });
  expect(await sessions.target(owner, first.upload_id)).toEqual({
    card_id: "C-1",
  });
  expect(
    (await failure(sessions.create(owner, { ...input, size: 901 }))).code,
  ).toBe("idempotency_conflict");
  // Another owner's key is a different upload.
  expect((await sessions.create("assignment:p/A-9", input)).upload_id).not.toBe(
    first.upload_id,
  );
});

test("C-683: an upload untouched for a day expires and is swept", async () => {
  const owner = "web:p/M-1";
  const old = await sessions.create(owner, { size: 10, mime: "video/mp4" });
  await writeFile(join(dir, "uploads", "stray.part"), "x");
  const long = new Date(now - 60_000);
  await utimes(join(dir, "uploads", "stray.part"), long, long);
  now += 24 * 60 * 60_000 + 1;
  expect((await failure(sessions.status(owner, old.upload_id))).code).toBe(
    "not_found",
  );
  await sessions.create(owner, { size: 10, mime: "video/mp4" });
  const names = await readdir(join(dir, "uploads"));
  expect(names.some((n) => n.startsWith(old.upload_id))).toBe(false);
  expect(names).toHaveLength(2);
  // Stray parts go once they are as old as an expired upload.
  expect(names).not.toContain("stray.part");
});

test("C-683: the per-owner cap keeps one member from filling the disk", async () => {
  for (let i = 0; i < 8; i++)
    await sessions.create("web:p/M-1", { size: 10, mime: "video/mp4" });
  expect(
    (
      await failure(
        sessions.create("web:p/M-1", { size: 10, mime: "video/mp4" }),
      )
    ).message,
  ).toMatch(/Too many uploads/u);
  await sessions.create("web:p/M-2", { size: 10, mime: "video/mp4" });
});

test("C-683: a local video streams into the store with progress; limit and content are checked", async () => {
  const video = videoBytes("m4v", 300_000);
  const path = join(dir, "clip.m4v");
  await writeFile(path, video);
  const progress: number[] = [];
  const stored = await importVideoFile(dir, path, "video/x-m4v", MIB, (n) =>
    progress.push(n),
  );
  expect(stored).toEqual({
    sha256: sha(video),
    size: video.length,
    storage_path: `attachments/${sha(video)}`,
  });
  expect(progress.at(-1)).toBe(video.length);
  expect((await stat(join(dir, stored.storage_path))).size).toBe(video.length);
  expect(
    (await failure(importVideoFile(dir, path, "video/x-m4v", 1000))).message,
  ).toBe("Video exceeds 1000 bytes");
  expect(
    (await failure(importVideoFile(dir, path, "video/webm", MIB))).message,
  ).toMatch(/does not match/u);
  // No temporary copies stay behind.
  expect(await readdir(join(dir, "uploads"))).toEqual([]);
});
