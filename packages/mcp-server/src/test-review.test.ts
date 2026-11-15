import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { testReviewFixture } from "../../domain/src/commands/test-review/test-fixtures.js";
import { loadCommandState } from "./commands/execute.js";
import { startMcpServer } from "./server.js";

async function setup(proof = true) {
  const f = await testReviewFixture(3);
  if (!proof) f.disableProof();
  const next = (await f.deliver()).data;
  f.start();
  const store = Store.open({ dbPath: ":memory:" });
  store.createProject({ id: f.state.project_id });
  store.setTestReviewTrust(f.trust);
  store.uow.run((tx) => {
    for (const e of f.state.employees ?? []) tx.employees.put(e);
    for (const collection of [
      "cards",
      "work_items",
      "assignments",
      "runs",
      "deliveries",
      "reviews",
      "roles",
    ] as const)
      for (const entity of f.state[collection])
        (tx[collection].put as (p: string, e: unknown) => void)(
          f.state.project_id,
          entity,
        );
    for (const e of f.state.events) tx.events.append(f.state.project_id, e);
    const streams = new Map<string | undefined, number>();
    for (const e of f.state.events)
      streams.set(e.card_id, Math.max(streams.get(e.card_id) ?? 0, e.seq));
    for (const [card, max] of streams)
      for (let n = 0; n < max; n++)
        tx.ids.nextEventSequence(f.state.project_id, card);
    for (const [kind, collection] of [
      ["review", "reviews"],
      ["delivery", "deliveries"],
      ["run", "runs"],
    ] as const) {
      const max = Math.max(
        ...f.state[collection].map((e) => Number(e.id.slice(2))),
      );
      for (let n = 0; n < max; n++) tx.ids.next(f.state.project_id, kind);
    }
  });
  const token = store.issueToken({
    id: "mcp-fixture",
    project_id: f.state.project_id,
    assignment_id: "A-2",
    role: { role_version: 1, allowed_tools: ["submit_review"] },
  }).token;
  const server = await startMcpServer({
    store,
    deliveryVerifier: () => f.verifier,
    clock: f.io.clock,
    log: () => {},
  });
  const client = new Client({ name: "test-review", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const call = (extra: object = {}) =>
    client.callTool({
      name: "submit_review",
      arguments: {
        idempotency_key: "submit-incremental",
        delivery_id: next.id,
        target_sha: next.subject.value,
        kind: "code",
        issues: [],
        ...extra,
      },
    });
  return {
    f,
    next,
    store,
    client,
    call,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}
test("MCP consumes current host evidence and idempotently persists a fresh bound Review", async () => {
  const t = await setup();
  try {
    const result = await t.call();
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(await t.call()).toEqual(result);
    const state = t.store.uow.read((tx) =>
      loadCommandState(tx, t.f.state.project_id),
    );
    expect(
      state.reviews.filter((r) => r.delivery_id === t.next.id),
    ).toHaveLength(1);
    expect(
      state.reviews.find((r) => r.delivery_id === t.next.id)?.test_review,
    ).toEqual(t.next.test_review);
  } finally {
    await t.close();
  }
});
test("revocation between dispatch and MCP submission refuses the scoped conclusion", async () => {
  const t = await setup();
  try {
    t.f.revoke();
    const result = await t.call();
    expect(result.isError).toBe(true);
    expect(
      t.store.uow
        .read((tx) => tx.reviews.list(t.f.state.project_id))
        .filter((r) => r.delivery_id === t.next.id),
    ).toHaveLength(0);
  } finally {
    await t.close();
  }
});
test("tool parameters cannot manufacture a free review or replace host proof", async () => {
  const t = await setup(false);
  try {
    const result = await t.call({
      test_review: { authority: "forged", files: ["x.test.ts"] },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const review = t.store.uow
      .read((tx) => tx.reviews.list(t.f.state.project_id))
      .find((r) => r.delivery_id === t.next.id);
    expect(review?.test_review).toBeUndefined();
  } finally {
    await t.close();
  }
});
