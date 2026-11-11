import type { Assignment, ToolName } from "@cardigan/domain";
import { HOST_OPS_TOOLS } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { memoryLogger } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";
import { acceptingVerifierFor, NOW, project_id } from "./test-support.js";

let store: Store, server: RunningServer;
const clients: Client[] = [];
const read = vi.fn(() => ({ runs: [] }));
const execute = vi.fn(() => ({ status: "pending" }));
beforeEach(async () => {
  read.mockClear();
  execute.mockClear();
  store = Store.open({ dbPath: ":memory:" });
  server = await startMcpServer({
    store,
    port: 0,
    deliveryVerifier: acceptingVerifierFor,
    log: memoryLogger().log,
    hostOps: { read, execute },
    acknowledgeRuns: false,
  });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await server.close();
  store.close();
});
async function client(
  role_id = "host_ops",
  allowed_tools: readonly ToolName[] = HOST_OPS_TOOLS,
) {
  const assignment: Assignment = {
    id: "A-1" as never,
    role_id,
    role_version: 1,
    scope: "standing",
    status: "active",
    runtime_state: "idle",
    runtime_ref: null,
    machine_id: "local",
    mcp_token_id: "pending",
    created_at: NOW,
  };
  store.uow.run((tx) => {
    tx.roles.put(project_id, {
      role_id,
      role_version: 1,
      allowed_tools,
      capabilities: [],
    });
    tx.assignments.put(project_id, assignment);
  });
  const issued = store.issueToken({
    project_id,
    assignment_id: assignment.id,
    role: { role_version: 1, allowed_tools },
  });
  const c = new Client({ name: "host-ops-test", version: "1" });
  clients.push(c);
  await c.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
    }),
  );
  return { c, assignment };
}
const args = {
  host_ops_read_diagnostics: {},
  host_ops_restart_assignment: { assignment_id: "A-2", reason: "Recover" },
  host_ops_cancel_run: { run_id: "R-1", reason: "Stop" },
  host_ops_recheck_merge: { card_id: "C-1" },
  host_ops_restart_standing_pm: { assignment_id: "A-3", reason: "Refresh" },
};

test("all five tools register and dispatch only the authenticated host_ops identity", async () => {
  const { c } = await client();
  expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(
    [...HOST_OPS_TOOLS].sort(),
  );
  for (const name of HOST_OPS_TOOLS) {
    const result = await c.callTool({
      name,
      arguments: { ...args[name], idempotency_key: name },
    });
    expect(result.isError).not.toBe(true);
  }
  expect(read).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(4);
  for (const [context] of execute.mock.calls as unknown as [
    { identity: { actor: { role_id: string; project_id: string } } },
  ][])
    expect(context.identity.actor).toMatchObject({
      role_id: "host_ops",
      project_id,
    });
});

test.each(HOST_OPS_TOOLS)(
  "%s is hidden and forbidden when absent from token",
  async (name) => {
    const { c } = await client(
      "host_ops",
      HOST_OPS_TOOLS.filter((t) => t !== name),
    );
    expect((await c.listTools()).tools.some((t) => t.name === name)).toBe(
      false,
    );
    expect(
      (
        await c.callTool({
          name,
          arguments: { ...args[name], idempotency_key: "denied" },
        })
      ).isError,
    ).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  },
);

test("PM cannot guess operational tools even with malformed legacy token metadata", async () => {
  const { c } = await client("pm");
  expect((await c.listTools()).tools).toHaveLength(0);
  for (const name of HOST_OPS_TOOLS)
    expect(
      (
        await c.callTool({
          name,
          arguments: { ...args[name], idempotency_key: name },
        })
      ).isError,
    ).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});

test("released host_ops credentials are rejected before invoking the host", async () => {
  const { c, assignment } = await client();
  store.uow.run((tx) =>
    tx.assignments.put(project_id, { ...assignment, status: "released" }),
  );
  await expect(
    c.callTool({ name: "host_ops_read_diagnostics", arguments: {} }),
  ).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
