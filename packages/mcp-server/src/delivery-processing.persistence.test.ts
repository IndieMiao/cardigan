import type { ProjectId } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  fixture,
  id,
  run as makeRun,
  now,
  subject,
} from "../../domain/src/commands/test-fixtures.js";
import { loadCommandState } from "./commands/execute.js";
import type { LogEntry } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";

/**
 * C-847: a verification slower than the reply budget answers "processing"
 * and keeps running; the same call repeated joins it and later returns the
 * registered delivery, with real SQLite persistence and MCP transport.
 */
let store: Store,
  server: RunningServer,
  client: Client,
  project: ProjectId,
  verifications = 0,
  release: () => void = () => undefined,
  hold = true,
  logs: LogEntry[] = [];
const params = {
  idempotency_key: "slow-delivery",
  work_item_id: "W-1",
  kind: "code",
  summary: "Synthetic delivery",
  subject,
  requested_verifiers: ["W-2"],
};
beforeEach(async () => {
  store = Store.open({ dbPath: ":memory:" });
  verifications = 0;
  hold = true;
  logs = [];
  const initial = fixture();
  project = initial.project_id;
  store.createProject({ id: project });
  store.uow.run((tx) => {
    for (const card of initial.cards) tx.cards.put(project, card);
    for (const item of initial.work_items) tx.work_items.put(project, item);
    for (const a of initial.assignments)
      tx.assignments.put(project, {
        ...a,
        branch: "agent/slow",
        worktree_path: "/synthetic/slow",
      });
    for (const run of initial.runs) tx.runs.put(project, run);
    for (const role of initial.roles) tx.roles.put(project, role);
  });
  server = await startMcpServer({
    store,
    acknowledgeRuns: false,
    deliveryReplyWithinMs: 50,
    deliveryVerifier: () => ({
      verify: async () => {
        verifications++;
        if (hold)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return { ok: true, value: [] };
      },
    }),
    clock: { now: () => now },
    log: (entry) => logs.push(entry),
  });
  const token = store.issueToken({
    project_id: project,
    assignment_id: id("assignment", 1),
    role: {
      role_version: 1,
      allowed_tools: ["submit_delivery", "finish_run"],
    },
  }).token;
  client = new Client({ name: "synthetic-slow-delivery", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
});
afterEach(async () => {
  release();
  await client.close();
  await server.close();
  store.close();
});
const read = () => store.uow.read((tx) => loadCommandState(tx, project));
const submit = async (args: Record<string, unknown> = params) =>
  (await client.callTool({ name: "submit_delivery", arguments: args }))
    .structuredContent as Record<string, unknown>;
const processing = {
  status: "processing",
  delivered: false,
  idempotency_key: params.idempotency_key,
  retry_after_seconds: 15,
};

test("a slow verification answers processing; the same call joins it and then returns the registered delivery", async () => {
  expect(await submit()).toMatchObject(processing);
  expect(verifications).toBe(1);
  expect(read().deliveries).toEqual([]);
  // A repeat while it is still running joins it: no second verification.
  expect(await submit()).toMatchObject(processing);
  expect(verifications).toBe(1);
  release();
  await vi.waitFor(() => expect(read().deliveries).toHaveLength(1));
  const delivery = read().deliveries[0];
  // Settled with nobody waiting: logged, and the same call returns it.
  await vi.waitFor(() =>
    expect(logs).toContainEqual(
      expect.objectContaining({
        tool: "submit_delivery",
        method: "background",
        code: "ok",
      }),
    ),
  );
  expect(await submit()).toMatchObject({
    id: delivery?.id,
    status: "submitted",
    subject,
  });
  expect(verifications).toBe(1);
  expect(read().deliveries).toHaveLength(1);
});

test("a repeat that settles within the budget gets the result directly", async () => {
  expect(await submit()).toMatchObject(processing);
  const joined = submit();
  await vi.waitFor(() => expect(verifications).toBe(1));
  release();
  expect(await joined).toMatchObject({ status: "submitted", subject });
  expect(verifications).toBe(1);
});

test("different parameters under the same key are not joined to the running call", async () => {
  expect(await submit()).toMatchObject(processing);
  const first = release;
  expect(await submit({ ...params, summary: "Another summary" })).toMatchObject(
    processing,
  );
  expect(verifications).toBe(2);
  first();
});

test("state changed while processing: the failure is recorded, the same call gets the original error once, then verifies afresh", async () => {
  expect(await submit()).toMatchObject(processing);
  // The caller gave up and ended its Run while verification was running.
  const finished = await client.callTool({
    name: "finish_run",
    arguments: {
      idempotency_key: "finish",
      run_id: "R-1",
      outcome: "failed",
      summary: "submit_delivery timed out",
    },
  });
  expect(finished.isError).not.toBe(true);
  release();
  await vi.waitFor(() =>
    expect(read().events).toContainEqual(
      expect.objectContaining({ type: "delivery_rejected" }),
    ),
  );
  expect(logs).toContainEqual(
    expect.objectContaining({
      tool: "submit_delivery",
      method: "background",
      code: "illegal_transition",
    }),
  );
  expect(read().deliveries).toEqual([]);
  expect(read().timeline.at(-1)?.body).toContain(
    "幂等键 slow-delivery）在调用方停止等待后校验完成，未登记：illegal_transition",
  );
  store.uow.run((tx) =>
    tx.runs.put(project, {
      ...makeRun(5, 1),
      trigger_event_id: `${"0".repeat(25)}5`,
    } as ReturnType<typeof makeRun>),
  );
  // The same call again: the original error, without verifying again.
  const replayed = await client.callTool({
    name: "submit_delivery",
    arguments: params,
  });
  expect(replayed.isError).toBe(true);
  expect(replayed.structuredContent).toMatchObject({
    error: {
      code: "illegal_transition",
      message: "Exactly one running Run is required",
      details: { replayed: true, settled_at: now },
    },
  });
  expect(verifications).toBe(1);
  // Once received, the next attempt is evaluated against current state.
  const again = submit();
  await vi.waitFor(() => expect(verifications).toBe(2));
  release();
  expect(await again).toMatchObject({ status: "submitted", run_id: "R-5" });
  expect(read().deliveries).toHaveLength(1);
  expect(
    read().events.filter((e) => e.type === "delivery_rejection_claimed"),
  ).toHaveLength(1);
});

test("a failure the caller received directly is not recorded or replayed; a stale supersedes says how to fix it", async () => {
  hold = false;
  const bad = { ...params, supersedes: "D-999" };
  const first = await client.callTool({
    name: "submit_delivery",
    arguments: bad,
  });
  expect(first.structuredContent).toMatchObject({
    error: {
      code: "stale_target",
      message: expect.stringContaining(
        "D-999 不是本工作项的交付；当前没有有效的产出交付，去掉 supersedes",
      ),
    },
  });
  const again = await client.callTool({
    name: "submit_delivery",
    arguments: bad,
  });
  expect(again.structuredContent).toEqual(first.structuredContent);
  expect(verifications).toBe(2);
  expect(read().events.some((e) => e.type === "delivery_rejected")).toBe(false);
});
