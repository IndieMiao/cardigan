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
import { OFFSITE_RESCAN_MS, OffsiteSync } from "./offsite-sync.js";

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
/** A committed attachment record for `digest` (not a streamed artifact). */
function recordAttachment(digest: string, size: number) {
  records.push({
    id: `F-${records.length + 1}`,
    sha256: digest,
    size,
  } as unknown as Attachment);
}
async function attachment(text: string, recorded = true) {
  const body = Buffer.from(text);
  await fileAttachmentStore(dataDir).put(sha(body), body);
  if (recorded) recordAttachment(sha(body), body.length);
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
  // Same length and the right metadata, but a damaged body.
  const damaged = await attachment("damaged remote body");
  const bad = {
    body: Buffer.alloc(damaged.body.length, 0x41),
    sha256: damaged.digest,
  };
  fake.objects.set(attachmentKey(damaged.digest), bad);
  const h = await harness();
  await h.sync.tick();
  expect(h.offsite.ledger.get(attachmentKey(same.digest))).toBeDefined();
  expect(h.offsite.ledger.get(attachmentKey(other.digest))).toBeUndefined();
  expect(h.offsite.ledger.get(attachmentKey(damaged.digest))).toBeUndefined();
  // Never overwritten.
  expect(fake.objects.get(attachmentKey(other.digest))).toBe(foreign);
  expect(fake.objects.get(attachmentKey(damaged.digest))).toBe(bad);
  // The existing objects' content was read, not just their metadata.
  expect(
    fake.requests
      .filter((r) => r.method === "GET")
      .map((r) => r.key)
      .sort(),
  ).toEqual(
    [same.digest, other.digest, damaged.digest].map(attachmentKey).sort(),
  );
  expect(await h.status()).toMatchObject({
    pending: { count: 2 },
    failed: { count: 2, last_code: "integrity" },
    reachable: true,
  });
  expect(h.offsite.thumbnailUrl(damaged.digest)).toBeUndefined();
});

test("a corrupt local file is never copied", async () => {
  const good = await attachment("good");
  await writeFile(join(dataDir, "attachments", "e".repeat(64)), "bad", {
    mode: 0o600,
  });
  recordAttachment("e".repeat(64), 3);
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
  // C-628: the listing is reused until the next rescan; a removed file
  // leaves the queue then (or as soon as its upload finds it gone).
  clock = new Date(clock.getTime() + OFFSITE_RESCAN_MS);
  await h.sync.tick();
  expect(await h.status()).toMatchObject({
    reachable: true,
    pending: { count: 0 },
    failed: { count: 0 },
  });
});

test("an attachment blob without a committed record stays local until one is committed", async () => {
  const kept = await attachment("recorded attachment");
  // The blob of an upload the domain rejected: written first, never recorded.
  const rejected = await attachment("rejected upload", false);
  const h = await harness();
  await h.sync.tick();
  expect([...fake.objects.keys()]).toEqual([attachmentKey(kept.digest)]);
  expect(await h.status()).toMatchObject({
    pending: { count: 0 },
    failed: { count: 0 },
  });
  // Never removed locally.
  expect(await readFile(join(dataDir, "attachments", rejected.digest))).toEqual(
    rejected.body,
  );
  // Committed later: copied once the records are read again.
  recordAttachment(rejected.digest, rejected.body.length);
  clock = new Date(clock.getTime() + 61_000);
  await h.sync.tick();
  expect(fake.objects.has(attachmentKey(rejected.digest))).toBe(true);
});

test("switching to another bucket copies everything there again", async () => {
  const one = await attachment("copied to the first bucket");
  await artifact(BLOB, Buffer.alloc(2048, 3));
  const h = await harness();
  await h.sync.tick();
  expect(fake.objects.size).toBe(2);
  const first = (await h.status()).target;
  const other = await startFakeOss(() => clock);
  try {
    await writeStorageConfig(configDir, other);
    clock = new Date(clock.getTime() + 61_000);
    // The first bucket's copies do not count for the second one.
    expect(h.offsite.ledger.count).toBe(0);
    expect(h.offsite.thumbnailUrl(one.digest)).toBeUndefined();
    await h.sync.tick();
    expect([...other.objects.keys()].sort()).toEqual(
      [attachmentKey(one.digest), artifactKey(BLOB)].sort(),
    );
    const status = await h.status();
    expect(status.target).not.toBe(first);
    expect(status).toMatchObject({
      pending: { count: 0 },
      failed: { count: 0 },
      reachable: true,
    });
    expect(h.offsite.ledger.count).toBe(2);
    expect(h.offsite.thumbnailUrl(one.digest)?.url).toMatch(
      new RegExp(`^${other.endpoint}/`, "u"),
    );
  } finally {
    await other.close();
  }
});

test("an idle, fully synced copy still notices an outage or a refused key, and recovery", async () => {
  const one = await attachment("synced before the outage");
  const h = await harness();
  await h.sync.tick();
  expect(await h.status()).toMatchObject({
    pending: { count: 0 },
    reachable: true,
  });
  // Idle checks are rate-limited: nothing is sent within the probe interval.
  const sent = fake.requests.length;
  clock = new Date(clock.getTime() + 30_000);
  await h.sync.tick();
  expect(fake.requests).toHaveLength(sent);
  for (const mode of ["down", "denied"] as const) {
    fake.mode = mode;
    clock = new Date(clock.getTime() + 5 * 60_000);
    await h.sync.tick();
    expect(await h.status()).toMatchObject({ reachable: false });
    expect(h.offsite.status().alerts).toContain("unreachable");
    // No URL that cannot work is handed out; local reads are unaffected.
    expect(h.offsite.thumbnailUrl(one.digest)).toBeUndefined();
    expect(await fileAttachmentStore(dataDir).get(one.digest)).toEqual(
      one.body,
    );
    // While down, every tick checks again, so recovery shows promptly.
    fake.mode = "up";
    clock = new Date(clock.getTime() + 30_000);
    await h.sync.tick();
    expect(await h.status()).toMatchObject({ reachable: true });
    expect(h.offsite.status().alerts).toEqual([]);
    expect(h.offsite.thumbnailUrl(one.digest)).toBeDefined();
  }
});
