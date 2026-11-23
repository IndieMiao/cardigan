/** C-614: the off-site copy only ever adds a path; it never removes one. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type Assignment,
  type Attachment,
  STANDING_ROLE_TOOLS,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type FakeOss,
  startFakeOss,
  writeStorageConfig,
} from "../../test-support/fake-oss.js";
import { openArtifact } from "../artifact-files.js";
import { fileAttachmentStore, sha256 } from "../attachments.js";
import { downloadAttachment } from "../download-attachment.js";
import { type RunningServer, startMcpServer } from "../server.js";
import {
  acceptingVerifierFor,
  card_id,
  NOW,
  project_id,
  seedProject,
} from "../test-support.js";
import { readOffsiteConfig } from "./config.js";
import {
  artifactKey,
  attachmentKey,
  Offsite,
  registerOffsite,
} from "./offsite.js";
import { OssClient, presignGet } from "./oss.js";
import { SyncedLedger } from "./state.js";

let root: string, dataDir: string, configDir: string;
let fake: FakeOss;
let clock: Date;
/** How far OSS's clock runs ahead: a URL signed now arrives expired. */
let ossSkewMs: number;
let cleanup: (() => void | Promise<void>)[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cardigan-offsite-"));
  dataDir = join(root, "data");
  configDir = join(root, "config");
  await mkdir(dataDir, { mode: 0o700 });
  clock = new Date("2026-11-23T03:00:10.000Z");
  ossSkewMs = 0;
  fake = await startFakeOss(() => new Date(clock.getTime() + ossSkewMs));
  cleanup = [];
});
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  await fake.close();
  await rm(root, { recursive: true, force: true });
});

async function offsite(extra: Record<string, unknown> = {}) {
  const storageDir = await writeStorageConfig(configDir, fake, extra);
  const o = new Offsite({
    dataDir,
    storageDir,
    role: "test",
    now: () => clock,
  });
  cleanup.push(registerOffsite(o));
  return o;
}
/** A verified copy, as the background sync leaves it. */
function synced(o: Offsite, key: string, body: Buffer) {
  const digest = sha256(body);
  fake.objects.set(key, { body, sha256: digest });
  o.ledger.record({ key, sha256: digest, size: body.length, at: NOW });
  return digest;
}

test("configuration: absent, private-only, and both credential layouts", async () => {
  const dir = join(configDir, "storage");
  expect(readOffsiteConfig(dir)).toEqual({ state: "absent" });
  await writeStorageConfig(configDir, fake);
  const ready = readOffsiteConfig(dir);
  expect(ready.state).toBe("ready");
  if (ready.state !== "ready") throw new Error("fixture");
  expect(ready.settings).toMatchObject({
    monthly_budget_yuan: 50,
    signed_url_ttl_seconds: 600,
    credentials: { bucket: "cardigan-fixture", region: "us-west-1" },
  });
  // The flat layout, with an owner-chosen budget.
  await writeFile(
    join(dir, "aliyun-config.json"),
    JSON.stringify({
      bucket: "cardigan-fixture",
      region: "oss-us-west-1",
      access_key_id: "id",
      access_key_secret: "secret",
      monthly_budget_yuan: 20,
    }),
  );
  expect(readOffsiteConfig(dir)).toMatchObject({
    state: "ready",
    settings: { monthly_budget_yuan: 20, credentials: { region: "us-west-1" } },
  });
  // Readable by others, a public endpoint override or junk: never used.
  await chmod(join(dir, "aliyun-config.json"), 0o644);
  expect(readOffsiteConfig(dir)).toEqual({ state: "invalid" });
  await chmod(join(dir, "aliyun-config.json"), 0o600);
  await writeStorageConfig(configDir, fake, {
    endpoint: "https://attacker.invalid",
  });
  expect(readOffsiteConfig(dir)).toEqual({ state: "invalid" });
  await chmod(dir, 0o755);
  expect(readOffsiteConfig(dir)).toEqual({ state: "invalid" });
});

test("the ledger is shared append-only and ignores torn or foreign lines", async () => {
  const target = "0123456789abcdef";
  const writer = new SyncedLedger(dataDir, target);
  const reader = new SyncedLedger(dataDir, target);
  writer.record({
    key: attachmentKey("a".repeat(64)),
    sha256: "a".repeat(64),
    size: 3,
    at: NOW,
  });
  expect(reader.refresh().get(attachmentKey("a".repeat(64)))?.size).toBe(3);
  const file = join(dataDir, "offsite", `synced-${target}.jsonl`);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await appendFile(
    file,
    '{"key":"../etc","sha256":"x","size":1}\n{"key":"attach',
  );
  writer.record({
    key: artifactKey("1".repeat(8) + "-1111-1111-1111-111111111111"),
    sha256: "b".repeat(64),
    size: 5,
    at: NOW,
  });
  reader.refresh();
  expect(reader.count).toBe(1);
  expect(reader.totalBytes).toBe(3);
});

test("signed URLs cover every parameter; tampering and expiry are refused", async () => {
  const o = await offsite();
  const body = Buffer.from("image bytes");
  const digest = synced(o, attachmentKey("c".repeat(64)), body);
  expect(digest).toHaveLength(64);
  const url = o.thumbnailUrl("c".repeat(64))?.url;
  expect(url).toBeDefined();
  // Signed at 03:00:00 (stable window) for 600 seconds; now is 03:00:10.
  expect(o.thumbnailUrl("c".repeat(64))?.valid_for_seconds).toBe(590);
  const parsed = new URL(url ?? "");
  expect(parsed.searchParams.get("x-oss-process")).toContain("resize,w_480");
  expect(parsed.searchParams.get("x-oss-signature-version")).toBe(
    "OSS4-HMAC-SHA256",
  );
  // The secret never appears in a URL.
  expect(url).not.toContain("fixture-secret");
  expect((await fetch(parsed)).status).toBe(200);
  const tampered = new URL(parsed);
  tampered.searchParams.set("x-oss-process", "image/resize,w_9999");
  expect((await fetch(tampered)).status).toBe(403);
  // Stable within half the lifetime, so the browser reuses its cache.
  clock = new Date("2026-11-23T03:04:59.000Z");
  expect(o.thumbnailUrl("c".repeat(64))?.url).toBe(url);
  clock = new Date("2026-11-23T03:05:00.000Z");
  expect(o.thumbnailUrl("c".repeat(64))?.url).not.toBe(url);
  // Signed at 03:00:00 for 600 seconds.
  clock = new Date("2026-11-23T03:10:01.000Z");
  expect((await fetch(parsed)).status).toBe(403);
  // No verified copy, no URL.
  expect(o.thumbnailUrl("d".repeat(64))).toBeUndefined();
});

test("a blob missing locally comes from the verified copy and is cached", async () => {
  const o = await offsite();
  const body = Buffer.from("attachment that only OSS still has");
  const digest = synced(o, attachmentKey(sha256(body)), body);
  const blobs = fileAttachmentStore(dataDir);
  expect(await blobs.get(digest)).toEqual(body);
  expect(await readFile(join(dataDir, "attachments", digest))).toEqual(body);
  const gets = fake.requests.filter((r) => r.method === "GET").length;
  expect(await blobs.get(digest)).toEqual(body);
  // The second read is local.
  expect(fake.requests.filter((r) => r.method === "GET")).toHaveLength(gets);
});

test.each(["corrupt", "down", "denied"] as const)(
  "a %s copy is refused and the read stays missing",
  async (mode) => {
    const o = await offsite();
    const body = Buffer.from(`attachment ${mode}`);
    const digest = synced(o, attachmentKey(sha256(body)), body);
    fake.mode = mode;
    expect(await fileAttachmentStore(dataDir).get(digest)).toBeUndefined();
    await expect(
      stat(join(dataDir, "attachments", digest)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("without a configuration or a ledger entry OSS is never asked", async () => {
  const o = new Offsite({
    dataDir,
    storageDir: join(configDir, "storage"),
    role: "test",
  });
  cleanup.push(registerOffsite(o));
  const body = Buffer.from("never synced");
  fake.objects.set(attachmentKey(sha256(body)), { body });
  expect(await fileAttachmentStore(dataDir).get(sha256(body))).toBeUndefined();
  expect(o.thumbnailUrl(sha256(body))).toBeUndefined();
  expect(o.status()).toMatchObject({ configured: "absent", alerts: [] });
  expect(fake.requests).toEqual([]);
});

test("a streamed artifact gone locally is restored from its verified copy", async () => {
  const o = await offsite();
  const blob = "0f0f0f0f-1111-2222-3333-444444444444";
  const body = Buffer.alloc(256 * 1024, 7);
  const digest = synced(o, artifactKey(blob), body);
  await mkdir(join(dataDir, "artifacts"), { mode: 0o700 });
  const record = {
    id: "F-9",
    sha256: digest,
    size: body.length,
    streamed_artifact: { blob_id: blob },
  } as unknown as Attachment;
  const file = await openArtifact(dataDir, record);
  await file.close();
  expect(await readFile(join(dataDir, "artifacts", blob))).toEqual(body);
  // Wrong bytes are never published.
  const other = "1f0f0f0f-1111-2222-3333-444444444444";
  synced(o, artifactKey(other), body);
  fake.mode = "corrupt";
  await expect(
    openArtifact(dataDir, {
      ...record,
      streamed_artifact: { blob_id: other },
    } as unknown as Attachment),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(stat(join(dataDir, "artifacts", other))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("after the data directory is lost, recorded content comes back from the bucket by its key", async () => {
  // The objects exist remotely; the ledger went with the data directory.
  const body = Buffer.from("attachment restored after a disk loss");
  const digest = sha256(body);
  fake.objects.set(attachmentKey(digest), { body, sha256: digest });
  const blob = "2f0f0f0f-1111-2222-3333-444444444444";
  const big = Buffer.alloc(128 * 1024, 5);
  fake.objects.set(artifactKey(blob), { body: big, sha256: sha256(big) });
  const o = await offsite();
  expect(o.ledger.count).toBe(0);
  expect(await fileAttachmentStore(dataDir).get(digest)).toEqual(body);
  expect(await readFile(join(dataDir, "attachments", digest))).toEqual(body);
  // There is no artifacts/ directory at all.
  const file = await openArtifact(dataDir, {
    id: "F-1",
    sha256: sha256(big),
    size: big.length,
    streamed_artifact: { blob_id: blob },
  } as unknown as Attachment);
  await file.close();
  expect(await readFile(join(dataDir, "artifacts", blob))).toEqual(big);
  expect((await stat(join(dataDir, "artifacts"))).mode & 0o777).toBe(0o700);
  // Verified reads are recorded, so signed URLs work again.
  expect(o.ledger.count).toBe(2);
  expect(o.thumbnailUrl(digest)).toBeDefined();
});

test("without a ledger entry, other bytes are refused and a missing object is not asked again soon", async () => {
  const o = await offsite();
  const body = Buffer.from("never trusted without its digest");
  const digest = sha256(body);
  fake.objects.set(attachmentKey(digest), { body: Buffer.from("other bytes") });
  expect(await fileAttachmentStore(dataDir).get(digest)).toBeUndefined();
  await expect(
    stat(join(dataDir, "attachments", digest)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const blob = "3f0f0f0f-1111-2222-3333-444444444444";
  fake.objects.set(artifactKey(blob), { body: Buffer.from("other bytes") });
  await expect(
    openArtifact(dataDir, {
      id: "F-2",
      sha256: digest,
      size: 11,
      streamed_artifact: { blob_id: blob },
    } as unknown as Attachment),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(o.ledger.count).toBe(0);
  const missing = "9".repeat(64);
  const gets = () =>
    fake.requests.filter(
      (r) => r.method === "GET" && r.key === attachmentKey(missing),
    ).length;
  expect(await fileAttachmentStore(dataDir).get(missing)).toBeUndefined();
  expect(await fileAttachmentStore(dataDir).get(missing)).toBeUndefined();
  expect(gets()).toBe(1);
  clock = new Date(clock.getTime() + 10 * 60_000 + 1);
  expect(await fileAttachmentStore(dataDir).get(missing)).toBeUndefined();
  expect(gets()).toBe(2);
});

test("a read keeps the bucket it started with, and a 404 in one bucket does not hide another", async () => {
  const body = Buffer.from("restored from bucket A");
  const digest = sha256(body);
  fake.objects.set(attachmentKey(digest), { body, sha256: digest });
  const o = await offsite();
  const first = o.target();
  const other = await startFakeOss(() => clock);
  cleanup.push(() => other.close());
  const only = Buffer.from("only in bucket B");
  other.objects.set(attachmentKey(sha256(only)), {
    body: only,
    sha256: sha256(only),
  });
  // Bucket A does not have it.
  expect(await fileAttachmentStore(dataDir).get(sha256(only))).toBeUndefined();
  // A read from A is still in flight when the configuration moves to B.
  let release = () => {};
  let started = () => {};
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  fake.hold = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      started();
    });
  const reading = fileAttachmentStore(dataDir).get(digest);
  await sent;
  await writeStorageConfig(configDir, other);
  clock = new Date(clock.getTime() + 31_000);
  expect(o.target()).not.toBe(first);
  release();
  expect(await reading).toEqual(body);
  // The proven copy is A's: B records nothing and signs nothing for it.
  expect(o.ledger.count).toBe(0);
  expect(o.thumbnailUrl(digest)).toBeUndefined();
  expect(
    new SyncedLedger(dataDir, first ?? "").refresh().get(attachmentKey(digest)),
  ).toBeDefined();
  expect(other.requests).toEqual([]);
  // A's "missing" does not stop asking B.
  expect(await fileAttachmentStore(dataDir).get(sha256(only))).toEqual(only);
  expect(other.requests).toMatchObject([
    { method: "GET", key: attachmentKey(sha256(only)) },
  ]);
  expect(o.ledger.get(attachmentKey(sha256(only)))).toBeDefined();
});

test("an artifact restore in flight during a bucket switch is recorded for its own bucket", async () => {
  const blob = "4f0f0f0f-1111-2222-3333-444444444444";
  const body = Buffer.alloc(64 * 1024, 4);
  fake.objects.set(artifactKey(blob), { body, sha256: sha256(body) });
  const o = await offsite();
  const first = o.target();
  const other = await startFakeOss(() => clock);
  cleanup.push(() => other.close());
  let release = () => {};
  let started = () => {};
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  fake.hold = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      started();
    });
  const opening = openArtifact(dataDir, {
    id: "F-4",
    sha256: sha256(body),
    size: body.length,
    streamed_artifact: { blob_id: blob },
  } as unknown as Attachment);
  await sent;
  await writeStorageConfig(configDir, other);
  clock = new Date(clock.getTime() + 31_000);
  release();
  await (await opening).close();
  expect(await readFile(join(dataDir, "artifacts", blob))).toEqual(body);
  expect(o.ledger.get(artifactKey(blob))).toBeUndefined();
  expect(
    new SyncedLedger(dataDir, first ?? "").refresh().get(artifactKey(blob)),
  ).toBeDefined();
});

test("uploads never overwrite and carry the verified digest", async () => {
  const o = await offsite();
  const client = o.client() as OssClient;
  const body = Buffer.from("upload");
  const meta = {
    size: body.length,
    sha256: sha256(body),
    md5: createHash("md5").update(body).digest("base64"),
  };
  const key = attachmentKey(sha256(body));
  expect(await client.put(key, body, meta)).toBe("created");
  expect(await client.put(key, Buffer.from("upload"), meta)).toBe("exists");
  expect(await client.head(key)).toEqual({ size: 6, sha256: sha256(body) });
  // Content-MD5 rejects bytes that changed after hashing.
  await expect(
    client.put(attachmentKey("e".repeat(64)), Buffer.from("other!"), meta),
  ).rejects.toMatchObject({ code: "rejected" });
  expect(fake.requests.every((r) => r.signed === "header")).toBe(true);
});

test("usage and the monthly estimate show on the status; over budget only alerts", async () => {
  const o = await offsite({ monthly_budget_yuan: 0 });
  const body = Buffer.alloc(1024, 1);
  synced(o, attachmentKey(sha256(body)), body);
  expect(o.thumbnailUrl(sha256(body))).toBeDefined();
  const status = o.status();
  expect(status).toMatchObject({
    configured: "ready",
    bucket: "cardigan-fixture",
    synced: { count: 1, bytes: 1024 },
    usage: { requests: 1, process_bytes: 1024, budget_yuan: 0 },
  });
  expect(status.alerts).toContain("over_budget");
  // Over budget still signs.
  expect(o.previewUrl(sha256(body), "image/png")).toBeDefined();
  expect(JSON.stringify(status)).not.toContain("fixture-secret");
});

test("requests are charged in the month they happen; only storage carries over", async () => {
  const o = await offsite({
    monthly_budget_yuan: 1.5,
    prices: {
      storage_gb_month: 0,
      egress_gb: 0,
      image_process_gb: 0,
      requests_10k: 10_000,
    },
  });
  const body = Buffer.from("one object");
  synced(o, attachmentKey(sha256(body)), body);
  // Its one upload, counted by the sync when it happened.
  o.usage.add({ requests: 1 });
  const november = o.status();
  expect(november.usage).toMatchObject({
    month: "2026-11",
    requests: 1,
    estimated_yuan: 1,
  });
  expect(november.alerts).toEqual([]);
  clock = new Date("2026-12-02T00:00:00.000Z");
  const december = o.status();
  expect(december.usage).toMatchObject({
    month: "2026-12",
    requests: 0,
    estimated_yuan: 0,
  });
  expect(december.alerts).toEqual([]);
});

test.each(["503", "reset"] as const)(
  "when asking for a signed URL fails (%s), the helper retries once on the plain channel",
  async (failure) => {
    const body = Buffer.from("bytes from the plain Card MCP channel");
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      const offer = req.headers["x-cardigan-download"];
      seen.push(typeof offer === "string" ? offer : undefined);
      if (req.headers.authorization !== "Bearer fixture-token") {
        res.writeHead(401).end();
        return;
      }
      if (offer === "signed-url") {
        if (failure === "reset") req.socket.destroy();
        else res.writeHead(503).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
        "X-Attachment-Id": "F-7",
        "X-Attachment-Sha256": sha256(body),
      });
      res.end(body);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanup.push(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/attachments`;
    const file = join(root, `plain-${failure}`);
    expect(
      await downloadAttachment(url, "F-7", file, "fixture-token"),
    ).toMatchObject({ via: "card_mcp", sha256: sha256(body) });
    expect(await readFile(file)).toEqual(body);
    expect(seen).toEqual(["signed-url", undefined]);
    // Errors the plain channel would repeat are not retried.
    seen.length = 0;
    await expect(
      downloadAttachment(url, "F-7", join(root, "denied"), "wrong-token"),
    ).rejects.toThrow("[download]");
    expect(seen).toEqual(["signed-url"]);
  },
);

/**
 * Fixed V4 vectors. The expected signatures come from a separate Python
 * implementation of the published OSS V4 algorithm (canonical request, scope
 * `<day>/<region>/oss/aliyun_v4_request`, key `aliyun_v4<secret>` chained over
 * day, region, `oss`, `aliyun_v4_request`), not from this module.
 */
test("V4 signatures match fixed vectors for a header-signed PUT and a pre-signed GET", async () => {
  const credentials = {
    bucket: "examplebucket",
    region: "cn-hangzhou",
    access_key_id: "LTAI5tExampleKeyId",
    access_key_secret: "ExampleSecret0123456789",
  };
  const at = new Date("2026-11-23T03:15:00.000Z");
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const client = new OssClient(
    credentials,
    async (url, init) => {
      sent.push({ url, headers: init.headers });
      return Object.assign(Readable.from([]), {
        statusCode: 200,
        headers: {},
      }) as never;
    },
    () => at,
  );
  await client.put(attachmentKey("a".repeat(64)), Buffer.alloc(0), {
    size: 0,
    sha256: "a".repeat(64),
    md5: "1B2M2Y8AsgTpgAmY7PhCfg==",
  });
  expect(sent[0]?.url).toBe(
    `https://examplebucket.oss-cn-hangzhou.aliyuncs.com/attachments/${"a".repeat(64)}`,
  );
  expect(sent[0]?.headers.authorization).toBe(
    "OSS4-HMAC-SHA256 Credential=LTAI5tExampleKeyId/20261123/cn-hangzhou/oss/aliyun_v4_request,Signature=8031c46f68dbb5f6efb2e3af3feda0ed4f03529572574e53d7cdb47071d9420c",
  );
  const url = new URL(
    presignGet(
      credentials,
      artifactKey("0f0f0f0f-1111-2222-3333-444444444444"),
      {
        expires: 600,
        at,
        query: { "x-oss-process": "image/resize,w_480" },
      },
    ),
  );
  expect(url.searchParams.get("x-oss-signature")).toBe(
    "004673b1cf89420a1ece8b331da44b11bb415d70d03728f9043ae492754145af",
  );
  expect(url.searchParams.get("x-oss-credential")).toBe(
    "LTAI5tExampleKeyId/20261123/cn-hangzhou/oss/aliyun_v4_request",
  );
});

describe_download();
function describe_download() {
  let store: Store, server: RunningServer, client: Client, token: string;
  const content = Buffer.from("Attachment fetched by a remote worker");
  const setup = async () => {
    store = Store.open({ dbPath: ":memory:" });
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
    });
    const issued = store.issueToken({
      id: (assignment as Assignment).mcp_token_id,
      project_id,
      assignment_id: assignment.id,
      role: { role_version: 1, allowed_tools: STANDING_ROLE_TOOLS },
    });
    token = issued.token;
    client = new Client({ name: "offsite-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    cleanup.push(async () => {
      await client.close();
      await server.close();
      store.close();
    });
    const result = await client.callTool({
      name: "upload_attachment",
      arguments: {
        idempotency_key: "offsite-upload",
        card_id,
        file: content.toString("base64"),
        mime: "text/plain",
        kind: "evidence",
        attach_to: { kind: "timeline_entry", id: "C-1#1" },
      },
    });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as unknown as Attachment;
  };
  const artifact = async (bytes: Buffer) => {
    const grant = await client.callTool({
      name: "upload_attachment",
      arguments: {
        idempotency_key: `artifact-${sha256(bytes)}`,
        card_id,
        mime: "application/vnd.android.package-archive",
        original_filename: "fixture.apk",
        kind: "evidence",
        attach_to: { kind: "timeline_entry", id: "C-1#1" },
        artifact_size: bytes.length,
        sha256: sha256(bytes),
      },
    });
    const { upload_query } = grant.structuredContent as {
      upload_query: string;
    };
    const res = await fetch(server.url + upload_query, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
      },
      body: bytes,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Attachment;
  };

  test("a worker downloads attachments and artifacts from signed URLs", async () => {
    const a = await setup();
    const o = await offsite();
    synced(o, attachmentKey(a.sha256), content);
    const big = Buffer.alloc(512 * 1024, 3);
    const apk = await artifact(big);
    synced(o, artifactKey(apk.streamed_artifact?.blob_id ?? ""), big);
    const file = join(root, "attachment.txt");
    expect(
      await downloadAttachment(server.url, a.id, file, token),
    ).toMatchObject({ attachment_id: a.id, sha256: a.sha256, via: "offsite" });
    expect(await readFile(file)).toEqual(content);
    const apkFile = join(root, "fixture.apk");
    expect(
      await downloadAttachment(server.url, apk.id, apkFile, token),
    ).toMatchObject({ size: big.length, via: "offsite" });
    expect(await readFile(apkFile)).toEqual(big);
    expect(
      fake.requests.filter((r) => r.method === "GET").map((r) => r.signed),
    ).toEqual(["query", "query"]);
  });

  test.each(["denied", "corrupt", "down"] as const)(
    "an expired or failing signed URL (%s) falls back to Card MCP bytes",
    async (mode) => {
      const a = await setup();
      const o = await offsite();
      synced(o, attachmentKey(a.sha256), content);
      fake.mode = mode;
      const file = join(root, `fallback-${mode}`);
      expect(
        await downloadAttachment(server.url, a.id, file, token),
      ).toMatchObject({ via: "card_mcp", sha256: a.sha256 });
      expect(await readFile(file)).toEqual(content);
    },
  );

  test("a signed URL past its lifetime is refused by OSS and the helper falls back", async () => {
    const a = await setup();
    const o = await offsite();
    synced(o, attachmentKey(a.sha256), content);
    const signedResponse = await fetch(`${server.url}?attachment_id=${a.id}`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-cardigan-download": "signed-url",
      },
    });
    const { url } = (await signedResponse.json()) as { url: string };
    expect((await fetch(url)).status).toBe(200);
    // Every URL the server signs now reaches OSS after its lifetime.
    ossSkewMs = 11 * 60_000;
    expect((await fetch(url)).status).toBe(403);
    const file = join(root, "after-expiry");
    expect(
      await downloadAttachment(server.url, a.id, file, token),
    ).toMatchObject({ via: "card_mcp" });
    expect(await readFile(file)).toEqual(content);
  });

  test("the released older helper still gets verified bytes from a server with OSS", async () => {
    const a = await setup();
    const o = await offsite();
    synced(o, attachmentKey(a.sha256), content);
    const tools = await mkdtemp(join(tmpdir(), "cardigan-legacy-helper-"));
    cleanup.push(() => rm(tools, { recursive: true, force: true }));
    const helper = join(tools, "download-attachment.mjs");
    await copyFile(
      fileURLToPath(
        new URL(
          "../../test-support/fixtures/download-attachment-7c3ed8f.mjs.txt",
          import.meta.url,
        ),
      ),
      helper,
    );
    const file = join(root, "legacy.txt");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [helper, server.url, a.id, file],
      { cwd: tools, env: { PATH: process.env.PATH ?? "", MCP_TOKEN: token } },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      attachment_id: a.id,
      sha256: a.sha256,
    });
    expect(await readFile(file)).toEqual(content);
    // It never sent the opt-in header, so OSS was not involved.
    expect(fake.requests.filter((r) => r.method === "GET")).toEqual([]);
  });
}
