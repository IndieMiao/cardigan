import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { recheckVerifier } from "../../domain/src/commands/request-recheck/test-fixtures.js";
import {
  fixture,
  id,
  now,
  subject,
} from "../../domain/src/commands/test-fixtures.js";
import { seedReturnedRecheck } from "../test-support/request-recheck.js";
import { loadCommandState } from "./commands/execute.js";
import { startMcpServer } from "./server.js";

// Synthetic persisted A2a event, not a real executor run.
test("MCP delivery uses persisted precheck evidence and fresh host configuration", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-flow-delivery-"));
  let store = Store.open({ dataDir });
  const initial = fixture();
  const project = initial.project_id;
  let gate = true;
  let enableDuringVerify = false;
  const boot = () =>
    startMcpServer({
      store,
      acknowledgeRuns: false,
      projectSettings: () => ({ merge_gate_enabled: gate }),
      deliveryVerifier: () => ({
        verify: async () => {
          if (enableDuringVerify) gate = true;
          return { ok: true, value: [] };
        },
      }),
      clock: { now: () => now },
      log: () => {},
    });
  store.createProject({ id: project });
  store.uow.run((tx) => {
    for (const card of initial.cards)
      tx.cards.put(project, { ...card, flow_version: 3 });
    for (const item of initial.work_items) tx.work_items.put(project, item);
    for (const a of initial.assignments) tx.assignments.put(project, a);
    for (const run of initial.runs) tx.runs.put(project, run);
    for (const role of initial.roles) tx.roles.put(project, role);
  });
  const token = store.issueToken({
    project_id: project,
    assignment_id: id("assignment", 1),
    role: { role_version: 1, allowed_tools: ["submit_delivery"] },
  }).token;
  let server = await boot();
  const clients: Client[] = [];
  const connect = async () => {
    const c = new Client({ name: "synthetic-flow-delivery", version: "1" });
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return c;
  };
  const params = {
    idempotency_key: "flow-delivery",
    work_item_id: "W-1",
    kind: "code",
    summary: "Synthetic delivery",
    subject,
    requested_verifiers: ["W-2"],
  };
  const read = () => store.uow.read((tx) => loadCommandState(tx, project));
  const denied = {
    error: { code: "illegal_transition", message: "请先 request_check" },
  };
  try {
    const client = await connect();
    const before = read();
    const call = () =>
      client.callTool({ name: "submit_delivery", arguments: params });
    expect((await call()).structuredContent).toMatchObject(denied);
    expect(read().deliveries).toEqual(before.deliveries);
    expect(read().events).toEqual(before.events);
    // Configuration changes across the external verification await must be
    // observed in the write transaction, rather than reusing preflight state.
    gate = false;
    enableDuringVerify = true;
    expect((await call()).structuredContent).toMatchObject(denied);
    expect(gate).toBe(true);
    expect(read().events).toEqual(before.events);
    enableDuringVerify = false;
    // A second connection commits the trusted event after the snapshot cache
    // was primed by the failed calls.
    const writer = Store.open({ dataDir });
    try {
      writer.uow.run((tx) =>
        tx.events.append(project, {
          id: tx.ids.nextEventId(),
          card_id: id("card", 1),
          seq: tx.ids.nextEventSequence(project, id("card", 1)),
          type: "precheck_finished",
          actor: { kind: "system", project_id: project },
          payload: {
            attempt_id: "synthetic-precheck",
            head_sha: subject.value,
            status: "passed",
          },
          created_at: now,
        }),
      );
    } finally {
      writer.close();
    }
    await client.close();
    await server.close();
    store.close();
    store = Store.open({ dataDir });
    server = await boot();
    const resumed = await connect();
    expect(read().events).toContainEqual(
      expect.objectContaining({ type: "precheck_finished" }),
    );
    const result = await resumed.callTool({
      name: "submit_delivery",
      arguments: params,
    });
    expect(result.isError).not.toBe(true);
    expect(read().deliveries).toHaveLength(1);
    expect(
      (await resumed.callTool({ name: "submit_delivery", arguments: params }))
        .structuredContent,
    ).toEqual(result.structuredContent);
    expect(read().deliveries).toHaveLength(1);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP recheck composition receives the host's delivery gate configuration", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  const { f, project, read } = await seedReturnedRecheck(store);
  store.uow.run((tx) => {
    tx.cards.put(project, {
      ...f.card,
      status: "in_progress",
      flow_version: 3,
    });
  });
  const token = store.issueToken({
    project_id: project,
    assignment_id: f.coder.id,
    role: {
      role_version: 1,
      allowed_tools: ["submit_delivery", "request_recheck"],
    },
  }).token;
  const server = await startMcpServer({
    store,
    acknowledgeRuns: false,
    projectSettings: () => ({ merge_gate_enabled: true }),
    deliveryVerifier: () => recheckVerifier(),
    clock: { now: () => now },
    log: () => {},
  });
  const client = new Client({ name: "synthetic-recheck-gate", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const call = () =>
      client.callTool({
        name: "request_recheck",
        arguments: {
          idempotency_key: "gated-recheck",
          card_id: f.card.id,
          reason: "合成的无关失败",
        },
      });
    const before = read().deliveries;
    expect((await call()).structuredContent).toMatchObject({
      error: { code: "illegal_transition", message: "请先 request_check" },
    });
    expect(read().deliveries).toEqual(before);
    store.uow.run((tx) =>
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        card_id: f.card.id,
        seq: tx.ids.nextEventSequence(project, f.card.id),
        type: "precheck_finished",
        actor: { kind: "system", project_id: project },
        payload: { head_sha: subject.value, status: "passed" },
        created_at: now,
      }),
    );
    expect((await call()).isError).not.toBe(true);
    expect(read().deliveries).toHaveLength(before.length + 2);
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});
