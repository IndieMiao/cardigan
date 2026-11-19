import type { Assignment, DeliveryVerifier, WorkItem } from "@cardigan/domain";
import { systemCompleteCard } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadCommandState, persistEffect, unwrap } from "./commands/execute.js";
import { memoryLogger } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";
import {
  acceptingVerifier,
  acceptingVerifierFor,
  assignments,
  card_id,
  NOW,
  project_id,
  serverCard,
} from "./test-support.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const allowed = [
  "submit_delivery",
  "submit_review",
  "withdraw_review",
  "get_card",
] as const;
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
  server = await startMcpServer({
    store,
    deliveryVerifier: () => deliveryVerifier,
    log: logger.log,
  });
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
    deliveryVerifier: acceptingVerifierFor,
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

test("withdraw_review persists the audit marker and replay is idempotent over MCP", async () => {
  const coder = await connect();
  const reviewer = await connect(1);
  const pm = await connect(2);
  expect((await reviewer.listTools()).tools.map((tool) => tool.name)).toContain(
    "withdraw_review",
  );
  await call(coder, "submit_delivery", delivery);
  await call(reviewer, "submit_review", review);
  const params = {
    idempotency_key: "withdraw-1",
    work_item_id: "W-2",
    rationale: "需要重新核查",
  };
  const before = counts();
  expect(code(await call(pm, "withdraw_review", params))).toBe("unauthorized");
  expect(code(await call(coder, "withdraw_review", params))).toBe(
    "unauthorized",
  );
  expect(
    (await call(reviewer, "withdraw_review", { ...params, rationale: "  " }))
      .isError,
  ).toBe(true);
  expect(counts()).toEqual(before);
  const result = await call(reviewer, "withdraw_review", {
    ...params,
    assignment_id: "A-1",
    author: "human",
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    verdict: "pass",
    withdrawn: { at: NOW, rationale: params.rationale },
  });
  const after = counts();
  expect(after).toEqual({
    ...before,
    events: before.events + 1,
    timeline: before.timeline + 1,
  });
  expect(
    (await call(reviewer, "withdraw_review", params)).structuredContent,
  ).toEqual(result.structuredContent);
  expect(
    code(
      await call(reviewer, "withdraw_review", {
        ...params,
        idempotency_key: "withdraw-again",
      }),
    ),
  ).toBe("illegal_transition");
  expect(counts()).toEqual(after);
  expect(
    store.uow.read(
      (tx) => tx.work_items.get(project_id, "W-2" as never)?.status,
    ),
  ).toBe("ready");
  expect(store.uow.read((tx) => tx.reviews.list(project_id))).toMatchObject([
    { withdrawn: { rationale: params.rationale } },
  ]);
  const card = await call(reviewer, "get_card", { card_id });
  expect(card.structuredContent).toMatchObject({
    reviews: [{ withdrawn: { rationale: params.rationale } }],
    review_matrix: [{ verdict: null }],
  });
  expect(
    store.uow.read((tx) => tx.timeline.list(project_id).at(-1)?.author),
  ).toBe("assignment:A-2");
});

/**
 * §4.4: a produce work item that nothing verifies is accepted on delivery, so
 * the tool must accept an empty verifier list. The domain keeps refusing it
 * whenever a verifier exists.
 */
test("§4.4: an unreviewed work item is delivered over MCP with no verifiers, and accepted", async () => {
  // Drop the only verifier that targets W-1 (the fixture's code review item).
  store.uow.run((tx) => {
    const verifier = tx.work_items.get(project_id, "W-2" as never);
    if (verifier === undefined) throw new Error("missing fixture verifier");
    const { target_work_item_id: _target, ...rest } = verifier;
    tx.work_items.put(project_id, rest as WorkItem);
  });
  const coder = await connect();

  const result = await call(coder, "submit_delivery", {
    ...delivery,
    requested_verifiers: [],
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    status: "accepted",
    requested_verifiers: [],
  });

  const after = store.uow.read((tx) => ({
    produced: tx.work_items.get(project_id, "W-1" as never),
    acceptedEvent: tx.events
      .listAfter(project_id, card_id, 0)
      .some((event) => event.type === "delivery_accepted"),
  }));
  expect(after.produced?.status).toBe("accepted");
  expect(after.acceptedEvent).toBe(true);
});

test("§4.4: with a verifier present, an empty verifier list is refused", async () => {
  const coder = await connect();
  const result = await call(coder, "submit_delivery", {
    ...delivery,
    idempotency_key: "delivery-empty",
    requested_verifiers: [],
  });
  expect(code(result)).toBe("validation_failed");
  expect(store.uow.read((tx) => tx.deliveries.list(project_id))).toEqual([]);
});

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
    plain_summary: TEST_PLAIN_SUMMARY,
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
  ).toBe("awaiting_merge");
  expect(
    (await call(coder, "submit_delivery", delivery)).structuredContent,
  ).toEqual(first.structuredContent);
  expect(counts()).toEqual({
    deliveries: 2,
    reviews: 2,
    events: 5,
    timeline: 5,
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

test("must-fix impact and linked UX acceptance survive the MCP write and read paths", async () => {
  const coder = await connect();
  const reviewer = await connect(1);
  await call(coder, "submit_delivery", delivery);
  const issue = {
    severity: "major",
    description: "Duplicated success hint",
    must_fix: true,
    pre_existing: false,
  };
  const params = { ...review, issues: [issue], followup_card_id: "C-2" };
  expect(code(await call(reviewer, "submit_review", params))).toBe(
    "validation_failed",
  );
  store.uow.run((tx) =>
    tx.cards.put(project_id, { ...serverCard, id: "C-2" as never }),
  );
  const result = await call(reviewer, "submit_review", {
    ...params,
    issues: [{ ...issue, impact: "ux_only" }],
  });
  expect(result.structuredContent).toMatchObject({
    verdict: "conditional",
    followup_card_id: "C-2",
    issues: [{ impact: "ux_only" }],
  });
  expect(
    (await call(reviewer, "get_card", { card_id })).structuredContent,
  ).toMatchObject({
    reviews: [
      {
        verdict: "conditional",
        followup_card_id: "C-2",
        issues: [{ impact: "ux_only" }],
      },
    ],
  });
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
        impact: "functional" as const,
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

test("the request's project selects the verifier, and the pin follows the commit", async () => {
  const seen: string[] = [];
  const pinned: { project_id: string; delivery_id: string; sha: string }[] = [];
  await server.close();
  server = await startMcpServer({
    store,
    deliveryVerifier: (id) => {
      // A token can only carry one project; the verifier must still be chosen
      // by the request's project, never by caller-supplied parameters.
      seen.push(id);
      return acceptingVerifierFor(id);
    },
    pinDelivery: async (request) => {
      pinned.push(request);
    },
    log: logger.log,
    clock: { now: () => NOW },
  });
  const result = await call(await connect(), "submit_delivery", delivery);
  expect(result.isError).not.toBe(true);
  expect(seen).toEqual([project_id]);
  expect(pinned).toEqual([
    {
      project_id,
      delivery_id: "D-1",
      sha: delivery.subject.value,
    },
  ]);
});

test("a failed pin keeps the committed delivery and only logs", async () => {
  await server.close();
  server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    pinDelivery: async () => {
      throw new Error("central repository unavailable");
    },
    log: logger.log,
    clock: { now: () => NOW },
  });
  const result = await call(await connect(), "submit_delivery", delivery);
  expect(result.structuredContent).toMatchObject({
    id: "D-1",
    status: "submitted",
  });
  expect(logger.entries).toContainEqual(
    expect.objectContaining({
      tool: "submit_delivery",
      code: "delivery_pin_failed",
    }),
  );
  expect(counts()).toEqual({
    deliveries: 1,
    reviews: 0,
    events: 1,
    timeline: 1,
  });
});

test("a non-Git delivery is never pinned", async () => {
  const pinned: unknown[] = [];
  await server.close();
  server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    pinDelivery: async (request) => {
      pinned.push(request);
    },
    log: logger.log,
    clock: { now: () => NOW },
  });
  const result = await call(await connect(), "submit_delivery", {
    ...delivery,
    idempotency_key: "delivery-doc",
    kind: "doc",
    subject: { kind: "doc_version", value: "v1" },
  });
  expect(result.isError).not.toBe(true);
  expect(pinned).toEqual([]);
});

test("same-source redelivery over MCP reuses one real review across concurrent requests and idempotent replay", async () => {
  await restart({
    verify: async (subject) => ({
      ok: true,
      value: [
        {
          kind: "commit",
          details: { sha: subject.value, tree_sha: "c".repeat(40) },
        },
      ],
    }),
  });
  const coder = await connect();
  const reviewer = await connect(1);
  expect((await call(coder, "submit_delivery", delivery)).isError).not.toBe(
    true,
  );
  expect((await call(reviewer, "submit_review", review)).isError).not.toBe(
    true,
  );
  const original = store.uow.read((tx) => tx.reviews.list(project_id)[0]);
  const requests = ["same-source-a", "same-source-b"].map((key) => ({
    ...delivery,
    idempotency_key: key,
  }));
  const results = await Promise.all(
    requests.map((p) => call(coder, "submit_delivery", p)),
  );
  for (const result of results) {
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "accepted",
      reused_reviews: [original?.id],
    });
  }
  expect(store.uow.read((tx) => tx.reviews.list(project_id))).toEqual([
    original,
  ]);
  const after = counts();
  expect(
    (await call(coder, "submit_delivery", requests[1] ?? {})).structuredContent,
  ).toEqual(results[1]?.structuredContent);
  expect(counts()).toEqual(after);
  const detail = await call(reviewer, "get_card", { card_id });
  expect(detail.structuredContent).toMatchObject({
    review_matrix: expect.arrayContaining([
      expect.objectContaining({
        delivery_id: "D-3",
        verdict: "pass",
        reused_from: { review_id: original?.id, delivery_id: "D-1" },
      }),
    ]),
  });
  expect(
    (
      await call(reviewer, "withdraw_review", {
        idempotency_key: "withdraw-reused",
        work_item_id: "W-2",
        rationale: "重新核查",
      })
    ).isError,
  ).not.toBe(true);
  expect(
    (await call(reviewer, "get_card", { card_id })).structuredContent,
  ).toMatchObject({
    review_matrix: expect.arrayContaining([
      expect.objectContaining({ delivery_id: "D-3", verdict: null }),
    ]),
  });
});

test("flow 5 late review is atomic and idempotent over concurrent MCP requests", async () => {
  store.uow.run((tx) => {
    tx.cards.put(project_id, { ...serverCard, flow_version: 5 });
    const item = tx.work_items.get(project_id, "W-3" as never);
    if (item?.kind !== "verify") throw new Error("Missing parallel verifier");
    tx.work_items.put(project_id, {
      ...item,
      template_key: "parallel",
      target_work_item_id: "W-1" as never,
    });
  });
  const coder = await connect();
  const reviewer = await connect(1);
  const parallel = await connect(2);
  expect(
    (
      await call(coder, "submit_delivery", {
        ...delivery,
        requested_verifiers: ["W-2", "W-3"],
      })
    ).isError,
  ).not.toBe(true);
  expect(
    (
      await call(reviewer, "submit_review", {
        ...review,
        issues: [
          {
            severity: "major",
            description: "Bug",
            impact: "functional" as const,
            must_fix: true,
            pre_existing: false,
          },
        ],
      })
    ).isError,
  ).not.toBe(true);
  const args = { ...review, idempotency_key: "parallel-late" };
  const results = await Promise.all([
    call(parallel, "submit_review", args),
    call(parallel, "submit_review", args),
  ]);
  expect(results[0]?.isError).not.toBe(true);
  expect(results[0]?.structuredContent).toEqual(results[1]?.structuredContent);
  expect(counts().reviews).toBe(2);
  expect(
    store.uow.read((tx) => tx.deliveries.get(project_id, "D-1" as never))
      ?.status,
  ).toBe("rejected");
  const before = counts();
  await restart(acceptingVerifier);
  const reconnected = await connect(2);
  const reconnectedCoder = await connect();
  expect(
    (await call(reconnected, "submit_review", args)).structuredContent,
  ).toEqual(results[0]?.structuredContent);
  expect(counts()).toEqual(before);
  expect(
    code(
      await call(reconnected, "submit_review", {
        ...args,
        idempotency_key: "duplicate-new-key",
      }),
    ),
  ).toBe("illegal_transition");
  expect(
    (
      await call(reconnectedCoder, "submit_delivery", {
        ...delivery,
        idempotency_key: "new-delivery",
        requested_verifiers: ["W-2", "W-3"],
      })
    ).isError,
  ).not.toBe(true);
  expect(
    code(
      await call(reconnected, "submit_review", {
        ...args,
        idempotency_key: "stale-late",
      }),
    ),
  ).toBe("stale_target");
});

test.each(["review-first", "delivery-first"] as const)(
  "new delivery preparation racing a late review uses transaction order: %s",
  async (order) => {
    store.uow.run((tx) => {
      tx.cards.put(project_id, { ...serverCard, flow_version: 5 });
      const item = tx.work_items.get(project_id, "W-3" as never);
      if (item?.kind !== "verify") throw new Error("Missing verifier");
      tx.work_items.put(project_id, {
        ...item,
        template_key: "parallel",
        target_work_item_id: "W-1" as never,
      });
    });
    const initialCoder = await connect();
    const initialReviewer = await connect(1);
    const params = { ...delivery, requested_verifiers: ["W-2", "W-3"] };
    expect(
      (await call(initialCoder, "submit_delivery", params)).isError,
    ).not.toBe(true);
    expect(
      (
        await call(initialReviewer, "submit_review", {
          ...review,
          issues: [
            {
              severity: "major",
              description: "Bug",
              impact: "functional" as const,
              must_fix: true,
              pre_existing: false,
            },
          ],
        })
      ).isError,
    ).not.toBe(true);
    let enter: () => void = () => {};
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await restart({
      verify: async () => {
        enter();
        await gate;
        return { ok: true, value: [] };
      },
    });
    const coder = await connect();
    const parallel = await connect(2);
    const pending = call(coder, "submit_delivery", {
      ...params,
      idempotency_key: "racing-delivery",
    });
    await entered;
    try {
      if (order === "delivery-first") {
        release();
        await pending;
      }
      const late = await call(parallel, "submit_review", {
        ...review,
        idempotency_key: "racing-review",
      });
      if (order === "review-first") expect(late.isError).not.toBe(true);
      else expect(code(late)).toBe("stale_target");
    } finally {
      release();
      expect((await pending).isError).not.toBe(true);
    }
    expect(counts().reviews).toBe(order === "review-first" ? 2 : 1);
    expect(
      store.uow.read((tx) => tx.deliveries.get(project_id, "D-2" as never))
        ?.status,
    ).toBe("submitted");
    expect(
      code(
        await call(parallel, "submit_review", {
          ...review,
          idempotency_key: "racing-stale",
        }),
      ),
    ).toBe("stale_target");
  },
);

test("B3a: MCP accepts future product plain summaries, refuses manual completion, and exposes system provenance", async () => {
  store.uow.run((tx) =>
    tx.cards.put(project_id, { ...serverCard, flow_version: 5 }),
  );
  const coder = await connect();
  const reviewer = await connect(1);
  expect(
    (
      await call(coder, "submit_delivery", {
        ...delivery,
        plain_summary: TEST_PLAIN_SUMMARY,
      })
    ).isError,
  ).not.toBe(true);
  expect((await call(reviewer, "submit_review", review)).isError).not.toBe(
    true,
  );
  expect(
    code(
      await call(coder, "submit_delivery", {
        ...delivery,
        idempotency_key: "manual-completion",
        kind: "card_completion",
        plain_summary: TEST_PLAIN_SUMMARY,
        requested_verifiers: ["W-3"],
      }),
    ),
  ).toBe("unauthorized");
  const completion = store.uow.run((tx) => {
    const effect = unwrap(
      systemCompleteCard(
        loadCommandState(tx, project_id),
        { kind: "system", project_id },
        { card_id },
        { clock: { now: () => NOW }, ids: tx.ids },
      ),
    );
    persistEffect(tx, project_id, effect);
    return effect.data;
  });
  expect(completion?.system_completion?.products).toMatchObject([
    { delivery_id: "D-1", plain_summary: TEST_PLAIN_SUMMARY },
  ]);
  const card = (await call(coder, "get_card", { card_id }))
    .structuredContent as { deliveries: Record<string, unknown>[] };
  expect(
    card.deliveries.find((v) => v.kind === "card_completion"),
  ).toMatchObject({
    author_display: "系统",
    author: "system",
    author_role: null,
    employee: null,
    plain_summary: TEST_PLAIN_SUMMARY,
    system_completion: { version: 1 },
  });
});
