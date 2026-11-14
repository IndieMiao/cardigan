import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "./attachments.js";
import {
  uploadEvidenceFile,
  uploadEvidenceSession,
} from "./upload-evidence.js";

let directory: string;
let servers: Server[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cardigan-evidence-"));
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

const fixtureToken = "evidence-test-credential-do-not-print";
const privateMessage = "private server message /private/fixture/file";
const cli = fileURLToPath(
  new URL("../dist/upload-evidence.js", import.meta.url),
);

/** Real HTTP transport, including the SDK's automatically opened SSE GET. */
async function mcpFixture(
  options: {
    redirect?: { method: "POST" | "GET"; status: number };
    errorCode?: string;
    connectionError?: boolean;
  } = {},
) {
  const requests: { method: string; path: string; authenticated: boolean }[] =
    [];
  const server = createServer(async (req, res) => {
    requests.push({
      method: req.method ?? "",
      path: req.url ?? "",
      authenticated: req.headers.authorization === `Bearer ${fixtureToken}`,
    });
    if (req.url !== "/mcp") {
      res.writeHead(405).end();
      return;
    }
    if (options.redirect?.method === req.method) {
      res
        .writeHead(options.redirect.status, { location: "/redirected-handler" })
        .end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (options.connectionError) {
      res.writeHead(503).end(`${privateMessage} ${fixtureToken}`);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    } else {
      // An asynchronous tool gives the independent SSE handshake time to finish.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const args = message.params.arguments;
      result = options.errorCode
        ? {
            isError: true,
            content: [],
            structuredContent: {
              error: {
                code: options.errorCode,
                message: `${privateMessage} ${fixtureToken}`,
              },
            },
          }
        : {
            content: [],
            structuredContent: {
              id: "attachment-1",
              card_id: args.card_id,
              sha256: args.sha256,
              size: Buffer.from(args.file, "base64").length,
            },
          };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    requests,
  };
}

test.each([
  { method: "POST", status: 307 },
  { method: "POST", status: 308 },
  { method: "GET", status: 302 },
  { method: "GET", status: 307 },
] as const)(
  "never forwards authentication to a $method $status redirect target",
  async (redirect) => {
    const { endpoint, requests } = await mcpFixture({ redirect });
    const file = join(directory, "screenshot.png");
    await writeFile(file, "fixture");
    const upload = uploadEvidenceSession(endpoint, input(file), fixtureToken);
    if (redirect.method === "POST")
      await expect(upload).rejects.toThrow("[connection]");
    else await expect(upload).resolves.toBe("attachment-1");
    expect(requests).toContainEqual({
      method: redirect.method,
      path: "/mcp",
      authenticated: true,
    });
    expect(requests.filter((request) => request.path !== "/mcp")).toEqual([]);
  },
);

function runCli(args: string[], token = fixtureToken) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [cli, ...args],
        {
          env: { ...process.env, MCP_TOKEN: token },
          timeout: 3000,
        },
        (error, stdout, stderr) =>
          resolve({ status: error ? Number(error.code) : 0, stdout, stderr }),
      );
    },
  );
}

test.each([
  "validation_failed",
  "stale_target",
  "unauthorized",
  "forbidden_tool",
  "untrusted-code",
])(
  "CLI preserves safe upload diagnostics for %s without echoing server content",
  async (errorCode) => {
    const { endpoint } = await mcpFixture({ errorCode });
    const file = join(directory, "private-screenshot.png");
    await writeFile(file, "private-screenshot-content");
    const result = await runCli([endpoint, "C-1", "D-1", file]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      errorCode === "untrusted-code" ? "[upload]" : `[upload:${errorCode}]`,
    );
    for (const secret of [
      fixtureToken,
      privateMessage,
      file,
      endpoint,
      "private-screenshot-content",
      "untrusted-code",
    ])
      expect(result.stderr).not.toContain(secret);
  },
);

test("CLI distinguishes arguments, credential, endpoint, file and connection failures", async () => {
  const { endpoint } = await mcpFixture();
  const failed = await mcpFixture({ connectionError: true });
  const file = join(directory, "missing-private-screenshot.png");
  for (const [stage, args, token] of [
    ["arguments", [], fixtureToken],
    ["credential", [endpoint, "C-1", "D-1", file], ""],
    ["endpoint", ["invalid-private-url", "C-1", "D-1", file], fixtureToken],
    ["file", [endpoint, "C-1", "D-1", file], fixtureToken],
    ["connection", [failed.endpoint, "C-1", "D-1", file], fixtureToken],
  ] as const) {
    const result = await runCli([...args], token);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`[${stage}]`);
    for (const secret of [
      fixtureToken,
      privateMessage,
      file,
      "invalid-private-url",
    ])
      expect(result.stderr).not.toContain(secret);
  }
});

test("CLI prints only the confirmed evidence ID on success", async () => {
  const { endpoint } = await mcpFixture();
  const file = join(directory, "screenshot.png");
  await writeFile(file, "fixture");
  expect(await runCli([endpoint, "C-1", "D-1", file])).toEqual({
    status: 0,
    stdout: "attachment-1\n",
    stderr: "",
  });
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
