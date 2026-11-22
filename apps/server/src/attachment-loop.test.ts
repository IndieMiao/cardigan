import { randomUUID } from "node:crypto";
/**
 * Attachment blob GC (Phase 2 plan §7 leftover 1; development plan §9.3, §12.6).
 *
 * The sweep must never remove a blob that a project still records, a blob an
 * in-flight upload may own, or anything that is not a regular sha256 file.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, Delivery } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { Store as SqliteStore } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { sweepArtifacts } from "./artifact-retention.js";
import {
  ATTACHMENT_GC_GRACE_MS,
  AttachmentGc,
  startAttachmentLoop,
} from "./attachment-loop.js";

const NOW = Date.parse("2026-02-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const clock = { now: () => new Date(NOW).toISOString() };
const digest = (seed: string) => seed.repeat(64).slice(0, 64);

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-attachment-gc-"));
  const store = SqliteStore.open({ dataDir });
  const project = store.createProject({
    id: "p-1" as never,
    name: "attachments",
  });
  if (!project.ok) throw new Error(project.error.message);
  const directory = join(dataDir, "attachments");
  mkdirSync(directory, { recursive: true });
  cleanups.push(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, directory };
}

/** Write a blob whose mtime is `ageMs` before the sweep's clock. */
function blob(directory: string, name: string, ageMs: number): string {
  const path = join(directory, name);
  writeFileSync(path, `content of ${name}`);
  const at = new Date(NOW - ageMs);
  utimesSync(path, at, at);
  return path;
}

function record(store: Store, id: string, sha256: string): void {
  store.uow.run((tx) =>
    tx.attachments.put("p-1" as never, {
      id: id as never,
      sha256,
      mime: "text/plain",
      size: 12,
      card_id: "C-1" as never,
      uploaded_by: "human",
      storage_path: `attachments/${sha256}`,
      attach_to: { kind: "timeline_entry", id: "C-1#1" as never },
      kind: "evidence",
    }),
  );
}

const sweep = (options: {
  dataDir: string;
  store: Pick<Store, "listProjects" | "uow">;
}) => new AttachmentGc({ ...options, clock }).tick();

test("keeps blobs that a project still references", async () => {
  const f = fixture();
  const kept = digest("a");
  const path = blob(f.directory, kept, 30 * DAY);
  record(f.store, "F-1", kept);
  const result = await sweep(f);
  expect(result.deleted).toEqual([]);
  expect(existsSync(path)).toBe(true);
});

test("keeps unreferenced blobs younger than the 24 hour grace period", async () => {
  const f = fixture();
  const fresh = blob(f.directory, digest("b"), 60 * 60 * 1000);
  const justInside = blob(
    f.directory,
    digest("c"),
    ATTACHMENT_GC_GRACE_MS - 1000,
  );
  const result = await sweep(f);
  expect(result.deleted).toEqual([]);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(justInside)).toBe(true);
});

test("skips symlinks, directories and names that are not a sha256", async () => {
  const f = fixture();
  const target = blob(f.directory, "target.bin", 30 * DAY);
  const link = join(f.directory, digest("d"));
  symlinkSync(target, link);
  const directory = join(f.directory, digest("e"));
  mkdirSync(directory);
  writeFileSync(join(directory, "inside"), "keep");
  const notes = blob(f.directory, "notes.txt", 30 * DAY);
  const temporary = blob(f.directory, `.${"f".repeat(36)}.tmp`, 30 * DAY);
  const uppercase = blob(f.directory, "A".repeat(64), 30 * DAY);
  const result = await sweep(f);
  expect(result.deleted).toEqual([]);
  for (const path of [target, link, directory, notes, temporary, uppercase])
    expect(existsSync(path)).toBe(true);
});

test("removes an unreferenced blob once it is older than the grace period", async () => {
  const f = fixture();
  const orphan = digest("1");
  const path = blob(f.directory, orphan, 2 * DAY);
  const messages: string[] = [];
  const result = await new AttachmentGc({
    ...f,
    clock,
    report: (message) => messages.push(message),
  }).tick();
  expect(result.deleted).toEqual([orphan]);
  expect(result.candidates).toBe(1);
  expect(existsSync(path)).toBe(false);
  // Logs carry the count and an eight-character prefix, never the whole digest.
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("removed 1 orphaned blob");
  expect(messages[0]).toContain(orphan.slice(0, 8));
  expect(messages[0]).not.toContain(orphan);
});

test("an upload that records the blob before the delete wins", async () => {
  const f = fixture();
  const rescued = digest("2");
  const path = blob(f.directory, rescued, 2 * DAY);
  let hooked = false;
  // First write transaction is the deletion: an upload commits its record then.
  const store: Pick<Store, "listProjects" | "uow"> = {
    listProjects: () => f.store.listProjects(),
    uow: {
      read: (operation) => f.store.uow.read(operation),
      run: async (operation) => {
        if (!hooked) {
          hooked = true;
          record(f.store, "F-late", rescued);
        }
        return f.store.uow.run(operation);
      },
    } as Store["uow"],
  };
  const result = await sweep({ dataDir: f.dataDir, store });
  expect(hooked).toBe(true);
  expect(result.deleted).toEqual([]);
  expect(existsSync(path)).toBe(true);
});

test("a reuse upload between selection and deletion refreshes the grace period", async () => {
  const f = fixture();
  const reused = digest("9");
  const path = blob(f.directory, reused, 2 * DAY);
  let hooked = false;
  const store: Pick<Store, "listProjects" | "uow"> = {
    listProjects: () => f.store.listProjects(),
    uow: {
      read: (operation) => f.store.uow.read(operation),
      run: async (operation) => {
        if (!hooked) {
          hooked = true;
          // Exactly what `put()` does when it reuses an existing blob: refresh
          // the mtime (packages/mcp-server/src/attachments.test.ts covers that)
          // and then record the attachment.
          const fresh = new Date(NOW);
          utimesSync(path, fresh, fresh);
        }
        return f.store.uow.run(operation);
      },
    } as Store["uow"],
  };
  const result = await sweep({ dataDir: f.dataDir, store });
  expect(hooked).toBe(true);
  // The blob was a candidate, but the reuse made it young again before the
  // deletion transaction re-read its age.
  expect(result.candidates).toBe(1);
  expect(result.deleted).toEqual([]);
  expect(existsSync(path)).toBe(true);
});

test("limits one round and leaves the rest for the next sweep", async () => {
  const f = fixture();
  const first = blob(f.directory, digest("3"), 5 * DAY);
  const second = blob(f.directory, digest("4"), 4 * DAY);
  const third = blob(f.directory, digest("5"), 3 * DAY);
  const gc = new AttachmentGc({ ...f, clock, limit: 2 });
  const round = await gc.tick();
  expect(round.deleted).toEqual([digest("3"), digest("4")]);
  expect(round.truncated).toBe(true);
  expect(existsSync(first)).toBe(false);
  expect(existsSync(second)).toBe(false);
  expect(existsSync(third)).toBe(true);
  const next = await gc.tick();
  expect(next.deleted).toEqual([digest("5")]);
  expect(existsSync(third)).toBe(false);
});

test("a missing attachments directory is not an error", async () => {
  const f = fixture();
  rmSync(f.directory, { recursive: true, force: true });
  await expect(sweep(f)).resolves.toMatchObject({ scanned: 0, deleted: [] });
});

test("the loop can be stopped and never sweeps again", async () => {
  const f = fixture();
  const orphan = blob(f.directory, digest("6"), 3 * DAY);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { loop } = startAttachmentLoop({ ...f, clock, intervalMs: 5 });
  // The loop starts its first tick immediately; stop must drain it.
  await loop.stop();
  await loop.done;
  expect(existsSync(orphan)).toBe(false);
  // A blob created after the stop stays: no tick may run again.
  const late = blob(f.directory, digest("7"), 3 * DAY);
  await vi.advanceTimersByTimeAsync(40);
  expect(existsSync(late)).toBe(true);
  await loop.stop(); // idempotent
});

test("stores the blob bytes and never rewrites referenced files", async () => {
  const f = fixture();
  const referenced = digest("8");
  const path = blob(f.directory, referenced, 10 * DAY);
  record(f.store, "F-8", referenced);
  const before = readFileSync(path, "utf8");
  await sweep(f);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test.each(["artifact", "evidence"] as const)(
  "%s retention pins incoming delivery and decision references but not a creation basis",
  async (kind) => {
    const f = fixture(),
      project = "p-1",
      directory = join(f.dataDir, "artifacts");
    mkdirSync(directory);
    const paths: string[] = [];
    for (let n = 1; n <= 6; n++) {
      const blob_id = randomUUID(),
        age = n < 4 ? 40 : 7 - n;
      record(f.store, `F-${n}`, String(n).repeat(64));
      paths.push(blob(directory, blob_id, age * DAY));
      f.store.uow.run((tx) => {
        const a = tx.attachments.get(project, `F-${n}`);
        if (!a) throw Error("Missing attachment");
        tx.attachments.put(project, {
          ...a,
          kind,
          basis: "Q-2" as Decision["id"],
          size: 10,
          storage_path: `artifacts/${blob_id}`,
          streamed_artifact: {
            blob_id,
            run_id: "R-1" as never,
            created_at: new Date(NOW - age * DAY).toISOString(),
          },
        });
      });
    }
    f.store.uow.run((tx) => {
      tx.deliveries.put(project, {
        id: "D-1",
        work_item_id: "W-1",
        subject: { kind: "artifact_sha256", value: "2".repeat(64) },
        attachments: ["F-1"],
      } as Delivery);
      tx.decisions.put(project, {
        id: "Q-1",
        kind: "choose",
        attachment_ids: ["F-3"],
      } as Decision);
      // Q-2 authorized creating all six packages. It does not reference any.
      tx.decisions.put(project, {
        id: "Q-2",
        key: "Q-2",
        kind: "choose",
        attachment_ids: [],
      } as unknown as Decision);
    });
    const config = join(f.dataDir, "artifact-retention.json");
    writeFileSync(config, '{"p-1":{"days":-1,"max_bytes":2}}');
    await expect(
      sweepArtifacts(f.store, f.dataDir, clock.now()),
    ).rejects.toThrow();
    expect(paths.every((path) => existsSync(path))).toBe(true);
    writeFileSync(config, '{"p-1":{"days":2,"max_bytes":40}}');
    await sweepArtifacts(f.store, f.dataDir, clock.now());
    expect(paths.map((path) => existsSync(path))).toEqual([
      true,
      true,
      true,
      false,
      false,
      true,
    ]);
    const row = (id: string) =>
      f.store.uow.read(
        (tx) => tx.attachments.get(project, id)?.streamed_artifact,
      );
    expect(row("F-4")?.expired).toEqual({ at: clock.now(), reason: "age" });
    writeFileSync(config, '{"p-1":{"days":30,"max_bytes":1}}');
    await sweepArtifacts(f.store, f.dataDir, clock.now());
    expect(row("F-6")?.expired).toEqual({
      at: clock.now(),
      reason: "capacity",
    });
    expect(paths.slice(0, 3).every((path) => existsSync(path))).toBe(true);
  },
);

test("bounds scan work, resumes past young blobs, and honors a reference added between pages", async () => {
  const f = fixture();
  for (let i = 0; i < 260; i++)
    blob(f.directory, i.toString(16).padStart(64, "0"), 30 * DAY);
  const gc = new AttachmentGc({ ...f, clock });
  const first = await gc.tick();
  expect(first.scanned).toBeLessThanOrEqual(128);
  expect(gc.pending).toBe(true);
  const kept = Array.from({ length: 260 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  ).find((d) => existsSync(join(f.directory, d)));
  if (!kept) throw Error("missing next page");
  record(f.store, "F-1", kept);
  while (gc.pending) expect((await gc.tick()).scanned).toBeLessThanOrEqual(128);
  expect(existsSync(join(f.directory, kept))).toBe(true);
});
