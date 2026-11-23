import { afterEach, expect, test, vi } from "vitest";
import {
  ATTACHMENT_MAX_MIB_CEILING,
  attachmentLimits,
  formatAttachmentLimit,
  MAX_STORED_ATTACHMENT_BYTES,
  resolveAttachmentLimits,
} from "./attachment-limits.js";

const MIB = 1024 * 1024;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("unset or blank configuration keeps the 10 MiB default", () => {
  for (const value of [undefined, "", "  "])
    expect(
      resolveAttachmentLimits({ CARDIGAN_ATTACHMENT_MAX_MIB: value }),
    ).toEqual({
      mib: 10,
      bytes: 10 * MIB,
      base64: 4 * Math.ceil((10 * MIB) / 3),
      bodyBytes: 4 * Math.ceil((10 * MIB) / 3) + MIB,
    });
});

test("30 MiB configuration derives every dependent bound", () => {
  const limits = resolveAttachmentLimits({ CARDIGAN_ATTACHMENT_MAX_MIB: "30" });
  expect(limits).toEqual({
    mib: 30,
    bytes: 30 * MIB,
    base64: Buffer.alloc(30 * MIB).toString("base64").length,
    bodyBytes: Buffer.alloc(30 * MIB).toString("base64").length + MIB,
  });
  expect(formatAttachmentLimit(limits.bytes)).toBe("30 MiB");
});

test.each([
  "0",
  "-1",
  "1.5",
  "30MiB",
  "0x1e",
  "1e1",
  String(ATTACHMENT_MAX_MIB_CEILING + 1),
])("invalid configuration %s is refused with the variable name", (value) => {
  expect(() =>
    resolveAttachmentLimits({ CARDIGAN_ATTACHMENT_MAX_MIB: value }),
  ).toThrow(
    `CARDIGAN_ATTACHMENT_MAX_MIB must be an integer from 1 to ${ATTACHMENT_MAX_MIB_CEILING}`,
  );
});

test("stored reads stay bounded by the ceiling, not the current limit", () => {
  expect(attachmentLimits(ATTACHMENT_MAX_MIB_CEILING).bytes).toBe(
    MAX_STORED_ATTACHMENT_BYTES,
  );
  expect(attachmentLimits(1).bytes).toBeLessThan(MAX_STORED_ATTACHMENT_BYTES);
});

test("the host environment configures the process-wide limit and its errors", async () => {
  vi.stubEnv("CARDIGAN_ATTACHMENT_MAX_MIB", "30");
  vi.resetModules();
  const attachments = await import("./attachments.js");
  expect(attachments.MAX_ATTACHMENT_BYTES).toBe(30 * MIB);
  expect(attachments.MAX_ATTACHMENT_BASE64).toBe(4 * Math.ceil((30 * MIB) / 3));
  expect(attachments.MAX_MCP_BODY_BYTES).toBe(
    attachments.MAX_ATTACHMENT_BASE64 + MIB,
  );
  // 20 MiB was refused before C-616 and is accepted under a 30 MiB limit.
  const twenty = Buffer.alloc(20 * MIB, 7).toString("base64");
  expect(attachments.decodeAttachment(twenty).content.byteLength).toBe(
    20 * MIB,
  );
  expect(() =>
    attachments.decodeAttachment(Buffer.alloc(30 * MIB + 1).toString("base64")),
  ).toThrow("Attachment exceeds 30 MiB");
});

test("default process limit refuses one byte over 10 MiB and names the limit", async () => {
  vi.stubEnv("CARDIGAN_ATTACHMENT_MAX_MIB", "");
  vi.resetModules();
  const attachments = await import("./attachments.js");
  expect(attachments.MAX_ATTACHMENT_BYTES).toBe(10 * MIB);
  expect(() =>
    attachments.decodeAttachment(Buffer.alloc(10 * MIB + 1).toString("base64")),
  ).toThrow("Attachment exceeds 10 MiB");
});

test("an invalid host value fails at startup", async () => {
  vi.stubEnv("CARDIGAN_ATTACHMENT_MAX_MIB", "thirty");
  vi.resetModules();
  await expect(import("./attachments.js")).rejects.toThrow(
    "CARDIGAN_ATTACHMENT_MAX_MIB",
  );
});
