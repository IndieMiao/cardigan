import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  fakeVideoTools,
  POSTER_JPEG,
  videoBytes,
} from "../../../../packages/mcp-server/test-support/video-fixtures.js";
import { type M4Cross, m4Cross } from "../../test-support/m4-cross.js";
import { resolveWebConfig } from "./config.js";
import { requestRoute } from "./http.js";
import { type RunningWebServer, startWebServer } from "./server.js";

/**
 * C-683: the Workbench uploads videos in resumable chunks, attaches the
 * complete upload by id, streams it back with ranges, and shows its cover
 * frame and metadata (host ffmpeg).
 */
let s: M4Cross, web: RunningWebServer, cookie: string;
const password = "workbench video password";
const MIB = 1024 * 1024;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const path = (rest: string) => `/api/projects/${s.project.project_id}${rest}`;
const send = async (
  rest: string,
  init: { method?: string; body?: unknown; raw?: Buffer } = {},
  headers: Record<string, string> = {},
) => {
  const response = await fetch(web.url + path(rest), {
    method: init.method ?? "POST",
    headers: {
      cookie,
      origin: web.url,
      ...(init.raw
        ? { "content-type": "application/octet-stream" }
        : init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      ...headers,
    },
    ...(init.raw
      ? { body: init.raw }
      : init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Binary responses are checked by the caller through `text`.
  }
  return { status: response.status, body, text, headers: response.headers };
};

beforeEach(async () => {
  s = await m4Cross();
  s.store().setWebPassword(password);
  web = await startWebServer({
    store: s.store(),
    dataDir: s.dataDir,
    config: resolveWebConfig({}, { port: 0, staticDir: s.root }),
  });
  const login = await fetch(`${web.url}/api/login`, {
    method: "POST",
    headers: { origin: web.url, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
  await login.body?.cancel();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await web?.close();
  await s?.close();
}, 30_000);

test("C-683: a Workbench video uploads in chunks, resumes, attaches by upload id and plays back", async () => {
  // C-683: ffmpeg/ffprobe on PATH log any call; the host must make none.
  const fake = await fakeVideoTools(s.dataDir);
  vi.stubEnv("PATH", `${fake.dir}:${process.env.PATH ?? ""}`);
  const info = await fetch(`${web.url}/api/session`, { headers: { cookie } });
  expect(await info.json()).toMatchObject({
    video_max_bytes: 1024 * MIB,
    video_chunk_bytes: 8 * MIB,
  });
  const video = videoBytes("mp4", 8 * MIB + 5000);
  const opened = await send("/uploads", {
    body: { size: video.length, mime: "video/mp4" },
  });
  expect(opened).toMatchObject({
    status: 201,
    body: { received: 0, chunk_bytes: 8 * MIB, complete: false },
  });
  const id = opened.body.upload_id as string;
  expect(
    await send(`/uploads/${id}?offset=0`, {
      method: "PUT",
      raw: video.subarray(0, 8 * MIB),
    }),
  ).toMatchObject({ status: 200, body: { received: 8 * MIB } });
  // A resent chunk (lost reply) is told where the server is.
  expect(
    await send(`/uploads/${id}?offset=0`, {
      method: "PUT",
      raw: video.subarray(0, 8 * MIB),
    }),
  ).toMatchObject({
    status: 409,
    body: { error: { code: "stale_target", details: { received: 8 * MIB } } },
  });
  expect(await send(`/uploads/${id}`, { method: "GET" })).toMatchObject({
    status: 200,
    body: { received: 8 * MIB },
  });
  // Attaching before the upload is complete is refused.
  const comment = await send(`/cards/${s.card.id}/comments`, {
    body: { body: "演示视频" },
  });
  const attach = {
    upload_id: id,
    original_filename: "演示.mp4",
    mime: "video/mp4",
    kind: "evidence",
    attach_to: { kind: "timeline_entry", id: comment.body.id },
    ref_slot: 1,
    // What the browser measured and drew before sending.
    video: {
      duration_seconds: 74.5,
      width: 1920,
      height: 1080,
      video_codec: "h264",
    },
    poster: POSTER_JPEG.toString("base64"),
  };
  expect(
    await send(`/cards/${s.card.id}/attachments`, { body: attach }),
  ).toMatchObject({
    status: 400,
    body: {
      error: {
        message: "Upload is not complete yet",
        details: { received: 8 * MIB },
      },
    },
  });
  expect(
    await send(`/uploads/${id}?offset=${8 * MIB}`, {
      method: "PUT",
      raw: video.subarray(8 * MIB),
    }),
  ).toMatchObject({
    status: 200,
    body: { received: video.length, complete: true, sha256: sha(video) },
  });
  const key = { "Idempotency-Key": "attach-video" };
  const attached = await send(
    `/cards/${s.card.id}/attachments`,
    { body: attach },
    key,
  );
  expect(attached).toMatchObject({
    status: 200,
    body: {
      mime: "video/mp4",
      size: video.length,
      sha256: sha(video),
      storage_path: `attachments/${sha(video)}`,
      original_filename: "演示.mp4",
      video: {
        duration_seconds: 74.5,
        width: 1920,
        height: 1080,
        video_codec: "h264",
        poster_sha256: sha(POSTER_JPEG),
        poster_size: POSTER_JPEG.length,
      },
    },
  });
  expect(readdirSync(join(s.dataDir, "uploads"))).toEqual([]);
  // A keyed retry after the upload was consumed gets the same reply.
  expect(
    await send(`/cards/${s.card.id}/attachments`, { body: attach }, key),
  ).toMatchObject({ status: 200, body: { id: attached.body.id } });
  expect(
    readFileSync(join(s.dataDir, "attachments", sha(video))).equals(video),
  ).toBe(true);
  const detail = await send(`/cards/${s.card.id}`, { method: "GET" });
  const view = (
    detail.body.attachments as { id: string; poster_path?: string }[]
  ).find((a) => a.id === attached.body.id);
  const download = path(`/attachments/${attached.body.id}`);
  expect(view).toMatchObject({
    inline: false,
    thumbnail_path: null,
    download_path: download,
    poster_path: `${download}/poster`,
    video: {
      duration_seconds: 74.5,
      width: 1920,
      height: 1080,
      video_codec: "h264",
    },
  });
  expect(JSON.stringify(view)).not.toContain("poster_sha256");
  // Whole file and one range, inline for the <video> element.
  const whole = await fetch(web.url + download, { headers: { cookie } });
  expect(whole.headers.get("content-type")).toBe("video/mp4");
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  expect(whole.headers.get("content-disposition")).toMatch(/^inline;/u);
  expect(Buffer.from(await whole.arrayBuffer()).equals(video)).toBe(true);
  const part = await fetch(web.url + download, {
    headers: { cookie, range: `bytes=${video.length - 10}-` },
  });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(
    `bytes ${video.length - 10}-${video.length - 1}/${video.length}`,
  );
  expect(Buffer.from(await part.arrayBuffer())).toEqual(video.subarray(-10));
  const unsatisfiable = await fetch(web.url + download, {
    headers: { cookie, range: `bytes=${video.length}-` },
  });
  expect(unsatisfiable.status).toBe(416);
  await unsatisfiable.body?.cancel();
  // The cover frame is the browser's JPEG, served as stored.
  const poster = await fetch(`${web.url}${download}/poster`, {
    headers: { cookie },
  });
  expect(poster.status).toBe(200);
  expect(poster.headers.get("content-type")).toBe("image/jpeg");
  expect(Buffer.from(await poster.arrayBuffer())).toEqual(POSTER_JPEG);
  expect(existsSync(fake.log)).toBe(false);
});

test("C-683: Workbench uploads refuse oversized videos, wrong content, other types and anonymous callers", async () => {
  vi.stubEnv("CARDIGAN_VIDEO_MAX_MIB", "2");
  expect(
    await send("/uploads", {
      body: { size: 2 * MIB + 1, mime: "video/webm" },
    }),
  ).toMatchObject({
    status: 413,
    body: { error: { message: "Video exceeds 2 MiB" } },
  });
  expect(
    await send("/uploads", { body: { size: 10, mime: "image/png" } }),
  ).toMatchObject({ status: 400 });
  const png = videoBytes("png", 1000);
  const opened = await send("/uploads", {
    body: { size: png.length, mime: "video/webm" },
  });
  const id = opened.body.upload_id as string;
  expect(
    await send(`/uploads/${id}?offset=0`, { method: "PUT", raw: png }),
  ).toMatchObject({
    status: 400,
    body: {
      error: { message: expect.stringMatching(/does not match the content/u) },
    },
  });
  expect(await send(`/uploads/${id}`, { method: "GET" })).toMatchObject({
    status: 404,
  });
  // Without a session nothing is reachable.
  const anonymous = await fetch(web.url + path("/uploads"), {
    method: "POST",
    headers: { origin: web.url, "content-type": "application/json" },
    body: JSON.stringify({ size: 10, mime: "video/mp4" }),
  });
  expect(anonymous.status).toBe(401);
  await anonymous.body?.cancel();
  // A small video through the base64 route is checked the same way.
  const comment = await send(`/cards/${s.card.id}/comments`, {
    body: { body: "截图" },
  });
  const base = {
    mime: "video/mp4",
    kind: "evidence",
    attach_to: { kind: "timeline_entry", id: comment.body.id },
  };
  expect(
    await send(`/cards/${s.card.id}/attachments`, {
      body: { ...base, file: png.toString("base64") },
    }),
  ).toMatchObject({ status: 400 });
  expect(
    await send(`/cards/${s.card.id}/attachments`, {
      body: { ...base, file: png.toString("base64"), upload_id: "x" },
    }),
  ).toMatchObject({ status: 400 });
  // A poster must be a JPEG; a video sent without one has no cover route.
  const mp4 = videoBytes("mp4", 2000);
  expect(
    await send(`/cards/${s.card.id}/attachments`, {
      body: {
        ...base,
        file: mp4.toString("base64"),
        poster: Buffer.from("<svg/>").toString("base64"),
      },
    }),
  ).toMatchObject({
    status: 400,
    body: { error: { message: "The poster must be a JPEG image" } },
  });
  const small = await send(`/cards/${s.card.id}/attachments`, {
    body: { ...base, file: mp4.toString("base64") },
  });
  expect(small.status).toBe(200);
  expect(small.body).not.toHaveProperty("video");
  expect(
    await send(`/attachments/${small.body.id}/poster`, { method: "GET" }),
  ).toMatchObject({ status: 404 });
});

test("C-683: request logs name the video routes by template, without ids", () => {
  expect(requestRoute("/api/projects/p/uploads")).toBe(
    "/api/projects/:project_id/uploads",
  );
  expect(requestRoute("/api/projects/p/uploads/0f-id")).toBe(
    "/api/projects/:project_id/uploads/:id",
  );
  expect(requestRoute("/api/projects/p/attachments/F-3/poster")).toBe(
    "/api/projects/:project_id/attachments/:id/poster",
  );
});
