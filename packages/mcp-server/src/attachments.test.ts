import {
  mkdir,
  mkdtemp,
  open,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
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

test("reusing an existing blob refreshes its mtime so the sweep keeps it", async () => {
  const content = Buffer.from("shared evidence"),
    digest = sha256(content),
    blobs = fileAttachmentStore(dataDir);
  const path = join(dataDir, "attachments", digest);
  expect(await blobs.put(digest, content)).toMatchObject({
    storage_path: `attachments/${digest}`,
  });
  const stale = new Date(Date.now() - 72 * 60 * 60 * 1000);
  await utimes(path, stale, stale);
  // A second upload of the same bytes reuses the file and must refresh its age.
  expect(await blobs.put(digest, content)).toMatchObject({
    storage_path: `attachments/${digest}`,
  });
  const touched = (await stat(path)).mtimeMs;
  expect(touched).toBeGreaterThan(stale.getTime() + 60 * 60 * 1000);
  expect(await blobs.get(digest)).toEqual(content);
});

test("blob reads reject oversized sparse files, symlinks and directories", async () => {
  const content = Buffer.from("private bytes");
  const digest = sha256(content),
    blobs = fileAttachmentStore(dataDir);
  const target = join(dataDir, "attachments", digest);
  await blobs.put(digest, content);
  const sparse = await open(target, "w");
  await sparse.truncate(1024 * 1024 * 1024);
  await sparse.close();
  await expect(blobs.get(digest)).rejects.toThrow("64 MiB");
  await rm(target);
  const outside = join(dataDir, "outside");
  await writeFile(outside, content);
  await symlink(outside, target);
  await expect(blobs.get(digest)).rejects.toThrow("could not be read");
  await rm(target);
  await mkdir(target);
  await expect(blobs.get(digest)).rejects.toThrow("must be a file");
});
