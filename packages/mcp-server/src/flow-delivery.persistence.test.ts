import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProjectId, prechecks, recordPrecheck } from "@cardigan/domain";
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
import { loadCommandState, persistEffect, unwrap } from "./commands/execute.js";
import { startMcpServer } from "./server.js";

// Real A2a commands and SQLite persistence, with a synthetic HEAD/executor result.
function recordResult(
  store: Store,
  project: ProjectId,
  status: "running" | "passed",
) {
  store.uow.run((tx) => {
    const state = loadCommandState(tx, project);
    const check = prechecks(state.events).at(-1);
    if (!check) throw new Error("Missing queued precheck");
    persistEffect(
      tx,
      project,
      unwrap(
        recordPrecheck(
          state,
          { kind: "system", project_id: project },
          {
            ...check,
            status,
            candidate_sha: "b".repeat(40),
            tree_sha: "c".repeat(40),
            base_sha: "d".repeat(40),
            executor: { name: "synthetic", type: "ssh" },
            ...(status === "passed"
              ? {
                  checks: [{ name: "test", status: "passed", exit_code: 0 }],
                }
              : {}),
          },
          { ids: tx.ids, clock: { now: () => now } },
        ),
      ),
    );
  });
}

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
      checkHead: () => ({ head: async () => subject.value }),
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
    for (const a of initial.assignments)
      tx.assignments.put(project, {
        ...a,
        branch: "agent/precheck",
        worktree_path: "/synthetic/precheck",
      });
    for (const run of initial.runs) tx.runs.put(project, run);
    for (const role of initial.roles) tx.roles.put(project, role);
  });
  const token = store.issueToken({
    project_id: project,
    assignment_id: id("assignment", 1),
    role: {
      role_version: 1,
      allowed_tools: ["submit_delivery", "request_check"],
    },
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
    expect(
      (
        await client.callTool({
          name: "request_check",
          arguments: { idempotency_key: "precheck", work_item_id: "W-1" },
        })
      ).isError,
    ).not.toBe(true);
    expect((await call()).structuredContent).toMatchObject(denied);
    // The host command writes through a second connection after the cache
    // was primed by failed calls, then the MCP process is restarted.
    const writer = Store.open({ dataDir });
    try {
      recordResult(writer, project, "running");
      expect((await call()).structuredContent).toMatchObject(denied);
      recordResult(writer, project, "passed");
      expect(prechecks(read().events).at(-1)?.status).toBe("passed");
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
    const assignment = tx.assignments.get(project, f.coder.id);
    if (!assignment) throw new Error("Missing producer");
    tx.assignments.put(project, {
      ...assignment,
      branch: "agent/recheck",
      worktree_path: "/synthetic/recheck",
    });
  });
  const token = store.issueToken({
    project_id: project,
    assignment_id: f.coder.id,
    role: {
      role_version: 1,
      allowed_tools: ["submit_delivery", "request_recheck", "request_check"],
    },
  }).token;
  const server = await startMcpServer({
    store,
    acknowledgeRuns: false,
    projectSettings: () => ({ merge_gate_enabled: true }),
    checkHead: () => ({ head: async () => subject.value }),
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
    expect(
      (
        await client.callTool({
          name: "request_check",
          arguments: {
            idempotency_key: "recheck-precheck",
            work_item_id: f.coder.work_item_id,
          },
        })
      ).isError,
    ).not.toBe(true);
    recordResult(store, project, "running");
    recordResult(store, project, "passed");
    expect((await call()).isError).not.toBe(true);
    expect(read().deliveries).toHaveLength(before.length + 2);
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});
