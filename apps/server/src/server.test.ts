import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { installShutdownHandlers } from "./lifecycle.js";
import { type CardiganServer, startCardiganServer } from "./server.js";

let dataDir: string;
let store: Store;
let server: CardiganServer;
let warnings: string[];

beforeEach(async () => {
  warnings = [];
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-server-"));
  store = Store.open({ dataDir });
  server = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
    store,
    warn: (message) => warnings.push(message),
  });
});

test("local server startup visibly warns that the Agent account is not isolated", () => {
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("没有 Agent 账号隔离");
  expect(warnings[0]).toContain("agent-ssh");
});

afterEach(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function connect(token: string | undefined): Promise<Client> {
  const client = new Client({ name: "fictional-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    ...(token === undefined
      ? {}
      : { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  });
  return client.connect(transport).then(() => client);
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text;
  return text === undefined
    ? {}
    : (JSON.parse(text) as Record<string, unknown>);
}

/** Seed one project, card, work item, assignment and token. */
function seed(store: Store): string {
  const allowed_tools = [
    "whoami",
    "get_card",
    "post_comment",
    "upload_attachment",
  ] as const;
  const project_id = "p-smoke" as never;
  store.createProject({ id: project_id, name: "Smoke" });
  store.uow.run((tx) => {
    tx.cards.put(project_id, {
      id: "C-1" as never,
      project_id,
      title: "Fictional card",
      goal: "",
      acceptance_criteria: [],
      source: { kind: "quote", text: "" },
      out_of_scope: [],
      related_cards: [],
      repo: "example/repo",
      base_branch: "main",
      priority: 1,
      status: "todo",
      template: "dev",
      created_by: "human",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    tx.work_items.put(project_id, {
      id: "W-1" as never,
      card_id: "C-1" as never,
      title: "Fictional work item",
      kind: "produce",
      role_id: "coder",
      required: true,
      depends_on: [],
      completion_criteria: [],
      status: "todo",
    });
    tx.assignments.put(project_id, {
      id: "A-1" as never,
      scope: "work_item",
      work_item_id: "W-1" as never,
      role_id: "coder",
      role_version: 1,
      status: "active",
      runtime_state: "not_running" as never,
      machine_id: "local",
      runtime_ref: null,
      mcp_token_id: "tok_smoke",
      created_at: "2026-01-01T00:00:00.000Z",
    } as never);
    tx.roles.put(project_id, {
      role_id: "coder",
      role_version: 1,
      allowed_tools,
      capabilities: ["code"],
    });
  });

  // The plan's M1.7a smoke test issues the token directly through the store.
  return store.issueToken({
    project_id,
    assignment_id: "A-1" as never,
    role: { role_version: 1, allowed_tools },
    token: "fictional-smoke-token",
  }).token;
}

test("the assembled server answers whoami with the token identity", async () => {
  const token = seed(store);
  const client = await connect(token);

  const result = await client.callTool({ name: "whoami", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toMatchObject({
    project_id: "p-smoke",
    assignment_id: "A-1",
    role_id: "coder",
    card_id: "C-1",
    machine_id: "local",
  });

  // get_card works through the same assembled server.
  const card = await client.callTool({
    name: "get_card",
    arguments: { card_id: "C-1" },
  });
  expect(textOf(card)).toMatchObject({ card: { id: "C-1" } });
});

test("the assembled server still rejects requests without a token", async () => {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(response.status).toBe(401);
});

test("uploads use the assembled server's configured data directory", async () => {
  const client = await connect(seed(store));
  try {
    const comment = textOf(
      await client.callTool({
        name: "post_comment",
        arguments: {
          idempotency_key: "comment",
          card_id: "C-1",
          body: "Attach here",
        },
      }),
    );
    const result = await client.callTool({
      name: "upload_attachment",
      arguments: {
        idempotency_key: "upload",
        card_id: "C-1",
        file: "aGk=",
        mime: "text/plain",
        kind: "evidence",
        attach_to: { kind: "timeline_entry", id: comment.id },
      },
    });
    expect(result.isError).not.toBe(true);
    expect(
      readFileSync(join(dataDir, String(textOf(result).storage_path)), "utf8"),
    ).toBe("hi");
  } finally {
    await client.close();
  }
});

test("close() closes the MCP endpoint and the store it owns", async () => {
  const owned = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
  });
  const url = owned.url;
  await owned.close();

  await expect(fetch(url, { method: "POST" })).rejects.toThrow();
  // The store was opened by the server and closed with it.
  expect(() => owned.store.listProjects()).toThrow(/database is not open/i);
});

test("a failing port bind closes the store it opened", async () => {
  const first = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
  });
  try {
    await expect(
      startCardiganServer({
        config: { dataDir, host: "127.0.0.1", port: first.port },
      }),
    ).rejects.toThrow();
  } finally {
    await first.close();
  }
});

test("SIGTERM triggers shutdown through the installed handler", () => {
  const handlers = new Map<string, () => void>();
  const host = {
    once: (signal: string, listener: () => void) => {
      handlers.set(signal, listener);
    },
    off: (signal: string) => {
      handlers.delete(signal);
    },
  };

  const seen: string[] = [];
  installShutdownHandlers(host as never, (signal) => seen.push(signal));
  expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);

  handlers.get("SIGTERM")?.();
  expect(seen).toEqual(["SIGTERM"]);
  // Handlers are removed, so a second signal does not run shutdown twice.
  expect(handlers.size).toBe(0);
});

/** Some environments have no IPv6 loopback; skip the ::1 test there. */
const supportsIpv6Loopback = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

test.skipIf(!supportsIpv6Loopback)(
  "listens on the IPv6 loopback and still answers the Host check",
  async () => {
    const v6Store = Store.open({ dataDir });
    const v6 = await startCardiganServer({
      config: { dataDir, host: "::1", port: 0 },
      store: v6Store,
    });
    try {
      expect(v6.url).toContain("http://[::1]:");
      const client = await connect(seed(v6Store));
      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect(textOf(result)).toMatchObject({ assignment_id: "A-1" });
    } finally {
      await v6.close();
      v6Store.close();
    }
  },
);

test("a non-loopback host is refused before anything starts", async () => {
  const env = { CARDIGAN_DATA_DIR: dataDir, CARDIGAN_MCP_HOST: "0.0.0.0" };
  await expect(startCardiganServer({ env })).rejects.toThrow(
    /M1 只支持本机监听/,
  );
});
