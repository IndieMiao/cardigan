import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type LogEntry, memoryLogger } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";
import { card_id, type Fixture, seedFixture } from "./test-support.js";

let fixture: Fixture;
let server: RunningServer;
let entries: LogEntry[];

async function connect(token: string | undefined): Promise<Client> {
  const client = new Client({ name: "fictional-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit:
      token === undefined
        ? undefined
        : { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const first = content?.[0]?.text;
  return first === undefined
    ? {}
    : (JSON.parse(first) as Record<string, unknown>);
}

beforeEach(async () => {
  fixture = seedFixture();
  entries = [];
  const logger = memoryLogger();
  entries = logger.entries;
  server = await startMcpServer({ store: fixture.store, log: logger.log });
});

afterEach(async () => {
  await server.close();
  fixture.close();
});

describe("bearer token authentication", () => {
  test("requests without a token get 401", async () => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "unauthorized" },
    });
  });

  test("a wrong token gets 401", async () => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer fictional-but-wrong",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  test("a revoked token gets 401", async () => {
    // Connected before revoking, to prove the check happens per request.
    const client = await connect(fixture.token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    const record = fixture.store.verifyToken(fixture.token);
    expect(record).toBeDefined();
    fixture.store.revokeToken(record?.id ?? "");

    await expect(client.listTools()).rejects.toThrow();
  });

  test("a token without a matching assignment gets 401", async () => {
    const orphan = fixture.store.issueToken({
      project_id: "p-fictional" as never,
      assignment_id: "A-404" as never,
      role: { role_version: 1, allowed_tools: ["whoami"] },
    });
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${orphan.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("tools by allowed_tools", () => {
  test("tools/list only exposes the token's tools", async () => {
    const client = await connect(fixture.token);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "ack_events",
      "get_updates",
      "whoami",
    ]);
    expect(tools.tools[0]?.inputSchema).toBeTypeOf("object");
  });

  test("a tool outside allowed_tools is forbidden, even by name", async () => {
    fixture.close();
    fixture = seedFixture({ allowed_tools: ["whoami", "get_updates"] });
    await server.close();
    const logger = memoryLogger();
    entries = logger.entries;
    server = await startMcpServer({ store: fixture.store, log: logger.log });
    const client = await connect(fixture.token);

    const result = await client.callTool({
      name: "ack_events",
      arguments: { card_id: card_id, up_to_seq: 1 },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({
      error: { code: "forbidden_tool" },
    });
    // Nothing was written: the cursor did not move.
    const cursor = fixture.store.database
      .prepare("SELECT COUNT(*) AS n FROM cursors")
      .get();
    expect(Number(cursor?.n)).toBe(0);
  });

  test("an unknown tool name is not_found", async () => {
    const client = await connect(fixture.token);
    const result = await client.callTool({
      name: "no_such_tool",
      arguments: {},
    });
    expect(textOf(result)).toMatchObject({ error: { code: "not_found" } });
  });

  test("a read-only role does not see write tools", async () => {
    fixture.close();
    fixture = seedFixture({ allowed_tools: ["get_updates"] });
    await server.close();
    const logger = memoryLogger();
    server = await startMcpServer({ store: fixture.store, log: logger.log });
    const client = await connect(fixture.token);

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(["get_updates"]);
    const forbidden = await client.callTool({ name: "whoami", arguments: {} });
    expect(textOf(forbidden)).toMatchObject({
      error: { code: "forbidden_tool" },
    });
  });
});

describe("whoami", () => {
  test("returns the identity bound to the token", async () => {
    const client = await connect(fixture.token);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatchObject({
      project_id: "p-fictional",
      assignment_id: "A-1",
      card_id: "C-1",
      work_item_id: "W-1",
      role_id: "coder",
      role_version: 1,
      machine_id: "local",
      worktree_path: "/srv/agent/worktrees/A-1",
      branch: "agent/C-1/W-1",
      allowed_tools: ["whoami", "get_updates", "ack_events"],
    });
  });

  test("identity parameters sent by the caller are ignored", async () => {
    // A malicious client claims to be another assignment; the token wins.
    const second = fixture.store.issueToken({
      project_id: "p-fictional" as never,
      assignment_id: fixture.assignment.id,
      role: { role_version: 1, allowed_tools: ["whoami"] },
      token: "fictional-second-token",
    });
    const client = await connect(second.token);

    const result = await client.callTool({
      name: "whoami",
      arguments: {
        assignment_id: "A-999",
        project_id: "p-evil",
        role_id: "pm",
        allowed_tools: ["record_decision"],
      },
    });
    expect(textOf(result)).toMatchObject({
      project_id: "p-fictional",
      assignment_id: "A-1",
      role_id: "coder",
    });
  });
});

describe("get_updates and ack_events", () => {
  test("get_updates returns events and timeline after since_seq", async () => {
    const client = await connect(fixture.token);

    const all = await client.callTool({
      name: "get_updates",
      arguments: { card_id: card_id },
    });
    expect(textOf(all)).toMatchObject({ latest_seq: 3, since_seq: 0 });
    const payload = textOf(all) as {
      events: unknown[];
      timeline: unknown[];
    };
    expect(payload.events).toHaveLength(3);
    expect(payload.timeline).toHaveLength(3);

    const recent = await client.callTool({
      name: "get_updates",
      arguments: { card_id: card_id, since_seq: 2 },
    });
    const recentPayload = textOf(recent) as {
      events: Array<{ seq: number }>;
      timeline: Array<{ event_seq: number }>;
    };
    expect(recentPayload.events.map((event) => event.seq)).toEqual([3]);
    expect(recentPayload.timeline.map((entry) => entry.event_seq)).toEqual([3]);
  });

  test("get_updates on an unknown card is not_found", async () => {
    const client = await connect(fixture.token);
    const result = await client.callTool({
      name: "get_updates",
      arguments: { card_id: "C-404" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ error: { code: "not_found" } });
  });

  test("ack_events advances this assignment's cursor only forward", async () => {
    const client = await connect(fixture.token);

    const first = await client.callTool({
      name: "ack_events",
      arguments: { card_id: card_id, up_to_seq: 2 },
    });
    expect(textOf(first)).toMatchObject({ acked_seq: 2, changed: true });

    const again = await client.callTool({
      name: "ack_events",
      arguments: { card_id: card_id, up_to_seq: 2 },
    });
    expect(textOf(again)).toMatchObject({ acked_seq: 2, changed: false });

    const backwards = await client.callTool({
      name: "ack_events",
      arguments: { card_id: card_id, up_to_seq: 1 },
    });
    expect(textOf(backwards)).toMatchObject({ acked_seq: 2, changed: false });

    const beyond = await client.callTool({
      name: "ack_events",
      arguments: { card_id: card_id, up_to_seq: 99 },
    });
    expect(beyond.isError).toBe(true);
    expect(textOf(beyond)).toMatchObject({
      error: { code: "validation_failed" },
    });
  });

  test("invalid arguments are validation_failed", async () => {
    const client = await connect(fixture.token);
    const result = await client.callTool({
      name: "ack_events",
      arguments: { card_id: card_id, up_to_seq: -1 },
    });
    expect(textOf(result)).toMatchObject({
      error: { code: "validation_failed" },
    });
  });
});

describe("logging", () => {
  test("logs method, tool, caller and code, never the token or the body", async () => {
    const client = await connect(fixture.token);
    await client.callTool({ name: "whoami", arguments: {} });
    await client.callTool({
      name: "get_updates",
      arguments: { card_id: "C-404", note: "secret-body" },
    });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(fixture.token);
    expect(serialized).not.toContain("secret-body");

    const toolEntry = entries.find(
      (entry) => entry.event === "tool" && entry.tool === "whoami",
    );
    expect(toolEntry).toMatchObject({
      method: "tools/call",
      assignment_id: "A-1",
      code: "ok",
    });
    expect(entries.find((entry) => entry.tool === "get_updates")?.code).toBe(
      "not_found",
    );
    expect(
      entries.some((entry) => entry.event === "http" && entry.code === "ok"),
    ).toBe(true);
  });
});

describe("transport", () => {
  test("only /mcp is served, and only on loopback", async () => {
    const response = await fetch(server.url.replace("/mcp", "/other"), {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(server.host).toBe("127.0.0.1");
  });

  test("GET on /mcp is rejected in stateless mode", async () => {
    const response = await fetch(server.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${fixture.token}` },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
