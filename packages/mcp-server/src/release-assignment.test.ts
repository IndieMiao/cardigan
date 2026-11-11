import type { Assignment, Run, ToolName } from "@cardigan/domain";
import { STANDING_ROLE_TOOLS, standingTools } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { memoryLogger } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
  card_id,
  NOW,
  project_id,
  seedProject,
} from "./test-support.js";

let store: Store;
let server: RunningServer;
let target: Assignment;
let clients: Client[];

beforeEach(async () => {
  store = Store.open({ dbPath: ":memory:" });
  clients = [];
  target = seedProject(store, {
    allowed_tools: STANDING_ROLE_TOOLS,
  }).assignment;
  store.uow.run((tx) => {
    target = { ...target, runtime_state: "idle" };
    tx.assignments.put(project_id, target);
    tx.roles.put(project_id, {
      role_id: "pm",
      role_version: 1,
      allowed_tools: STANDING_ROLE_TOOLS,
      capabilities: [],
    });
  });
  server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    log: memoryLogger().log,
  });
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await server.close();
  store.close();
});

function pm(mode: "office" | "ops"): Assignment {
  return {
    id: "A-2" as never,
    scope: "standing",
    standing_mode: mode,
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "idle",
    runtime_ref: null,
    machine_id: "local",
    mcp_token_id: "fixture-pm",
    created_at: NOW,
  };
}

async function connect(
  assignment: Assignment,
  allowed_tools: readonly ToolName[],
) {
  store.uow.run((tx) => tx.assignments.put(project_id, assignment));
  const issued = store.issueToken({
    project_id,
    assignment_id: assignment.id,
    role: { role_version: 1, allowed_tools },
  });
  const client = new Client({ name: "release-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
    }),
  );
  return client;
}

const call = (
  client: Client,
  assignment_id = target.id,
  key = "release-once",
) =>
  client.callTool({
    name: "release_assignment",
    arguments: { assignment_id, idempotency_key: key },
  });

test("Ops releases a work-item Assignment once; authentication rejects its old token immediately", async () => {
  const old = store.issueToken({
    project_id,
    assignment_id: target.id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  const ops = await connect(
    pm("ops"),
    standingTools(STANDING_ROLE_TOOLS, "ops"),
  );
  expect((await ops.listTools()).tools.map((t) => t.name)).toContain(
    "release_assignment",
  );
  const released = await call(ops);
  expect(released.isError).not.toBe(true);
  expect(released.structuredContent).toMatchObject({
    id: target.id,
    status: "released",
    runtime_state: "released",
  });
  expect((await call(ops)).structuredContent).toEqual(
    released.structuredContent,
  );
  expect((await call(ops, target.id, "release-again")).isError).not.toBe(true);
  expect(
    store.uow
      .read((tx) => tx.events.listAfter(project_id, card_id, 0))
      .filter((e) => e.type === "assignment_released"),
  ).toHaveLength(1);
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${old.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(response.status).toBe(401);
});

test.each(["office", "coder", "work-item-pm", "missing-tool"] as const)(
  "%s cannot discover or call release_assignment even with a broad legacy token",
  async (kind) => {
    const caller =
      kind === "coder"
        ? target
        : kind === "work-item-pm"
          ? { ...target, id: "A-2" as Assignment["id"], role_id: "pm" }
          : pm(kind === "office" ? "office" : "ops");
    const client = await connect(
      caller,
      STANDING_ROLE_TOOLS.filter(
        (tool) =>
          tool !== "record_decision" &&
          (kind !== "missing-tool" || tool !== "release_assignment"),
      ),
    );
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
      "release_assignment",
    );
    expect((await call(client)).structuredContent).toMatchObject({
      error: { code: "forbidden_tool" },
    });
    expect(
      store.uow.read((tx) => tx.assignments.get(project_id, target.id))?.status,
    ).toBe("active");
  },
);

test("Ops cannot release standing Assignments, including a repeated release", async () => {
  const ops = await connect(
    pm("ops"),
    standingTools(STANDING_ROLE_TOOLS, "ops"),
  );
  for (const status of ["active", "released"] as const) {
    const standing = { ...pm("office"), id: "A-3" as Assignment["id"], status };
    store.uow.run((tx) => tx.assignments.put(project_id, standing));
    expect(
      (await call(ops, standing.id, status)).structuredContent,
    ).toMatchObject({ error: { code: "unauthorized" } });
  }
});

test.each(["queued", "dispatched", "acked", "running", "unknown"] as const)(
  "an unfinished %s Run refuses release without writes and points to assignment stop",
  async (status) => {
    const ops = await connect(
      pm("ops"),
      standingTools(STANDING_ROLE_TOOLS, "ops"),
    );
    store.uow.run((tx) =>
      tx.runs.put(project_id, {
        id: "R-1" as never,
        assignment_id: target.id,
        trigger_event_id: tx.ids.nextEventId(),
        kind: "initial",
        status,
        role_version: 1,
        model: "fixture",
        agent_cli_version: "1",
        outcome: null,
        summary: "",
      } satisfies Run),
    );
    expect((await call(ops)).structuredContent).toMatchObject({
      error: {
        code: "illegal_transition",
        message: expect.stringContaining(
          `cardigan assignment stop ${target.id}`,
        ),
      },
    });
    expect(
      store.uow.read((tx) => tx.assignments.get(project_id, target.id))?.status,
    ).toBe("active");
    expect(
      store.uow
        .read((tx) => tx.events.listAfter(project_id, card_id, 0))
        .some((e) => e.type === "assignment_released"),
    ).toBe(false);
  },
);
