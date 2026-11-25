/** C-614: Workbench images may come from OSS; the local path always remains. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, CardId, TimelineEntry } from "@cardigan/domain";
import { attachmentKey, Offsite, registerOffsite } from "@cardigan/mcp-server";
import sharp from "sharp";
import { afterEach, expect, test } from "vitest";
import {
  type FakeOss,
  startFakeOss,
  writeStorageConfig,
} from "../../../../packages/mcp-server/test-support/fake-oss.js";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import { redirectToOffsite } from "./thumbnails.js";

const PASSWORD = "offsite-test-password";
let h: WebHarness | undefined, fake: FakeOss | undefined, root: string;
let unregister: (() => void) | undefined;
afterEach(async () => {
  unregister?.();
  await h?.close();
  await fake?.close();
  if (root) await rm(root, { recursive: true, force: true });
  h = fake = unregister = undefined;
}, 30_000);

async function setup(configured: boolean) {
  h = await webHarness({ password: PASSWORD });
  seedWebProject(h.store, h.dataDir);
  root = await mkdtemp(join(tmpdir(), "cardigan-web-offsite-"));
  fake = await startFakeOss();
  const offsite = new Offsite({
    dataDir: h.dataDir,
    storageDir: configured
      ? await writeStorageConfig(root, fake)
      : join(root, "storage"),
    role: "web",
  });
  unregister = registerOffsite(offsite);
  const png = await sharp({
    create: { width: 640, height: 200, channels: 3, background: "#f00" },
  })
    .png()
    .toBuffer();
  const sha = createHash("sha256").update(png).digest("hex");
  await mkdir(join(h.dataDir, "attachments"), { recursive: true });
  await writeFile(join(h.dataDir, "attachments", sha), png);
  h.store.uow.run((tx) =>
    tx.attachments.put(project_id, {
      id: "F-9" as Attachment["id"],
      sha256: sha,
      mime: "image/png",
      size: png.byteLength,
      card_id: "C-1" as CardId,
      uploaded_by: "assignment:A-1",
      storage_path: `attachments/${sha}`,
      attach_to: { kind: "timeline_entry", id: "C-1#1" as TimelineEntry["id"] },
      kind: "evidence",
    }),
  );
  if (configured) {
    fake.objects.set(attachmentKey(sha), { body: png, sha256: sha });
    offsite.ledger.record({
      key: attachmentKey(sha),
      sha256: sha,
      size: png.length,
      at: new Date().toISOString(),
    });
  }
  const cookie = await h.login(PASSWORD);
  return { cookie, png, offsite };
}
const at = (suffix: string) => `/api/projects/${project_id}${suffix}`;

test("thumbnails and previews redirect to a signed OSS URL; ?local=1 stays local", async () => {
  const { cookie, png } = await setup(true);
  const thumb = await call(h?.port ?? 0, at("/attachments/F-9/thumbnail"), {
    cookie,
  });
  expect(thumb.status).toBe(302);
  const location = new URL(String(thumb.headers.location));
  expect(location.origin).toBe(fake?.endpoint);
  expect(location.searchParams.get("x-oss-process")).toContain("format,webp");
  // The page may load images from the bucket and (C-685) send shared-library
  // uploads to it; nothing else.
  const csp = String(thumb.headers["content-security-policy"]);
  expect(csp).toContain("sandbox");
  const page = await call(h?.port ?? 0, "/api/session", {});
  expect(String(page.headers["content-security-policy"])).toContain(
    `img-src 'self' data: blob: ${fake?.endpoint}`,
  );
  expect(String(page.headers["content-security-policy"])).toContain(
    `connect-src 'self' ${fake?.endpoint};`,
  );
  expect((await fetch(location)).status).toBe(200);

  const local = await call(
    h?.port ?? 0,
    at("/attachments/F-9/thumbnail?local=1"),
    { cookie },
  );
  expect(local.status).toBe(200);
  expect(local.headers["content-type"]).toBe("image/webp");

  const preview = await call(h?.port ?? 0, at("/attachments/F-9/preview"), {
    cookie,
  });
  expect(preview.status).toBe(302);
  expect(
    new URL(String(preview.headers.location)).searchParams.get(
      "response-content-type",
    ),
  ).toBe("image/png");
  const original = await call(
    h?.port ?? 0,
    at("/attachments/F-9/preview?local=1"),
    { cookie },
  );
  expect(original.status).toBe(200);
  expect(original.bytes.equals(png)).toBe(true);
  // Downloads always serve the original from the control host.
  const download = await call(h?.port ?? 0, at("/attachments/F-9"), {
    cookie,
  });
  expect(download.status).toBe(200);
  expect(download.bytes.equals(png)).toBe(true);
  // Same session check as every other attachment route.
  expect(
    (await call(h?.port ?? 0, at("/attachments/F-9/preview"))).status,
  ).toBe(401);
  // SVG and other non-bitmaps have no preview route.
  expect(
    (await call(h?.port ?? 0, at("/attachments/F-3/preview"), { cookie }))
      .status,
  ).toBe(404);

  const status = await call(h?.port ?? 0, "/api/offsite", { cookie });
  expect(status.status).toBe(200);
  expect(status.json).toMatchObject({
    configured: "ready",
    synced: { count: 1 },
    usage: { budget_yuan: 50 },
  });
  expect(JSON.stringify(status.json)).not.toContain("fixture-secret");
  expect((await call(h?.port ?? 0, "/api/offsite")).status).toBe(401);
});

test("without OSS every image is served locally and the CSP is unchanged", async () => {
  const { cookie } = await setup(false);
  const thumb = await call(h?.port ?? 0, at("/attachments/F-9/thumbnail"), {
    cookie,
  });
  expect(thumb.status).toBe(200);
  const preview = await call(h?.port ?? 0, at("/attachments/F-9/preview"), {
    cookie,
  });
  expect(preview.status).toBe(200);
  expect(preview.headers["content-type"]).toBe("image/png");
  expect(String(thumb.headers["content-security-policy"])).not.toContain(
    "127.0.0.1",
  );
  expect(
    (await call(h?.port ?? 0, "/api/offsite", { cookie })).json,
  ).toMatchObject({ configured: "absent", alerts: [] });
  expect(fake?.requests).toEqual([]);
});

test("a redirect is never cached past the end of its signature", () => {
  const sent: unknown[] = [];
  const res = {
    writeHead: (_status: number, headers: Record<string, unknown>) => {
      sent.push(headers["Cache-Control"]);
      return res;
    },
    end: () => res,
  } as unknown as ServerResponse;
  for (const seconds of [600, 120, 60, 20])
    redirectToOffsite(res, {
      url: "https://bucket.invalid/x",
      valid_for_seconds: seconds,
    });
  expect(sent).toEqual([
    "private, max-age=240",
    "private, max-age=90",
    "private, max-age=30",
    "no-store",
  ]);
});
