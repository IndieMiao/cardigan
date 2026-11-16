import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MAX_ATTACHMENT_BYTES, sha256 } from "./attachments.js";
import { downloadAttachment } from "./download-attachment.js";

let directory: string;
let servers: Server[];
const credential = "synthetic-download-credential";
const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
const cli = fileURLToPath(
  new URL("../dist/download-attachment.js", import.meta.url),
);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cardigan-download-"));
  servers = [];
});
afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await rm(directory, { recursive: true, force: true });
});
async function fixture(
  patch: {
    status?: number;
    headers?: Record<string, string>;
    body?: Buffer;
  } = {},
) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    expect(req.headers.authorization).toBe(`Bearer ${credential}`);
    res.writeHead(patch.status ?? 200, {
      "content-length": bytes.length,
      "x-attachment-id": "F-1",
      "x-attachment-sha256": sha256(bytes),
      ...patch.headers,
    });
    res.end(patch.body ?? bytes);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    requests,
  };
}

test("CLI inherits its credential and saves verified binary bytes without printing them", async () => {
  const f = await fixture();
  const file = join(directory, "image.png");
  const result = await promisify(execFile)(
    process.execPath,
    [cli, f.url, "F-1", file],
    { env: { ...process.env, MCP_TOKEN: credential } },
  );
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    attachment_id: "F-1",
    size: bytes.length,
    sha256: sha256(bytes),
  });
  expect(result.stdout).not.toContain(credential);
  expect(result.stdout).not.toContain(bytes.toString("base64"));
  expect(await readFile(file)).toEqual(bytes);
  expect(f.requests).toEqual(["/mcp?attachment_id=F-1"]);
});

test.each([301, 302, 303, 307, 308])(
  "never follows a %i redirect with a session credential",
  async (status) => {
    const f = await fixture({ status, headers: { location: "/elsewhere" } });
    await expect(
      downloadAttachment(f.url, "F-1", join(directory, "new"), credential),
    ).rejects.toThrow("[download]");
    expect(f.requests).toEqual(["/mcp?attachment_id=F-1"]);
  },
);

test.each([
  { headers: { "x-attachment-id": "F-2" } },
  { headers: { "x-attachment-sha256": "0".repeat(64) } },
  { headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1) } },
  { headers: { "x-attachment-sha256": "invalid" } },
  { body: Buffer.alloc(bytes.length) },
])("refuses invalid identity, size and digest: %j", async (patch) => {
  const f = await fixture(patch);
  const file = join(directory, "unverified");
  await expect(
    downloadAttachment(f.url, "F-1", file, credential),
  ).rejects.toThrow("[integrity]");
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test("CLI reports safe failures without reflecting server text, credential or file path", async () => {
  const privateText = Buffer.from(`${credential} /private/fixture/blob`);
  const f = await fixture({
    status: 403,
    body: privateText,
    headers: { "content-length": String(privateText.length) },
  });
  const result = await promisify(execFile)(
    process.execPath,
    [cli, f.url, "F-1", join(directory, "unused")],
    { env: { ...process.env, MCP_TOKEN: credential } },
  ).catch((error: { stdout: string; stderr: string }) => error);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("[download]");
  expect(result.stderr).not.toContain(credential);
  expect(result.stderr).not.toContain("/private");
  expect(result.stderr).not.toContain(directory);
});

test("rejects missing credentials and unsafe URLs before making requests", async () => {
  const f = await fixture();
  for (const endpoint of [
    "file:///fixture",
    "http://user:password@localhost/mcp",
    `${f.url}?extra=1`,
    `${f.url}#fragment`,
  ]) {
    await expect(
      downloadAttachment(endpoint, "F-1", "unused", credential),
    ).rejects.toThrow("[endpoint]");
  }
  await expect(downloadAttachment(f.url, "F-1", "unused", "")).rejects.toThrow(
    "[credential]",
  );
  expect(f.requests).toEqual([]);
});

test("never overwrites existing files or follows a destination symlink", async () => {
  const f = await fixture();
  const target = join(directory, "existing");
  const link = join(directory, "link");
  await writeFile(target, "keep");
  await symlink(target, link);
  for (const file of [target, link]) {
    await expect(
      downloadAttachment(f.url, "F-1", file, credential),
    ).rejects.toThrow("[file]");
    expect(await readFile(target, "utf8")).toBe("keep");
  }
});
