/**
 * C-685: the shared file library end to end on a real store, a loopback OSS
 * and the Workbench listener. Bytes only ever travel between the client and
 * OSS through signed URLs; the host signs, records and checks size by HEAD.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SharedFileActor } from "@cardigan/domain";
import {
  nodeTransport,
  Offsite,
  type OssTransport,
  registerOffsite,
  SharedFileLibrary,
  sharedFileTools,
  type ToolContext,
} from "@cardigan/mcp-server";
import { SharedFileStore } from "@cardigan/store";
import { afterEach, expect, test } from "vitest";
import {
  type FakeOss,
  startFakeOss,
  writeStorageConfig,
} from "../../../../packages/mcp-server/test-support/fake-oss.js";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";

const PASSWORD = "shared-files-password";
let h: WebHarness | undefined, fake: FakeOss | undefined, root: string;
let unregister: (() => void) | undefined;
/** Every request the host itself sent to OSS, and whether it carried a body. */
let hostRequests: { method: string; body: boolean }[];
afterEach(async () => {
  unregister?.();
  await h?.close();
  await fake?.close();
  if (root) await rm(root, { recursive: true, force: true });
  h = fake = unregister = undefined;
}, 30_000);

async function setup(configured = true) {
  h = await webHarness({ password: PASSWORD });
  root = await mkdtemp(join(tmpdir(), "cardigan-shared-files-"));
  fake = await startFakeOss();
  hostRequests = [];
  const recording: OssTransport = (url, init) => {
    hostRequests.push({ method: init.method, body: init.body !== undefined });
    return nodeTransport(url, init);
  };
  const offsite = new Offsite({
    dataDir: h.dataDir,
    storageDir: configured
      ? await writeStorageConfig(root, fake)
      : join(root, "storage"),
    role: "web",
    transport: recording,
  });
  unregister = registerOffsite(offsite);
  const library = new SharedFileLibrary({
    repository: new SharedFileStore(h.store),
    offsite: () => offsite,
  });
  const cookie = await h.login(PASSWORD);
  return { cookie, library };
}

const agent = (
  project_id: string,
  assignment_id: string,
  role_id = "coder",
): SharedFileActor => ({
  kind: "assignment",
  project_id,
  assignment_id,
  role_id,
});

/** A tool context for `actor` with the given project preferences. */
function context(
  actor: Extract<SharedFileActor, { kind: "assignment" }>,
  preferences: Record<string, unknown> = {},
): ToolContext {
  return {
    store: {
      uow: {
        read: (fn: (tx: unknown) => unknown) =>
          fn({
            project_preferences: {
              get: () => ({ id: actor.project_id, ...preferences }),
            },
          }),
      },
    },
    identity: { actor },
  } as unknown as ToolContext;
}

function tool(library: SharedFileLibrary, name: string) {
  const found = sharedFileTools({ sharedFiles: library }).find(
    (t) => t.name === name,
  );
  if (!found) throw new Error(name);
  return found;
}

/** What an Agent or the browser does with a ticket: PUT straight to OSS. */
async function putToOss(
  ticket: { url: string; headers: Readonly<Record<string, string>> },
  body: Buffer,
) {
  return fetch(ticket.url, {
    method: "PUT",
    headers: ticket.headers,
    body: new Uint8Array(body),
  });
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("Agents in different projects share one library: upload by signed PUT, list, download by signed GET, versions kept", async () => {
  const { library } = await setup();
  const alpha = agent("alpha", "A-1") as Extract<
    SharedFileActor,
    { kind: "assignment" }
  >;
  const beta = agent("beta", "A-9", "reviewer") as Extract<
    SharedFileActor,
    { kind: "assignment" }
  >;
  const v1 = Buffer.from("first take of the hero model");
  const ticket = (await tool(library, "upload_shared_file").handler(
    {
      path: "3d/hero/hero.glb",
      size: v1.length,
      content_type: "model/gltf-binary",
      sha256: sha256(v1),
    },
    context(alpha),
  )) as { upload_id: string; url: string; headers: Record<string, string> };
  expect(new URL(ticket.url).origin).toBe(fake?.endpoint);
  expect(ticket.headers["x-oss-forbid-overwrite"]).toBe("true");
  // Not visible before the commit.
  expect(library.list("").dirs).toEqual([]);
  expect((await putToOss(ticket, v1)).status).toBe(200);
  // The signed URL cannot overwrite the object once it exists.
  expect((await putToOss(ticket, Buffer.from("tampered!!"))).status).toBe(409);
  await tool(library, "commit_shared_file").handler(
    { upload_id: ticket.upload_id },
    context(alpha),
  );

  // Another project's Agent sees it and downloads straight from OSS.
  const root = (await tool(library, "list_shared_files").handler(
    {},
    context(beta),
  )) as { dirs: { path: string }[]; notice: string };
  expect(root.dirs.map((d) => d.path)).toEqual(["3d"]);
  expect(root.notice).toContain("不要放密钥和凭据");
  const hero = library.list("3d/hero");
  expect(hero.files.map((f) => [f.name, f.current.size])).toEqual([
    ["hero.glb", v1.length],
  ]);
  expect(hero.files[0]?.current.created_by).toEqual(alpha);

  // A second version from the other project; the first stays.
  const v2 = Buffer.from("second take of the hero model, longer");
  const second = (await tool(library, "upload_shared_file").handler(
    { path: "3d/hero/hero.glb", size: v2.length },
    context(beta),
  )) as {
    upload_id: string;
    url: string;
    headers: Record<string, string>;
    replaces_version: string;
  };
  expect(second.replaces_version).toBe(ticket.upload_id);
  expect((await putToOss(second, v2)).status).toBe(200);
  // Only whoever started the upload commits it.
  await expect(
    tool(library, "commit_shared_file").handler(
      { upload_id: second.upload_id },
      context(alpha),
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  await tool(library, "commit_shared_file").handler(
    { upload_id: second.upload_id },
    context(beta),
  );
  const got = (await tool(library, "get_shared_file").handler(
    { path: "3d/hero/hero.glb" },
    context(alpha),
  )) as {
    url: string;
    versions: { id: string; created_by: SharedFileActor }[];
  };
  expect(got.versions.map((v) => v.id)).toEqual([
    second.upload_id,
    ticket.upload_id,
  ]);
  expect(got.versions.map((v) => v.created_by)).toEqual([beta, alpha]);
  const current = await fetch(got.url);
  expect(Buffer.from(await current.arrayBuffer())).toEqual(v2);
  expect(current.headers.get("content-type")).toBe("application/octet-stream");
  const old = (await tool(library, "get_shared_file").handler(
    { path: "/3d/hero/hero.glb", version_id: ticket.upload_id },
    context(beta),
  )) as { url: string };
  expect(Buffer.from(await (await fetch(old.url)).arrayBuffer())).toEqual(v1);

  // The host itself only ever sent HEAD requests without a body.
  expect(hostRequests.length).toBeGreaterThan(0);
  expect(hostRequests.every((r) => r.method === "HEAD" && !r.body)).toBe(true);
});

test("a commit is refused until the object is in OSS with the declared size", async () => {
  const { library } = await setup();
  const by = agent("alpha", "A-1");
  const ticket = library.beginUpload(by, { path: "a.bin", size: 4 });
  await expect(library.commitUpload(by, ticket.upload_id)).rejects.toThrow(
    /还没有这个文件/u,
  );
  expect((await putToOss(ticket, Buffer.from("12345"))).status).toBe(200);
  await expect(library.commitUpload(by, ticket.upload_id)).rejects.toThrow(
    /不一致/u,
  );
  expect(library.list("").files).toEqual([]);
  expect(() =>
    library.beginUpload(by, { path: "big.mov", size: 6 * 1024 ** 3 }),
  ).toThrow(/文件大小/u);
  // A file in the way of the directories is refused before anything is signed.
  const file = library.beginUpload(by, { path: "f", size: 1 });
  await putToOss(file, Buffer.from("1"));
  await library.commitUpload(by, file.upload_id);
  expect(() => library.beginUpload(by, { path: "f/g.txt", size: 1 })).toThrow(
    /已是文件/u,
  );
  expect(() => library.beginUpload(by, { path: "f", size: 1 })).not.toThrow();
});

test("Agents cannot delete; project preferences narrow a role to read-only or none", async () => {
  const { library } = await setup();
  const by = agent("alpha", "A-1") as Extract<
    SharedFileActor,
    { kind: "assignment" }
  >;
  const body = Buffer.from("x");
  const ticket = library.beginUpload(by, { path: "keep/x.txt", size: 1 });
  await putToOss(ticket, body);
  await library.commitUpload(by, ticket.upload_id);
  expect(() => library.remove(by, "keep/x.txt", "file")).toThrow(
    /只有人可以删除/u,
  );
  expect(() => library.remove(by, "keep", "dir")).toThrow(/只有人可以删除/u);
  expect(
    sharedFileTools({ sharedFiles: library }).map((t) => t.name),
  ).not.toContain(expect.stringMatching(/delete|remove/u));

  const readOnly = context(by, { shared_files_access: { "*": "read" } });
  await expect(
    tool(library, "list_shared_files").handler({ path: "keep" }, readOnly),
  ).resolves.toBeDefined();
  await expect(
    tool(library, "upload_shared_file").handler(
      { path: "keep/y.txt", size: 1 },
      readOnly,
    ),
  ).rejects.toMatchObject({ code: "unauthorized" });
  const none = context(by, {
    shared_files_access: { "*": "read_write", coder: "none" },
  });
  await expect(
    tool(library, "get_shared_file").handler({ path: "keep/x.txt" }, none),
  ).rejects.toMatchObject({ code: "unauthorized" });
});

test("Workbench: browse, create a directory, upload direct to OSS, download by redirect, people delete", async () => {
  const { cookie } = await setup();
  const port = h?.port ?? 0;
  const post = (path: string, body: unknown) =>
    call(port, path, {
      method: "POST",
      cookie,
      headers: {
        origin: `http://${h?.hostHeader}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const empty = await call(port, "/api/shared-files", { cookie });
  expect(empty.status).toBe(200);
  expect(empty.json).toMatchObject({
    availability: "ready",
    path: "",
    dirs: [],
    files: [],
  });
  expect((empty.json as { notice: string }).notice).toContain("不要放密钥");
  // Without a session nothing is listed.
  expect((await call(port, "/api/shared-files")).status).toBe(401);

  expect((await post("/api/shared-files/dirs", { path: "视频" })).status).toBe(
    200,
  );
  const video = Buffer.alloc(256 * 1024, 7);
  const ticket = (
    await post("/api/shared-files/uploads", {
      path: "视频/demo.mp4",
      size: video.length,
      content_type: "video/mp4",
    })
  ).json as {
    upload_id: string;
    url: string;
    headers: Record<string, string>;
  };
  expect(ticket.headers["content-type"]).toBe("video/mp4");
  expect((await putToOss(ticket, video)).status).toBe(200);
  const committed = await post("/api/shared-files/uploads/commit", {
    upload_id: ticket.upload_id,
  });
  expect(committed.status).toBe(200);
  expect(committed.json).toMatchObject({
    path: "视频/demo.mp4",
    current: { created_by: { kind: "human" }, size: video.length },
  });

  const listing = await call(
    port,
    `/api/shared-files?${new URLSearchParams({ path: "视频" })}`,
    { cookie },
  );
  expect(
    (listing.json as { files: { name: string }[] }).files.map((f) => f.name),
  ).toEqual(["demo.mp4"]);
  const download = await call(
    port,
    `/api/shared-files/download?${new URLSearchParams({ path: "视频/demo.mp4" })}`,
    { cookie },
  );
  // A redirect with no body: the browser fetches the bytes from OSS.
  expect(download.status).toBe(302);
  expect(download.bytes.length).toBe(0);
  const location = new URL(String(download.headers.location));
  expect(location.origin).toBe(fake?.endpoint);
  expect(location.searchParams.get("response-content-disposition")).toContain(
    encodeURIComponent("demo.mp4"),
  );
  const fetched = await fetch(location);
  expect(Buffer.from(await fetched.arrayBuffer())).toEqual(video);
  expect(fetched.headers.get("content-type")).toBe("video/mp4");
  const versions = await call(
    port,
    `/api/shared-files/versions?${new URLSearchParams({ path: "视频/demo.mp4" })}`,
    { cookie },
  );
  expect((versions.json as { versions: unknown[] }).versions).toHaveLength(1);
  // The page may send uploads to the bucket.
  expect(String(empty.headers["content-security-policy"])).toContain(
    `connect-src 'self' ${fake?.endpoint}`,
  );

  expect(
    (await post("/api/shared-files/delete", { path: "视频", kind: "dir" }))
      .status,
  ).toBe(200);
  expect(
    (await call(port, "/api/shared-files", { cookie })).json,
  ).toMatchObject({ dirs: [], files: [] });
  expect(
    (await post("/api/shared-files/uploads", { path: "../x", size: 1 })).status,
  ).toBe(400);
  // The host relayed no bytes: only HEAD (the commit check) went to OSS.
  expect(hostRequests.every((r) => r.method === "HEAD" && !r.body)).toBe(true);
});

test("the human narrows a project's shared-library access through the Workbench preferences", async () => {
  const { cookie } = await setup();
  seedWebProject(h?.store as WebHarness["store"], h?.dataDir ?? "");
  const write = (body: unknown, key: string) =>
    call(h?.port ?? 0, `/api/projects/${project_id}/preferences`, {
      cookie,
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        origin: h?.server.url ?? "",
        "content-type": "application/json",
        "idempotency-key": key,
      },
    });
  expect(
    (await write({ shared_files_access: { "*": "read" } }, "narrow")).status,
  ).toBe(200);
  expect(
    h?.store.uow.read((tx) =>
      tx.project_preferences.get(project_id, project_id),
    )?.shared_files_access,
  ).toEqual({ "*": "read" });
  expect(
    (await write({ shared_files_access: { "*": "write" } }, "invalid")).status,
  ).toBe(400);
});

test("without the storage credential the library says so and signs nothing", async () => {
  const { cookie, library } = await setup(false);
  const port = h?.port ?? 0;
  const listing = await call(port, "/api/shared-files", { cookie });
  expect(listing.json).toMatchObject({ availability: "not_configured" });
  expect(() =>
    library.beginUpload(agent("alpha", "A-1"), { path: "a.txt", size: 1 }),
  ).toThrow(/未配置私有存储/u);
  expect(library.list("").files).toEqual([]);
});
