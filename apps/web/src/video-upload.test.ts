import { expect, test } from "vitest";
import { ApiError, describeError, HttpCardiganClient } from "./api.js";

/**
 * C-683: the browser sends a video in chunks at the offset the server
 * reports, continues after a lost reply or a dropped connection, and
 * resumes an earlier upload by id.
 */
interface Seen {
  method: string;
  url: string;
  bytes?: number;
  type?: string | null;
}

function server(
  size: number,
  chunk: number,
  script: (seen: Seen) => Response | "drop" | undefined,
) {
  let received = 0;
  const seen: Seen[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const status = () => ({
    upload_id: "up-1",
    size,
    received,
    chunk_bytes: chunk,
    complete: received === size,
  });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body as Blob | undefined;
    const entry: Seen = {
      method,
      url,
      ...(body instanceof Blob ? { bytes: body.size } : {}),
      type: new Headers(init?.headers).get("content-type"),
    };
    seen.push(entry);
    const scripted = script(entry);
    if (scripted === "drop") throw new TypeError("Failed to fetch");
    if (scripted) return scripted;
    if (method === "POST") return json(status(), 201);
    if (method === "GET") {
      if (!url.endsWith("/uploads/up-1"))
        return json({ error: { code: "not_found", message: "gone" } }, 404);
      return json(status());
    }
    const offset = Number(new URL(url, "http://x").searchParams.get("offset"));
    if (offset !== received)
      return json(
        {
          error: { code: "stale_target", message: "x", details: { received } },
        },
        409,
      );
    received += body?.size ?? 0;
    return json(status());
  }) as typeof fetch;
  return {
    fetchImpl,
    seen,
    setReceived: (n: number) => {
      received = n;
    },
  };
}

const retry = { delaysMs: [], sleep: async () => undefined };

test("chunks go in order with progress and the octet-stream type", async () => {
  const fake = server(25, 10, () => undefined);
  const client = new HttpCardiganClient(fake.fetchImpl, undefined, retry);
  const progress: number[] = [];
  const id = await client.uploadVideo(
    "p-1",
    new Blob([new Uint8Array(25)]),
    "video/mp4",
    {
      onProgress: (n) => progress.push(n),
    },
  );
  expect(id).toBe("up-1");
  expect(fake.seen.map((s) => [s.method, s.url, s.bytes ?? null])).toEqual([
    ["POST", "/api/projects/p-1/uploads", null],
    ["PUT", "/api/projects/p-1/uploads/up-1?offset=0", 10],
    ["PUT", "/api/projects/p-1/uploads/up-1?offset=10", 10],
    ["PUT", "/api/projects/p-1/uploads/up-1?offset=20", 5],
  ]);
  expect(fake.seen[1]?.type).toBe("application/octet-stream");
  expect(progress).toEqual([0, 10, 20, 25]);
});

test("a dropped connection and a lost reply continue from the server's offset", async () => {
  let puts = 0;
  const fake = server(30, 10, (seen) => {
    if (seen.method !== "PUT") return undefined;
    puts += 1;
    // The second chunk's connection drops before any reply.
    return puts === 2 ? "drop" : undefined;
  });
  const client = new HttpCardiganClient(fake.fetchImpl, undefined, retry);
  await client.uploadVideo("p-1", new Blob([new Uint8Array(30)]), "video/mp4");
  expect(
    fake.seen
      .filter((s) => s.method !== "POST")
      .map((s) => `${s.method} ${s.url.split("/").at(-1)}`),
  ).toEqual([
    "PUT up-1?offset=0",
    "PUT up-1?offset=10",
    "GET up-1",
    "PUT up-1?offset=10",
    "PUT up-1?offset=20",
  ]);
});

test("a retry resumes an earlier upload by id; an unknown one starts over", async () => {
  const fake = server(30, 10, () => undefined);
  fake.setReceived(20);
  const client = new HttpCardiganClient(fake.fetchImpl, undefined, retry);
  const started: string[] = [];
  await client.uploadVideo("p-1", new Blob([new Uint8Array(30)]), "video/mp4", {
    uploadId: "up-1",
    onStarted: (id) => started.push(id),
  });
  expect(
    fake.seen.map((s) => `${s.method} ${s.url.split("/").at(-1)}`),
  ).toEqual(["GET up-1", "PUT up-1?offset=20"]);
  expect(started).toEqual(["up-1"]);
  const again = server(10, 10, () => undefined);
  await new HttpCardiganClient(again.fetchImpl, undefined, retry).uploadVideo(
    "p-1",
    new Blob([new Uint8Array(10)]),
    "video/mp4",
    { uploadId: "up-gone" },
  );
  expect(again.seen.map((s) => s.method)).toEqual(["GET", "POST", "PUT"]);
});

test("a refused chunk is reported, and the limit refusal reads in Chinese", async () => {
  const fake = server(10, 10, (seen) =>
    seen.method === "PUT"
      ? new Response(
          JSON.stringify({
            error: {
              code: "validation_failed",
              message:
                "File content is not mp4 video; the extension or type does not match the content",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        )
      : undefined,
  );
  const client = new HttpCardiganClient(fake.fetchImpl, undefined, retry);
  const error = await client
    .uploadVideo("p-1", new Blob([new Uint8Array(10)]), "video/mp4")
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(describeError(error)).toBe(
    "请求失败：文件内容与扩展名不符，不是 mp4 视频",
  );
  expect(
    describeError(
      new ApiError(413, "validation_failed", "Video exceeds 1024 MiB"),
    ),
  ).toBe("请求失败：视频超过 1024 MiB");
});

test("the session read carries the video limit", async () => {
  const client = new HttpCardiganClient(
    (async () =>
      new Response(
        JSON.stringify({
          authenticated: true,
          password_configured: true,
          video_max_bytes: 512 * 1024 * 1024,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  );
  expect(client.videoMaxBytes()).toBeUndefined();
  await client.session();
  expect(client.videoMaxBytes()).toBe(512 * 1024 * 1024);
});
