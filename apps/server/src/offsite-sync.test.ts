/** C-614: the off-site sync copies after the fact and never blocks or deletes. */
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "@cardigan/domain";
import {
  artifactKey,
  attachmentKey,
  fileAttachmentStore,
  Offsite,
  registerOffsite,
} from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type FakeOss,
  startFakeOss,
  writeStorageConfig,
} from "../../../packages/mcp-server/test-support/fake-oss.js";
import { OffsiteSync } from "./offsite-sync.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
let root: string, dataDir: string, configDir: string;
let fake: FakeOss, clock: Date, records: Attachment[];
let unregister: (() => void) | undefined;
const store = {
  listProjects: () => [{ id: "p" }],
  uow: {
    read: (fn: (tx: unknown) => unknown) =>
      fn({ attachments: { list: () => records } }),
  },
} as unknown as Pick<Store, "listProjects" | "uow">;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cardigan-offsite-sync-"));
  dataDir = join(root, "data");
  configDir = join(root, "config");
  await mkdir(dataDir, { mode: 0o700 });
  clock = new Date("2026-11-23T03:00:00.000Z");
  fake = await startFakeOss(() => clock);
  records = [];
});
afterEach(async () => {
  unregister?.();
  unregister = undefined;
  await fake.close();
  await rm(root, { recursive: true, force: true });
});

async function harness(configured = true) {
  const storageDir = configured
    ? await writeStorageConfig(configDir, fake)
    : join(configDir, "storage");
  const offsite = new Offsite({
    dataDir,
    storageDir,
    role: "background",
    now: () => clock,
  });
  unregister = registerOffsite(offsite);
  return {
    offsite,
    sync: new OffsiteSync({ offsite, store, now: () => clock }),
    status: async () =>
      JSON.parse(
        await readFile(join(dataDir, "offsite", "status.json"), "utf8"),
      ),
  };
}
async function attachment(text: string) {
  const body = Buffer.from(text);
  await fileAttachmentStore(dataDir).put(sha(body), body);
  return { body, digest: sha(body) };
}
async function artifact(blob: string, body: Buffer) {
  await mkdir(join(dataDir, "artifacts"), { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, "artifacts", blob), body, { mode: 0o600 });
  records.push({
    id: `F-${records.length + 1}`,
    sha256: sha(body),
    size: body.length,
    streamed_artifact: { blob_id: blob },
  } as unknown as Attachment);
}
const BLOB = "aaaaaaaa-1111-2222-3333-444444444444";

test("existing attachments and artifacts are backfilled, verified and recorded once", async () => {
  const one = await attachment("first attachment");
  const two = await attachment("second attachment");
  const big = Buffer.alloc(300 * 1024, 9);
  await artifact(BLOB, big);
  // An artifact file without a committed record is left alone.
  await writeFile(
    join(dataDir, "artifacts", "bbbbbbbb-1111-2222-3333-444444444444"),
    "in flight",
  );
  const h = await harness();
  await h.sync.tick();
  expect(fake.objects.get(attachmentKey(one.digest))?.body).toEqual(one.body);
  expect(fake.objects.get(attachmentKey(two.digest))?.sha256).toBe(two.digest);
  expect(fake.objects.get(artifactKey(BLOB))?.body).toEqual(big);
  expect(fake.objects.size).toBe(3);
  expect(await h.status()).toMatchObject({
    configured: "ready",
    pending: { count: 0, bytes: 0 },
    failed: { count: 0 },
    reachable: true,
    last_success_at: clock.toISOString(),
  });
  // A restart resumes from the ledger: nothing is uploaded twice.
  const puts = fake.requests.filter((r) => r.method === "PUT").length;
  const again = new OffsiteSync({
    offsite: h.offsite,
    store,
    now: () => clock,
  });
  await again.tick();
  expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(puts);
  // Local files are never removed.
  expect((await readdir(join(dataDir, "attachments"))).sort()).toEqual(
    [one.digest, two.digest].sort(),
  );
});

test("while OSS is down uploads still succeed locally and are copied once it recovers", async () => {
  const h = await harness();
  fake.mode = "down";
  const first = await attachment("written during the outage");
  await h.sync.tick();
  expect(await fileAttachmentStore(dataDir).get(first.digest)).toEqual(
    first.body,
  );
  expect(await h.status()).toMatchObject({
    pending: { count: 1 },
    failed: { count: 1, last_code: "network" },
    reachable: false,
  });
  expect(h.offsite.status().alerts).toEqual(
    expect.arrayContaining(["unreachable", "sync_failed"]),
  );
  // Signed URLs are not handed out while OSS is known to be unreachable.
  expect(h.offsite.thumbnailUrl(first.digest)).toBeUndefined();
  fake.mode = "up";
  // Backoff: the next tick inside the window does not retry.
  await h.sync.tick();
  expect(fake.objects.size).toBe(0);
  clock = new Date(clock.getTime() + 61_000);
  const second = await attachment("written after recovery");
  await h.sync.tick();
  expect(fake.objects.has(attachmentKey(first.digest))).toBe(true);
  expect(fake.objects.has(attachmentKey(second.digest))).toBe(true);
  expect(await h.status()).toMatchObject({
    pending: { count: 0 },
    failed: { count: 0 },
    reachable: true,
  });
});

test("an existing object is accepted only when it holds the same bytes, and is never overwritten", async () => {
  const same = await attachment("already there");
  const other = await attachment("conflicting");
  fake.objects.set(attachmentKey(same.digest), {
    body: same.body,
    sha256: same.digest,
  });
  const foreign = { body: Buffer.from("not ours"), sha256: "f".repeat(64) };
  fake.objects.set(attachmentKey(other.digest), foreign);
  const h = await harness();
  await h.sync.tick();
  expect(h.offsite.ledger.get(attachmentKey(same.digest))).toBeDefined();
  expect(h.offsite.ledger.get(attachmentKey(other.digest))).toBeUndefined();
  expect(fake.objects.get(attachmentKey(other.digest))).toBe(foreign);
  expect(await h.status()).toMatchObject({
    failed: { count: 1, last_code: "integrity" },
    reachable: true,
  });
});

test("a corrupt local file is never copied", async () => {
  const good = await attachment("good");
  await writeFile(join(dataDir, "attachments", "e".repeat(64)), "bad", {
    mode: 0o600,
  });
  await artifact(BLOB, Buffer.from("recorded"));
  await writeFile(join(dataDir, "artifacts", BLOB), "tampered", {
    mode: 0o600,
  });
  const h = await harness();
  await h.sync.tick();
  expect([...fake.objects.keys()]).toEqual([attachmentKey(good.digest)]);
  expect(await h.status()).toMatchObject({
    pending: { count: 2 },
    failed: { count: 2, last_code: "integrity" },
  });
});

test("without a configuration nothing is sent and the status says so", async () => {
  await attachment("local only");
  const h = await harness(false);
  await h.sync.tick();
  expect(fake.requests).toEqual([]);
  expect(await h.status()).toMatchObject({ configured: "absent" });
  expect(h.offsite.status()).toMatchObject({
    configured: "absent",
    alerts: [],
  });
});

test("shutdown aborts an upload in flight without recording it", async () => {
  await attachment("slow upload");
  const h = await harness();
  fake.mode = "down";
  h.sync.stop();
  await h.sync.tick();
  expect(h.offsite.ledger.count).toBe(0);
});

test("an outage with nothing left to retry clears once OSS answers again", async () => {
  const gone = await attachment("removed before the retry");
  const h = await harness();
  fake.mode = "down";
  await h.sync.tick();
  expect(await h.status()).toMatchObject({ reachable: false });
  await rm(join(dataDir, "attachments", gone.digest));
  fake.mode = "up";
  await h.sync.tick();
  expect(await h.status()).toMatchObject({
    reachable: true,
    pending: { count: 0 },
    failed: { count: 0 },
  });
});
