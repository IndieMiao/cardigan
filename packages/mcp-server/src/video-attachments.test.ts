import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "@cardigan/domain";
import { STANDING_ROLE_TOOLS } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeVideoTools, videoBytes } from "../test-support/video-fixtures.js";
import { downloadAttachment } from "./download-attachment.js";
import { type RunningServer, startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
  card_id,
  NOW,
  project_id,
  seedProject,
} from "./test-support.js";

/**
 * C-683: Agents upload videos through the Card MCP endpoint (base64 when
 * small, resumable chunks otherwise) and read them as metadata and frames.
 */
let store: Store, server: RunningServer, client: Client;
let dataDir: string, bearer: string, sequence: number;
const MIB = 1024 * 1024;
const target = {
  card_id,
  kind: "evidence",
  attach_to: { kind: "timeline_entry", id: "C-1#1" },
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const call = (name: string, args: object, key = `video-${++sequence}`) =>
  client.callTool({ name, arguments: { idempotency_key: key, ...args } });
const read = (args: object) =>
  client.callTool({ name: "read_attachment", arguments: args });
const errorOf = (result: Awaited<ReturnType<typeof call>>) =>
  (result.structuredContent as { error?: { code: string; message: string } })
    .error;
const put = (query: string, body: Buffer, headers: object = {}) =>
  fetch(server.url + query, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/octet-stream",
      ...headers,
    },
    body,
  });

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cardigan-video-mcp-"));
  store = Store.open({ dbPath: ":memory:" });
  sequence = 0;
  const { assignment } = seedProject(store, {
    allowed_tools: STANDING_ROLE_TOOLS,
  });
  store.uow.run((tx) =>
    tx.runs.put(project_id, {
      id: tx.ids.next(project_id, "run"),
      assignment_id: assignment.id,
      trigger_event_id: tx.ids.nextEventId(),
      kind: "initial",
      status: "running",
      role_version: 1,
      model: "fixture-model",
      agent_cli_version: "1",
      outcome: null,
      summary: "",
    }),
  );
  server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    dataDir,
    clock: { now: () => NOW },
    log: () => undefined,
  });
  const issued = store.issueToken({
    id: assignment.mcp_token_id,
    project_id,
    assignment_id: assignment.id,
    role: { role_version: 1, allowed_tools: STANDING_ROLE_TOOLS },
  });
  bearer = issued.token;
  client = new Client({ name: "video-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }),
  );
});
afterEach(async () => {
  await client.close();
  await server.close();
  store.close();
  await rm(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test("C-683: a small video uploads as base64; content that is not the type is refused", async () => {
  const mp4 = videoBytes("mp4");
  const ok = await call("upload_attachment", {
    ...target,
    mime: "video/mp4",
    original_filename: "demo.mp4",
    file: mp4.toString("base64"),
  });
  expect(ok.isError).not.toBe(true);
  expect(ok.structuredContent).toMatchObject({
    mime: "video/mp4",
    size: mp4.length,
    sha256: sha(mp4),
  });
  const wrong = await call("upload_attachment", {
    ...target,
    mime: "video/webm",
    file: mp4.toString("base64"),
  });
  expect(errorOf(wrong)).toMatchObject({
    code: "validation_failed",
    message: expect.stringMatching(/does not match the content/u),
  });
  // Images upload exactly as before.
  const png = await call("upload_attachment", {
    ...target,
    mime: "image/png",
    file: Buffer.from("png bytes").toString("base64"),
  });
  expect(png.isError).not.toBe(true);
});

test("C-683: a large video uploads in chunks, survives an interrupted chunk and becomes a durable attachment", async () => {
  const video = videoBytes("mov", 9 * MIB + 123);
  const manifest = {
    ...target,
    mime: "video/quicktime",
    original_filename: "demo.mov",
    artifact_size: video.length,
    sha256: sha(video),
  };
  const opened = (await call("upload_attachment", manifest, "big-video"))
    .structuredContent as {
    upload_id: string;
    upload_query: string;
    chunk_bytes: number;
    received: number;
    method: string;
  };
  expect(opened).toMatchObject({
    method: "PUT",
    received: 0,
    chunk_bytes: 8 * MIB,
    upload_query: `?attachment_upload=${opened.upload_id}&offset=0`,
  });
  const at = (offset: number) =>
    `?attachment_upload=${opened.upload_id}&offset=${offset}`;
  const first = await put(at(0), video.subarray(0, 8 * MIB));
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ received: 8 * MIB });
  // A lost reply makes the Agent resend: it is told where to continue.
  const again = await put(at(0), video.subarray(0, 8 * MIB));
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({
    error: { code: "stale_target", details: { received: 8 * MIB } },
  });
  // The connection drops part way through the last chunk.
  await new Promise<void>((resolve) => {
    const req = request(server.url + at(8 * MIB), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/octet-stream",
        "content-length": String(video.length - 8 * MIB),
      },
    });
    req.on("error", () => resolve());
    req.write(video.subarray(8 * MIB, 8 * MIB + 1000), () => {
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
  });
  const status = async () =>
    (await (
      await fetch(`${server.url}?attachment_upload=${opened.upload_id}`, {
        headers: { authorization: `Bearer ${bearer}` },
      })
    ).json()) as { received: number };
  await vi.waitFor(async () => expect((await status()).received).toBe(8 * MIB));
  // Calling the tool again with the same key resumes the same upload.
  expect(
    (await call("upload_attachment", manifest, "big-video")).structuredContent,
  ).toMatchObject({ upload_id: opened.upload_id, received: 8 * MIB });
  const last = await put(at(8 * MIB), video.subarray(8 * MIB));
  expect(last.status).toBe(201);
  const attachment = (await last.json()) as Attachment;
  expect(attachment).toMatchObject({
    card_id,
    mime: "video/quicktime",
    size: video.length,
    sha256: sha(video),
    storage_path: `attachments/${sha(video)}`,
    original_filename: "demo.mov",
  });
  expect(attachment).not.toHaveProperty("streamed_artifact");
  expect(await readdir(join(dataDir, "uploads"))).toEqual([]);
  // The same key now returns the record instead of a new upload.
  expect(
    (await call("upload_attachment", manifest, "big-video")).structuredContent,
  ).toMatchObject({ id: attachment.id });
  // Streamed download, verified by the current helper.
  const path = join(dataDir, "download.mov");
  expect(
    await downloadAttachment(server.url, attachment.id, path, bearer),
  ).toMatchObject({ size: video.length, sha256: sha(video), via: "card_mcp" });
  expect((await readFile(path)).equals(video)).toBe(true);
  // Ranges serve part of the file (players seek with them).
  const range = await fetch(`${server.url}?attachment_id=${attachment.id}`, {
    headers: { authorization: `Bearer ${bearer}`, range: "bytes=4-11" },
  });
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe(`bytes 4-11/${video.length}`);
  expect(Buffer.from(await range.arrayBuffer())).toEqual(video.subarray(4, 12));
});

test("C-683: chunked uploads refuse an oversized video, bad content, other tokens and wrong bodies", async () => {
  vi.stubEnv("CARDIGAN_VIDEO_MAX_MIB", "1");
  // The limit is read when the data directory's uploads are first used.
  const big = await call("upload_attachment", {
    ...target,
    mime: "video/mp4",
    artifact_size: MIB + 1,
    sha256: "a".repeat(64),
  });
  expect(errorOf(big)).toMatchObject({
    code: "validation_failed",
    message: "Video exceeds 1 MiB",
  });
  const png = videoBytes("png", 1000);
  const opened = (
    await call("upload_attachment", {
      ...target,
      mime: "video/mp4",
      artifact_size: png.length,
      sha256: sha(png),
    })
  ).structuredContent as { upload_id: string };
  const query = `?attachment_upload=${opened.upload_id}&offset=0`;
  expect((await put(query, png, { authorization: "Bearer nope" })).status).toBe(
    401,
  );
  expect((await put(query, png, { "content-type": "text/plain" })).status).toBe(
    400,
  );
  const refused = await put(query, png);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({
    error: { message: expect.stringMatching(/does not match the content/u) },
  });
  // The refused upload is gone; nothing was attached.
  expect((await put(query, png)).status).toBe(404);
  expect(store.uow.read((tx) => tx.attachments.list(project_id)).length).toBe(
    0,
  );
});

test("C-683: read_attachment returns the uploader's measurements, the container and the worker frame guide", async () => {
  const webm = videoBytes("webm");
  const uploaded = (
    await call("upload_attachment", {
      ...target,
      mime: "video/webm",
      file: webm.toString("base64"),
      video: {
        duration_seconds: 74.5,
        width: 1920,
        height: 1080,
        video_codec: "vp9",
      },
    })
  ).structuredContent as Attachment;
  expect(uploaded.video).toEqual({
    duration_seconds: 74.5,
    width: 1920,
    height: 1080,
    video_codec: "vp9",
  });
  const meta = await read({ attachment_id: uploaded.id });
  expect(meta.isError).not.toBe(true);
  expect(meta.structuredContent).toMatchObject({
    attachment_id: uploaded.id,
    content_mode: "metadata",
    size: webm.length,
    sha256: sha(webm),
    video: {
      container: "webm",
      duration_seconds: 74.5,
      width: 1920,
      height: 1080,
      video_codec: "vp9",
      audio_codec: null,
      has_poster: false,
    },
    frames: expect.stringContaining("download-attachment.mjs"),
    download: { query: { attachment_id: uploaded.id } },
  });
  expect(
    (await read({ attachment_id: uploaded.id, verify_sha256: sha(webm) }))
      .structuredContent,
  ).toMatchObject({ verified: true });
  expect(
    errorOf(await read({ attachment_id: uploaded.id, offset: 0 })),
  ).toMatchObject({ code: "validation_failed" });
  // Measurements belong to videos only.
  expect(
    errorOf(
      await call("upload_attachment", {
        ...target,
        mime: "text/plain",
        file: Buffer.from("x").toString("base64"),
        video: { width: 10 },
      }),
    ),
  ).toMatchObject({ code: "validation_failed" });
});

test("C-683: the host never runs ffmpeg or ffprobe for video uploads, reads and downloads", async () => {
  const fake = await fakeVideoTools(dataDir);
  vi.stubEnv("PATH", `${fake.dir}:${process.env.PATH ?? ""}`);
  const small = videoBytes("mp4");
  const base64 = (
    await call("upload_attachment", {
      ...target,
      mime: "video/mp4",
      file: small.toString("base64"),
    })
  ).structuredContent as Attachment;
  const big = videoBytes("m4v", 100_000);
  const opened = (
    await call("upload_attachment", {
      ...target,
      mime: "video/x-m4v",
      artifact_size: big.length,
      sha256: sha(big),
    })
  ).structuredContent as { upload_query: string };
  const chunked = (await (
    await put(opened.upload_query, big)
  ).json()) as Attachment;
  for (const a of [base64, chunked]) {
    expect((await read({ attachment_id: a.id })).isError).not.toBe(true);
    const path = join(dataDir, `${a.id}.bin`);
    await downloadAttachment(server.url, a.id, path, bearer);
  }
  await expect(readFile(fake.log, "utf8")).rejects.toThrow();
  // Control: the poisoned PATH does reach the fake tools.
  execFileSync("ffprobe", [`file:${join(dataDir, `${base64.id}.bin`)}`]);
  expect(await readFile(fake.log, "utf8")).toContain('"ffprobe"');
});
