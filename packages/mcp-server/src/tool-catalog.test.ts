import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolName } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { memoryLogger } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
  project_id,
  seedProject,
} from "./test-support.js";
import { canonicalJson } from "./tool-server.js";
import { readOnlyTools } from "./tools/index.js";

// P2a-10 A (finding 40): the Dispatcher compares a session's recorded tool
// catalog with this fingerprint, so it must hash exactly what tools/list
// serves to the same token, and change only when that list changes.

const allowed: readonly ToolName[] = ["whoami", "get_updates", "ack_events"];
let store: Store, dataDir: string, token: string;
let assignment: ReturnType<typeof seedProject>["assignment"];
const servers: RunningServer[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-catalog-"));
  store = Store.open({ dataDir });
  assignment = seedProject(store, { allowed_tools: allowed }).assignment;
  token = store.issueToken({
    project_id,
    assignment_id: assignment.id,
    role: { role_version: assignment.role_version, allowed_tools: allowed },
    token: "fictional-token-value",
  }).token;
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function deploy(tools?: Parameters<typeof startMcpServer>[0]["tools"]) {
  const server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    log: memoryLogger().log,
    ...(tools ? { tools } : {}),
  });
  servers.push(server);
  return server;
}

/** A new session: connect with the token and list tools once. */
async function listed(server: RunningServer) {
  const client = new Client({ name: "fictional-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const hash = (tools: Awaited<ReturnType<typeof listed>>) =>
  createHash("sha256")
    .update(
      canonicalJson(
        [...tools]
          .map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          }))
          .sort((a, b) => (a.name < b.name ? -1 : 1)),
      ),
    )
    .digest("hex");

test("P2a-10 A: the fingerprint is the hash of the tools/list a session receives", async () => {
  const server = await deploy();
  const tools = await listed(server);
  expect(tools.map((t) => t.name).sort()).toEqual([...allowed].sort());
  expect(server.toolCatalog(allowed, assignment)).toBe(hash(tools));
  // Allowed-tool order does not matter.
  expect(server.toolCatalog([...allowed].reverse(), assignment)).toBe(
    hash(tools),
  );
});

test("P2a-10 A: a redeploy with the same tools keeps the fingerprint", async () => {
  const before = await deploy();
  const after = await deploy();
  expect(after.toolCatalog(allowed, assignment)).toBe(
    before.toolCatalog(allowed, assignment),
  );
});

test("P2a-10 A: a changed description changes the fingerprint and a new session lists it", async () => {
  const before = await deploy(readOnlyTools);
  const changed = readOnlyTools.map((tool) =>
    tool.name === "get_updates"
      ? { ...tool, description: `${tool.description} (new deploy)` }
      : tool,
  );
  const after = await deploy(changed);
  expect(after.toolCatalog(allowed, assignment)).not.toBe(
    before.toolCatalog(allowed, assignment),
  );
  // The same token, in a new session against the new deploy, sees the change.
  const tools = await listed(after);
  expect(tools.find((t) => t.name === "get_updates")?.description).toContain(
    "(new deploy)",
  );
  expect(after.toolCatalog(allowed, assignment)).toBe(hash(tools));
  // Tools outside the token's scope do not affect the fingerprint.
  const unrelated = readOnlyTools.map((tool) =>
    tool.name === "get_card"
      ? { ...tool, description: `${tool.description} (new deploy)` }
      : tool,
  );
  const other = await deploy(unrelated);
  expect(other.toolCatalog(allowed, assignment)).toBe(
    before.toolCatalog(allowed, assignment),
  );
});
