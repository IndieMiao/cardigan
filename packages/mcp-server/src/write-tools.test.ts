import type { Assignment, DeliveryVerifier, WorkItem } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { memoryLogger } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";
import {
  assignments,
  card_id,
  NOW,
  project_id,
  serverCard,
} from "./test-support.js";

const allowed = ["submit_delivery", "submit_review", "get_card"] as const;
let store: Store;
let server: RunningServer;
let clients: Client[];
let tokens: string[];
let logger: ReturnType<typeof memoryLogger>;
async function connect(n = 0) {
  const client = new Client({ name: "write-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${tokens[n]}` } },
    }),
  );
  return client;
}
async function restart(deliveryVerifier: DeliveryVerifier) {
  await server.close();
  server = await startMcpServer({ store, deliveryVerifier, log: logger.log });
}
beforeEach(async () => {
  store = Store.open({ dbPath: ":memory:" });
  clients = [];
  tokens = [];
  logger = memoryLogger();
  store.uow.run((tx) => {
    tx.cards.put(project_id, serverCard);
    for (const [index, role_id] of ["coder", "reviewer", "pm"].entries()) {
      const n = index + 1;
      const assignment: Assignment = {
        ...assignments,
        id: `A-${n}` as never,
        work_item_id: `W-${n}` as never,
        role_id,
        mcp_token_id: `token-${n}`,
        runtime_state: "idle",
      };
      tx.assignments.put(project_id, assignment);
      tx.roles.put(project_id, {
        role_id,
        role_version: 1,
        allowed_tools: allowed,
        capabilities: [],
      });
      const common = {
        id: `W-${n}` as never,
        card_id,
        title: role_id,
        role_id,
        required: true,
        depends_on: [],
        completion_criteria: [],
        assignment_id: assignment.id,
        status: "todo" as const,
      };
      const item: WorkItem =
        n === 1
          ? { ...common, kind: "produce", template_key: "development" }
          : {
              ...common,
              kind: "verify",
              max_review_rounds: 3,
              ...(n === 2
                ? {
                    template_key: "code_review",
                    target_work_item_id: "W-1" as never,
                  }
                : { template_key: "pm_acceptance" }),
            };
      tx.work_items.put(project_id, item);
      tx.runs.put(project_id, {
        id: tx.ids.next(project_id, "run"),
        assignment_id: assignment.id,
        trigger_event_id: tx.ids.nextEventId(),
        kind: "initial",
        status: "running",
        role_version: 1,
        model: "fixture-model",
        agent_cli_version: "1",
        outcome: null,
        summary: "",
      });
    }
  });
  for (let n = 1; n <= 3; n++)
    tokens.push(
      store.issueToken({
        id: `token-${n}`,
        project_id,
        assignment_id: `A-${n}` as never,
        role: { role_version: 1, allowed_tools: allowed },
      }).token,
    );
  server = await startMcpServer({
    store,
    log: logger.log,
    clock: { now: () => NOW },
  });
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await server.close();
  store.close();
});
const delivery = {
  idempotency_key: "delivery-1",
  work_item_id: "W-1",
  kind: "code",
  summary: "Private fixture summary",
  subject: { kind: "git_head", value: "a".repeat(40) },
  requested_verifiers: ["W-2"],
};
const review = {
  idempotency_key: "review-1",
  delivery_id: "D-1",
  target_sha: delivery.subject.value,
  kind: "code",
  issues: [],
};
const call = (client: Client, name: string, args: object) =>
  client.callTool({ name, arguments: { ...args } });
const code = (result: Awaited<ReturnType<typeof call>>) =>
  (result.structuredContent as { error?: { code: string } })?.error?.code;
const counts = () =>
  store.uow.read((tx) => ({
    deliveries: tx.deliveries.list(project_id).length,
    reviews: tx.reviews.list(project_id).length,
    events: tx.events.listAfter(project_id, card_id, 0).length,
    timeline: tx.timeline.list(project_id).length,
  }));

test("delivery, review and completion use the real MCP transport, and replays survive later state changes", async () => {
  const coder = await connect();
  const reviewer = await connect(1);
  const pm = await connect(2);
  const listed = await coder.listTools();
  const schema = listed.tools.find(
    (t) => t.name === "submit_delivery",
  )?.inputSchema;
  expect(schema?.required).toContain("idempotency_key");
  const first = await call(coder, "submit_delivery", {
    ...delivery,
    author: "human",
    evidence: ["forged"],
  });
  expect(first.isError).not.toBe(true);
  expect(first.structuredContent).toMatchObject({
    id: "D-1",
    status: "submitted",
    evidence: [],
  });
  const passed = await call(reviewer, "submit_review", {
    ...review,
    verdict: "reject",
  });
  expect(passed.structuredContent).toMatchObject({ verdict: "pass" });
  expect(counts()).toEqual({
    deliveries: 1,
    reviews: 1,
    events: 2,
    timeline: 2,
  });
  expect(
    (await call(coder, "submit_delivery", delivery)).structuredContent,
  ).toEqual(first.structuredContent);
  expect(
    (await call(reviewer, "submit_review", review)).structuredContent,
  ).toEqual(passed.structuredContent);
  const completion = await call(coder, "submit_delivery", {
    ...delivery,
    idempotency_key: "complete",
    kind: "card_completion",
    requested_verifiers: ["W-3"],
  });
  expect(completion.isError).not.toBe(true);
  expect(
    (
      await call(pm, "submit_review", {
        ...review,
        delivery_id: "D-2",
        kind: "product",
      })
    ).isError,
  ).not.toBe(true);
  expect(
    store.uow.read((tx) => tx.cards.get(project_id, card_id)?.status),
  ).toBe("done");
  expect(
    (await call(coder, "submit_delivery", delivery)).structuredContent,
  ).toEqual(first.structuredContent);
  expect(counts()).toEqual({
    deliveries: 2,
    reviews: 2,
    events: 4,
    timeline: 4,
  });
  expect(store.uow.read((tx) => tx.timeline.list(project_id)[0]?.author)).toBe(
    "assignment:A-1",
  );
  const log = JSON.stringify(logger.entries);
  expect(log).not.toContain(delivery.summary);
  for (const token of tokens) expect(log).not.toContain(token);
});

test.each([
  ["not_found", { work_item_id: "W-999" }],
  ["validation_failed", { idempotency_key: "" }],
  ["invariant_violation", { requested_verifiers: ["W-1"] }],
])("MCP preserves %s for rejected deliveries", async (expected, patch) => {
  expect(
    code(
      await call(await connect(), "submit_delivery", {
        ...delivery,
        ...(patch as object),
      }),
    ),
  ).toBe(expected);
  expect(counts()).toEqual({
    deliveries: 0,
    reviews: 0,
    events: 0,
    timeline: 0,
  });
});

test("MCP preserves unauthorized, stale_target, forbidden_tool and idempotency_conflict", async () => {
  const coder = await connect();
  const reviewer = await connect(1);
  await call(coder, "submit_delivery", delivery);
  expect(code(await call(coder, "submit_review", review))).toBe("unauthorized");
  expect(
    code(
      await call(reviewer, "submit_review", {
        ...review,
        target_sha: "b".repeat(40),
      }),
    ),
  ).toBe("stale_target");
  expect(
    code(
      await call(coder, "submit_delivery", { ...delivery, summary: "Changed" }),
    ),
  ).toBe("idempotency_conflict");
  expect(
    code(
      await call(coder, "submit_review", {
        ...review,
        idempotency_key: delivery.idempotency_key,
      }),
    ),
  ).toBe("idempotency_conflict");
  const restricted = store.issueToken({
    project_id,
    assignment_id: "A-1" as never,
    role: { role_version: 1, allowed_tools: ["get_card"] },
  });
  tokens.push(restricted.token);
  const client = await connect(3);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
    "get_card",
  ]);
  expect(code(await call(client, "submit_delivery", delivery))).toBe(
    "forbidden_tool",
  );
});

test("a domain failure after allocating a Review ID rolls back counters and leaves the key reusable", async () => {
  const coder = await connect();
  const reviewer = await connect(1);
  await call(coder, "submit_delivery", delivery);
  const setStatus = (status: "blocked" | "delivered") =>
    store.uow.run((tx) => {
      const item = tx.work_items.get(project_id, "W-1" as never);
      if (item?.kind !== "produce") throw new Error("Missing producer");
      tx.work_items.put(project_id, { ...item, status });
    });
  setStatus("blocked");
  const rejected = {
    ...review,
    issues: [
      {
        severity: "major",
        description: "Bug",
        must_fix: true,
        pre_existing: false,
      },
    ],
  };
  expect(code(await call(reviewer, "submit_review", rejected))).toBe(
    "illegal_transition",
  );
  expect(counts()).toEqual({
    deliveries: 1,
    reviews: 0,
    events: 1,
    timeline: 1,
  });
  setStatus("delivered");
  expect(
    (await call(reviewer, "submit_review", rejected)).structuredContent,
  ).toMatchObject({ id: "V-1", verdict: "reject" });
});

test("a late persistence error rolls back entities, events, IDs and the idempotency entry", async () => {
  const coder = await connect();
  store.database.exec(
    "CREATE TRIGGER fail_timeline BEFORE INSERT ON timeline BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END",
  );
  expect((await call(coder, "submit_delivery", delivery)).isError).toBe(true);
  expect(counts()).toEqual({
    deliveries: 0,
    reviews: 0,
    events: 0,
    timeline: 0,
  });
  expect(
    store.uow.read(
      (tx) => tx.work_items.get(project_id, "W-1" as never)?.status,
    ),
  ).toBe("todo");
  store.database.exec("DROP TRIGGER fail_timeline");
  expect(
    (await call(coder, "submit_delivery", delivery)).structuredContent,
  ).toMatchObject({ id: "D-1" });
});

test.each(["state", "token", "reject"])(
  "preflight runs outside a transaction and %s is checked before committing",
  async (change) => {
    await restart({
      verify: async () => {
        store.uow.run((tx) => {
          if (change !== "state") return;
          const assignment = tx.assignments.get(project_id, "A-1" as never);
          if (!assignment) throw new Error("Missing assignment");
          tx.assignments.put(project_id, { ...assignment, branch: "changed" });
        });
        if (change === "token") store.revokeToken("token-1");
        return change === "reject"
          ? {
              ok: false,
              error: {
                code: "validation_failed",
                message: "Verifier rejected",
              },
            }
          : { ok: true, value: [] };
      },
    });
    expect(code(await call(await connect(), "submit_delivery", delivery))).toBe(
      change === "state"
        ? "stale_target"
        : change === "token"
          ? "unauthorized"
          : "validation_failed",
    );
    expect(counts()).toEqual({
      deliveries: 0,
      reviews: 0,
      events: 0,
      timeline: 0,
    });
  },
);

test("concurrent identical submissions commit once, and cached replay does not repeat preflight", async () => {
  let entered = 0;
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await restart({
    verify: async () => {
      if (++entered === 2) release();
      await barrier;
      return { ok: true, value: [] };
    },
  });
  const a = await connect();
  const b = await connect();
  const [first, second] = await Promise.all([
    call(a, "submit_delivery", delivery),
    call(b, "submit_delivery", delivery),
  ]);
  expect(first.isError).not.toBe(true);
  expect(second.structuredContent).toEqual(first.structuredContent);
  expect(counts()).toEqual({
    deliveries: 1,
    reviews: 0,
    events: 1,
    timeline: 1,
  });
  await call(a, "submit_delivery", delivery);
  expect(entered).toBe(2);
});
