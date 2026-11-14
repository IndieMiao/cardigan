import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "./attachments.js";
import {
  uploadEvidenceFile,
  uploadEvidenceSession,
} from "./upload-evidence.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cardigan-evidence-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const input = (file: string) => ({
  file,
  card_id: "C-1",
  delivery_id: "D-1",
  mime: "image/png",
});

test.each([68, 400 * 1024, MAX_ATTACHMENT_BYTES])(
  "automatically encodes %i bytes with their full digest; paths stay local",
  async (size) => {
    const file = join(directory, "screenshot.png");
    const bytes = Buffer.alloc(size, 0xa7);
    await writeFile(file, bytes);
    const client = new Client({ name: "fixture", version: "1" });
    const digest = createHash("sha256").update(bytes).digest("hex");
    const call = vi.spyOn(client, "callTool").mockResolvedValue({
      content: [],
      structuredContent: {
        id: "attachment-1",
        card_id: "C-1",
        sha256: digest,
        size,
      },
    });
    expect(await uploadEvidenceFile(client, input(file))).toBe("attachment-1");
    const request = call.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      name: "upload_attachment",
      arguments: {
        card_id: "C-1",
        sha256: digest,
        file: bytes.toString("base64"),
        original_filename: "screenshot.png",
        kind: "evidence",
        attach_to: { kind: "delivery", id: "D-1" },
      },
    });
    expect(JSON.stringify(request)).not.toContain(directory);
  },
);

test("rejects missing, symlink, directory and oversized files before making a request", async () => {
  const client = new Client({ name: "fixture", version: "1" });
  const call = vi.spyOn(client, "callTool");
  await writeFile(join(directory, "source"), "fixture");
  await symlink(join(directory, "source"), join(directory, "link"));
  await mkdir(join(directory, "folder"));
  const oversized = await open(join(directory, "oversized"), "w");
  await oversized.truncate(MAX_ATTACHMENT_BYTES + 1);
  await oversized.close();
  for (const name of ["missing", "link", "folder", "oversized"])
    await expect(
      uploadEvidenceFile(client, input(join(directory, name))),
    ).rejects.toThrow("regular file up to 10 MiB");
  expect(call).not.toHaveBeenCalled();
});

test("does not accept rejected, incomplete or mismatched upload receipts", async () => {
  const file = join(directory, "screenshot.png");
  await writeFile(file, "fixture");
  const client = new Client({ name: "fixture", version: "1" });
  const call = vi.spyOn(client, "callTool");
  for (const response of [
    { isError: true, structuredContent: { error: { code: "unauthorized" } } },
    {
      structuredContent: {
        id: "attachment-1",
        sha256: "incorrect",
        size: 7,
        card_id: "C-1",
      },
    },
    {
      structuredContent: {
        id: "attachment-1",
        sha256: createHash("sha256").update("fixture").digest("hex"),
        size: 7,
        card_id: "C-2",
      },
    },
    {},
  ]) {
    call.mockResolvedValueOnce({ content: [], ...response });
    await expect(uploadEvidenceFile(client, input(file))).rejects.toThrow();
  }
});

test("requires a session credential and refuses credential-bearing or non-HTTP URLs", async () => {
  const connect = vi.spyOn(Client.prototype, "connect");
  try {
    await expect(
      uploadEvidenceSession("http://localhost/mcp", input("unused"), ""),
    ).rejects.toThrow("session credential");
    for (const url of ["file:///unused", "https://user:password@localhost/mcp"])
      await expect(
        uploadEvidenceSession(url, input("unused"), "fixture-token"),
      ).rejects.toThrow("Invalid Card MCP URL");
    expect(connect).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore();
  }
});
