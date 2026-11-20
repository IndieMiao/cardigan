import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, Run, ToolName, WorkItem } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";
import type { McpBackend } from "./backend.js";
import { type LogEntry, memoryLogger } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
  card_id,
  project_id,
  type SeededRows,
  seedProject,
  workItems,
} from "./test-support.js";

// Compile-time proof that the real store satisfies the MCP port, so production
// code can depend on `domain` only (§20.2).
expectTypeOf<Store>().toMatchTypeOf<McpBackend>();

interface Fixture extends SeededRows {
  readonly store: Store;
  readonly token: string;
  readonly workItem: WorkItem;
  readonly assignment: Assignment;
  close(): void;
}

interface FixtureOptions {
  readonly allowed_tools?: readonly ToolName[];
}

/**
 * Open a real store in a temp directory and seed it. Test files may use the
 * store directly: the dependency rules exempt tests.
 */
function seedFixture(options: FixtureOptions = {}): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-mcp-"));
  const store = Store.open({ dataDir });
  const allowed = options.allowed_tools ?? [
    "whoami",
    "get_updates",
    "ack_events",
  ];
  const seeded = seedProject(store, { allowed_tools: allowed });
  const issued = store.issueToken({
    project_id,
    assignment_id: seeded.assignment.id,
    role: {
      role_version: seeded.assignment.role_version,
      allowed_tools: allowed,
    },
    token: "fictional-token-value",
  });

  return {
    ...seeded,
    store,
    workItem: workItems,
    token: issued.token,
    close: () => {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

let fixture: Fixture;
let server: RunningServer;
let entries: LogEntry[];

async function connect(token: string | undefined): Promise<Client> {
  const client = new Client({ name: "fictional-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    ...(token === undefined
      ? {}
      : { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
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
  server = await startMcpServer({
    store: fixture.store,
    deliveryVerifier: acceptingVerifierFor,
    log: logger.log,
  });
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
    server = await startMcpServer({
      store: fixture.store,
      deliveryVerifier: acceptingVerifierFor,
      log: logger.log,
    });
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
    server = await startMcpServer({
      store: fixture.store,
      deliveryVerifier: acceptingVerifierFor,
      log: logger.log,
    });
    const client = await connect(fixture.token);

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(["get_updates"]);
    const forbidden = await client.callTool({ name: "whoami", arguments: {} });
    expect(textOf(forbidden)).toMatchObject({
      error: { code: "forbidden_tool" },
    });
  });
});

describe("authenticated Run resource observations", () => {
  const read = (key: string, token = fixture.token) =>
    fetch(`${server.url}?run_resource=${key}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  test.each(["completed", "failed", "cancelled"] as const)(
    "an exact %s state is read without acknowledging the next Run",
    async (status) => {
      const make = (id: string, state: Run["status"], finished?: Date) =>
        fixture.store.uow.run((tx) =>
          tx.runs.put(project_id, {
            id: id as Run["id"],
            assignment_id: fixture.assignment.id,
            trigger_event_id: tx.ids.nextEventId(),
            kind: "followup",
            status: state,
            role_version: 1,
            model: "fixture",
            agent_cli_version: "fixture",
            outcome: null,
            summary: "",
            ...(finished ? { finished_at: finished.toISOString() } : {}),
          }),
        );
      make("R-1", status, new Date());
      make("R-2", "dispatched");
      make("R-3", status, new Date(Date.now() - 86401_000));
      const key = "A-1.R-1.R-1";
      expect((await read(key, "invalid")).status).toBe(401);
      expect(await (await read(key)).json()).toEqual({
        key,
        state: "ended",
        project: project_id,
        machine: fixture.assignment.machine_id,
      });
      expect(await (await read("A-1.R-1.R-2")).json()).toMatchObject({
        state: "active",
      });
      expect(await (await read("A-1.R-1.R-3")).json()).toMatchObject({
        state: "expired_preview",
      });
      for (const unknown of ["A-2.R-1.R-1", "A-1.R-99.R-1", "A-1.R-1.R-99"])
        expect(await (await read(unknown)).json()).toMatchObject({
          state: "unknown",
        });
      const least = fixture.store.issueToken({
        project_id,
        assignment_id: fixture.assignment.id,
        role: { role_version: 1, allowed_tools: ["get_updates"] },
      });
      expect(
        await (await read("A-1.R-1.R-2", least.token)).json(),
      ).toMatchObject({
        state: "active",
      });
      expect(
        await (await read("A-2.R-1.R-2", least.token)).json(),
      ).toMatchObject({
        state: "unknown",
      });
      expect(
        fixture.store.uow.read(
          (tx) => tx.runs.get(project_id, "R-2" as Run["id"])?.status,
        ),
      ).toBe("dispatched");
      const client = await connect(least.token);
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        "get_updates",
      ]);
      expect(
        textOf(await client.callTool({ name: "whoami", arguments: {} })),
      ).toMatchObject({
        error: { code: "forbidden_tool" },
      });
      fixture.store.revokeToken(least.record.id);
      expect((await read(key, least.token)).status).toBe(401);
    },
  );
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
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      role: "web",
      pid: process.pid,
      request_id: expect.any(String),
      phases_ms: expect.objectContaining({
        acknowledge: expect.any(Number),
        validate: expect.any(Number),
        handler: expect.any(Number),
        serialize: expect.any(Number),
      }),
    });
    expect(
      entries.find(
        (entry) =>
          entry.event === "http" && entry.request_id === toolEntry?.request_id,
      ),
    ).toBeDefined();
    expect(entries.find((entry) => entry.tool === "get_updates")?.code).toBe(
      "not_found",
    );
    expect(
      entries.some((entry) => entry.event === "http" && entry.code === "ok"),
    ).toBe(true);
  });
});

/** POST with an explicit Host header (fetch would not let us spoof it). */
function postWithHost(
  url: string,
  host: string,
  token: string,
  body: string,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          Host: host,
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("transport", () => {
  test("configured proxy Host authenticates initialize without starting a Run, and revocation fails closed", async () => {
    const proxyHost = "control.example-tailnet.ts.net";
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "preflight", version: "1" },
      },
    });
    expect(
      (await postWithHost(server.url, proxyHost, fixture.token, body)).status,
    ).toBe(403);
    await server.close();
    let enabled = true;
    const logger = memoryLogger();
    server = await startMcpServer({
      store: fixture.store,
      log: logger.log,
      proxyHosts: (project) => {
        expect(project).toBe(project_id);
        return enabled ? [proxyHost] : [];
      },
    });
    expect(
      (await postWithHost(server.url, proxyHost, "invalid", body)).status,
    ).toBe(401);
    const response = await postWithHost(
      server.url,
      proxyHost,
      fixture.token,
      body,
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "cardigan" },
      },
    });
    expect(
      (
        await postWithHost(
          server.url,
          `other.${proxyHost}`,
          fixture.token,
          body,
        )
      ).status,
    ).toBe(403);
    enabled = false;
    expect(
      (await postWithHost(server.url, proxyHost, fixture.token, body)).status,
    ).toBe(403);
    expect(
      (
        await postWithHost(
          server.url,
          `127.0.0.1:${server.port}`,
          fixture.token,
          body,
        )
      ).status,
    ).toBe(200);
    expect(logger.entries.some((entry) => entry.event === "tool")).toBe(false);
  });
  test("only /mcp is served, and only on loopback", async () => {
    const response = await fetch(server.url.replace("/mcp", "/other"), {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(server.host).toBe("127.0.0.1");
  });

  test("a foreign Host header is rejected and the tool does not run", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ack_events",
        arguments: { card_id: card_id, up_to_seq: 3 },
      },
    });

    const rejected = await postWithHost(
      server.url,
      "evil.example",
      fixture.token,
      body,
    );
    // The transport answers 403 for a Host header it does not allow.
    expect(rejected.status).toBe(403);
    expect(rejected.body).toMatch(/host/i);

    // The request never reached a tool: no cursor row, no tool log entry.
    const cursors = fixture.store.database
      .prepare("SELECT COUNT(*) AS n FROM cursors")
      .get();
    expect(Number(cursors?.n)).toBe(0);
    expect(entries.some((entry) => entry.event === "tool")).toBe(false);

    // The same call with the loopback Host works, proving the rejection was
    // the Host check and not the tool itself.
    const accepted = await postWithHost(
      server.url,
      `127.0.0.1:${server.port}`,
      fixture.token,
      body,
    );
    expect(accepted.status).toBe(200);
    const after = fixture.store.database
      .prepare("SELECT COUNT(*) AS n FROM cursors")
      .get();
    expect(Number(after?.n)).toBe(1);
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
