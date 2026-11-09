import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ATTACHMENT_EXTENSIONS,
  attachmentMimeForExtension,
  fileAttachmentStore,
  MAX_ATTACHMENT_BYTES,
  prepareAttachmentFile,
  sha256,
} from "./attachments.js";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cardigan-human-attachments-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("human uploads use the Workbench download types and common aliases", () => {
  for (const [mime, extension] of Object.entries(ATTACHMENT_EXTENSIONS)) {
    expect(attachmentMimeForExtension(`.${extension.toUpperCase()}`)).toBe(
      mime,
    );
  }
  for (const [extension, mime] of [
    ["jpeg", "image/jpeg"],
    ["htm", "text/html"],
    ["markdown", "text/markdown"],
    ["log", "text/plain"],
  ])
    expect(attachmentMimeForExtension(extension as string)).toBe(mime);
  for (const extension of ["", ".exe", ".zip", ".unknown"])
    expect(attachmentMimeForExtension(extension)).toBeUndefined();
});

test("shared preflight validates hashes and detects corrupt existing blobs", async () => {
  const content = Buffer.from("human evidence");
  const file = content.toString("base64"),
    digest = sha256(content);
  await expect(
    prepareAttachmentFile(file, dataDir, "0".repeat(64)),
  ).rejects.toThrow("sha256");
  expect(await prepareAttachmentFile(file, dataDir, digest)).toMatchObject({
    sha256: digest,
    size: content.length,
    storage_path: `attachments/${digest}`,
  });
  expect(await fileAttachmentStore(dataDir).get(digest)).toEqual(content);
  await writeFile(join(dataDir, "attachments", digest), "corrupt");
  await expect(prepareAttachmentFile(file, dataDir)).rejects.toThrow(
    "storage failed",
  );
});

test("shared preflight enforces canonical base64 and the inclusive 10 MiB limit", async () => {
  await expect(prepareAttachmentFile("bad-base64!", dataDir)).rejects.toThrow(
    "base64",
  );
  const content = Buffer.alloc(MAX_ATTACHMENT_BYTES);
  expect(
    await prepareAttachmentFile(content.toString("base64"), dataDir),
  ).toMatchObject({ size: MAX_ATTACHMENT_BYTES });
  await expect(
    prepareAttachmentFile(
      Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"),
      dataDir,
    ),
  ).rejects.toThrow("10 MiB");
});
