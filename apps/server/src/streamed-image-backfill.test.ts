/** C-819: streamed images from before C-809 get the upload's image verdict. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment, CardId, TimelineEntry } from "@cardigan/domain";
import sharp from "sharp";
import { afterEach, expect, test } from "vitest";
import { call, type WebHarness, webHarness } from "../test-support/web.js";
import { project_id, seedWebProject } from "../test-support/web-data.js";
import { backfillStreamedInlineImages } from "./streamed-image-backfill.js";

const PASSWORD = "streamed-backfill-test-password";
let h: WebHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
}, 30_000);

type Stream = NonNullable<Attachment["streamed_artifact"]>;

test("C-819: old streamed images are marked by their header once; mismatches stay downloads", async () => {
  h = await webHarness({ password: PASSWORD });
  const harness = h;
  seedWebProject(h.store, h.dataDir);
  await mkdir(join(h.dataDir, "artifacts"), { recursive: true });
  const png = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "#f00" },
  })
    .png()
    .toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  const blobs = new Map<string, string>();
  const streamed = async (
    id: string,
    mime: string,
    body: Buffer,
    extra: Partial<Stream> = {},
    onDisk = true,
  ) => {
    const blob_id = randomUUID();
    blobs.set(id, blob_id);
    if (onDisk)
      await writeFile(join(harness.dataDir, "artifacts", blob_id), body);
    harness.store.uow.run((tx) =>
      tx.attachments.put(project_id, {
        id: id as Attachment["id"],
        sha256: createHash("sha256").update(body).digest("hex"),
        mime,
        size: body.byteLength,
        card_id: "C-1" as CardId,
        uploaded_by: "assignment:A-1",
        storage_path: `artifacts/${blob_id}`,
        attach_to: {
          kind: "timeline_entry",
          id: "C-1#1" as TimelineEntry["id"],
        },
        kind: "evidence",
        streamed_artifact: {
          blob_id,
          run_id: "R-1" as never,
          created_at: "2026-11-27T04:03:00.000Z" as never,
          ...extra,
        },
      }),
    );
  };
  // Uploaded before C-809: no verdict yet.
  await streamed("S-1", "image/png", png);
  await streamed("S-2", "IMAGE/JPEG", jpeg);
  // Declared type and bytes disagree, or the bytes are no bitmap at all.
  await streamed("S-3", "image/png", jpeg);
  await streamed("S-4", "image/webp", Buffer.from("<svg/>"));
  await streamed("S-5", "image/gif", Buffer.alloc(0));
  // Not on this host.
  await streamed("S-6", "image/png", png, {}, false);
  // Out of scope: expired, not an inline type, already decided.
  await streamed("S-7", "image/png", png, {
    expired: { at: "2026-11-27T05:00:00.000Z" as never, reason: "age" },
  });
  await streamed("S-8", "image/svg+xml", Buffer.from("<svg/>"));
  await streamed("S-9", "application/pdf", png);
  await streamed("S-10", "image/png", jpeg, { inline_image: true });
  h.store.uow.run((tx) => {
    const q = tx.decisions.get(project_id, "D-1" as never);
    if (!q) throw new Error("Missing seeded decision");
    tx.decisions.put(project_id, {
      ...q,
      attachment_ids: ["S-1", "S-3"] as Attachment["id"][],
    });
  });
  const before = h.store.uow.read((tx) => tx.attachments.list(project_id));

  expect(await backfillStreamedInlineImages(h.store, h.dataDir)).toEqual({
    inline: 2,
    download: 3,
    skipped: 1,
  });
  const verdicts = () =>
    Object.fromEntries(
      harness.store.uow
        .read((tx) => tx.attachments.list(project_id))
        .filter((a) => a.id.startsWith("S-"))
        .map((a) => [a.id, a.streamed_artifact?.inline_image]),
    );
  const marked = {
    "S-1": true,
    "S-2": true,
    "S-3": false,
    "S-4": false,
    "S-5": false,
    "S-6": undefined,
    "S-7": undefined,
    "S-8": undefined,
    "S-9": undefined,
    "S-10": true,
  };
  expect(verdicts()).toEqual(marked);
  // Nothing else on a record changes.
  const after = h.store.uow.read((tx) => tx.attachments.list(project_id));
  const withoutVerdict = (a: Attachment | undefined) => {
    if (!a?.streamed_artifact) return a;
    const { inline_image: _verdict, ...stream } = a.streamed_artifact;
    return { ...a, streamed_artifact: stream };
  };
  expect(after.map(withoutVerdict)).toEqual(before.map(withoutVerdict));

  // Repeating is harmless: only the missing file is looked at again.
  expect(await backfillStreamedInlineImages(h.store, h.dataDir)).toEqual({
    inline: 0,
    download: 0,
    skipped: 1,
  });
  expect(verdicts()).toEqual(marked);

  // The pages: S-1 and S-2 now render like ordinary images everywhere; the
  // mismatched S-3 and S-4 stay downloads.
  const cookie = await h.login(PASSWORD);
  const at = (suffix: string) => `/api/projects/${project_id}${suffix}`;
  type View = { id: string; inline: boolean; thumbnail_path: string | null };
  const shown = (views: readonly View[]) =>
    Object.fromEntries(
      views
        .filter((v) => ["S-1", "S-2", "S-3", "S-4"].includes(v.id))
        .map((v) => [v.id, [v.inline, v.thumbnail_path]]),
    );
  const detail = (await call(h.port, at("/cards/C-1"), { cookie })).json as {
    attachments: View[];
    decisions: { id: string; attachments: View[] }[];
  };
  expect(shown(detail.attachments)).toEqual({
    "S-1": [true, at("/attachments/S-1/thumbnail")],
    "S-2": [true, at("/attachments/S-2/thumbnail")],
    "S-3": [false, null],
    "S-4": [false, null],
  });
  expect(
    shown(detail.decisions.find((q) => q.id === "D-1")?.attachments ?? []),
  ).toEqual({
    "S-1": [true, at("/attachments/S-1/thumbnail")],
    "S-3": [false, null],
  });
  const thumbnail = await call(h.port, at("/attachments/S-1/thumbnail"), {
    cookie,
  });
  expect(thumbnail.status).toBe(200);
  for (const id of ["S-3", "S-4"]) {
    const file = await call(h.port, at(`/attachments/${id}`), { cookie });
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/octet-stream");
    expect(String(file.headers["content-disposition"])).toMatch(/^attachment/);
    expect(
      (await call(h.port, at(`/attachments/${id}/thumbnail`), { cookie }))
        .status,
    ).toBe(404);
  }

  // Once the missing file is back on the host, the next pass marks it.
  await writeFile(
    join(h.dataDir, "artifacts", blobs.get("S-6") ?? "absent"),
    png,
  );
  expect(await backfillStreamedInlineImages(h.store, h.dataDir)).toEqual({
    inline: 1,
    download: 0,
    skipped: 0,
  });
  expect(verdicts()["S-6"]).toBe(true);
});

test("C-819: a file of the wrong size or a symlink is skipped, not judged", async () => {
  h = await webHarness({ password: PASSWORD });
  const harness = h;
  seedWebProject(h.store, h.dataDir);
  const artifacts = join(h.dataDir, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const body = Buffer.from("\x89PNG\r\n\x1a\nrest-of-file", "latin1");
  const put = (id: string, blob_id: string, size: number) =>
    harness.store.uow.run((tx) =>
      tx.attachments.put(project_id, {
        id: id as Attachment["id"],
        sha256: "0".repeat(64),
        mime: "image/png",
        size,
        card_id: "C-1" as CardId,
        uploaded_by: "assignment:A-1",
        storage_path: `artifacts/${blob_id}`,
        attach_to: {
          kind: "timeline_entry",
          id: "C-1#1" as TimelineEntry["id"],
        },
        kind: "evidence",
        streamed_artifact: {
          blob_id,
          run_id: "R-1" as never,
          created_at: "2026-11-27T04:03:00.000Z" as never,
        },
      }),
    );
  const truncated = randomUUID();
  await writeFile(join(artifacts, truncated), body);
  put("S-1", truncated, body.byteLength + 1);
  const target = randomUUID(),
    link = randomUUID();
  await writeFile(join(artifacts, target), body);
  await symlink(join(artifacts, target), join(artifacts, link));
  put("S-2", link, body.byteLength);
  put("S-3", "not-a-blob-id", body.byteLength);

  expect(await backfillStreamedInlineImages(h.store, h.dataDir)).toEqual({
    inline: 0,
    download: 0,
    skipped: 3,
  });
  await rm(join(artifacts, link));
  expect(
    h.store.uow
      .read((tx) => tx.attachments.list(project_id))
      .filter((a) => a.id.startsWith("S-"))
      .map((a) => a.streamed_artifact?.inline_image),
  ).toEqual([undefined, undefined, undefined]);
});
