import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Delivery,
  prepareRecheck,
  type RequestRecheckParams,
  recordMergeCheck,
  requestRecheck,
  type ToolName,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, vi } from "vitest";
import { recheckVerifier } from "../../domain/src/commands/request-recheck/test-fixtures.js";
import { now, value } from "../../domain/src/commands/test-fixtures.js";
import { seedReturnedRecheck } from "../test-support/request-recheck.js";
import { loadCommandState, persistEffect } from "./commands/execute.js";
import { startMcpServer } from "./server.js";

test("MCP registration, token scope, concurrent requests, rollback and restart preserve the one-group quota", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-recheck-"));
  let store = Store.open({ dataDir });
  const seeded = await seedReturnedRecheck(store);
  const { f, project } = seeded;
  const params: RequestRecheckParams = {
    card_id: f.card.id,
    reason: "Unrelated synthetic failure",
  };
  const read = () => store.uow.read((tx) => loadCommandState(tx, project));
  let releasePreparation: () => void = () => {};
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const baseVerifier = recheckVerifier();
  const verify = vi.fn(
    async (...args: Parameters<typeof baseVerifier.verify>) => {
      if (verify.mock.calls.length <= 2) {
        if (verify.mock.calls.length === 2) releasePreparation();
        await preparationGate;
      }
      return baseVerifier.verify(...args);
    },
  );
  const pin = vi.fn(async () => {});
  const boot = () =>
    startMcpServer({
      store,
      deliveryVerifier: () => ({ verify }),
      pinDelivery: pin,
      acknowledgeRuns: false,
      clock: { now: () => now },
      log: () => {},
    });
  let server = await boot();
  const clients: Client[] = [];
  const connect = async (
    assignment = f.coder,
    tools: readonly ToolName[] = ["submit_delivery", "request_recheck"],
  ) => {
    const token = store.issueToken({
      project_id: project,
      assignment_id: assignment.id,
      role: { role_version: assignment.role_version, allowed_tools: tools },
    }).token;
    const c = new Client({ name: "synthetic-recheck", version: "1" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(c);
    return c;
  };
  try {
    const initial = read();
    const proof = value(
      await prepareRecheck(initial, f.actor(f.coder), params, baseVerifier),
    );
    expect(() =>
      store.uow.run((tx) => {
        const effect = value(
          requestRecheck(
            loadCommandState(tx, project),
            f.actor(f.coder),
            params,
            proof,
            { clock: { now: () => now }, ids: tx.ids },
          ),
        );
        persistEffect(tx, project, effect);
        throw new Error("rollback recheck");
      }),
    ).toThrow("rollback recheck");
    expect(read().deliveries).toEqual(initial.deliveries);
    expect(read().events.filter((e) => e.type === "recheck_requested")).toEqual(
      [],
    );
    const a = await connect();
    expect((await a.listTools()).tools.map((t) => t.name)).toContain(
      "request_recheck",
    );
    const limited = await connect(f.coder, ["submit_delivery"]);
    expect((await limited.listTools()).tools.map((t) => t.name)).not.toContain(
      "request_recheck",
    );
    expect(
      (
        await limited.callTool({
          name: "request_recheck",
          arguments: { ...params, idempotency_key: "limited" },
        })
      ).isError,
    ).toBe(true);
    const reviewer = await connect(f.reviewer);
    const denied = await reviewer.callTool({
      name: "request_recheck",
      arguments: { ...params, idempotency_key: "denied" },
    });
    expect(denied.isError).toBe(true);
    expect(verify).not.toHaveBeenCalled();
    const b = await connect();
    const request = (c: Client, key: string) =>
      c.callTool({
        name: "request_recheck",
        arguments: { ...params, idempotency_key: key },
      });
    const results = await Promise.all([
      request(a, "first"),
      request(b, "second"),
    ]);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    const accepted = results[0]?.isError ? results[1] : results[0];
    const output = accepted?.structuredContent as unknown as {
      product: Delivery;
      completion: Delivery;
    };
    expect(output.completion).toMatchObject({
      status: "accepted",
      recheck_of: seeded.completion.id,
    });
    expect(pin.mock.calls).toHaveLength(2);
    const before = read();
    expect(
      before.events.filter((e) => e.type === "recheck_requested"),
    ).toHaveLength(1);
    expect(before.reviews).toEqual(f.state.reviews);
    const winningKey = results[0]?.isError ? "second" : "first";
    const verifiedCount = verify.mock.calls.length;
    expect((await request(a, winningKey)).structuredContent).toEqual(
      accepted?.structuredContent,
    );
    expect(verify).toHaveBeenCalledTimes(verifiedCount);
    // A rolled-back A1 failure leaves the entire new completion intact.
    const failure = (rollback: boolean) =>
      store.uow.run((tx) => {
        const system = { kind: "system" as const, project_id: project };
        const identity = {
          card_id: f.card.id,
          completion_id: output.completion.id,
          attempt_id: "after-recheck",
          candidate_sha: "b".repeat(40),
          tree_sha: "c".repeat(40),
        };
        for (const status of ["queued", "running", "failed"] as const) {
          const s = {
            ...loadCommandState(tx, project),
            project_settings: { merge_gate_enabled: true },
          };
          const effect = value(
            recordMergeCheck(
              s,
              system,
              status === "failed"
                ? {
                    ...identity,
                    status,
                    checks: [{ name: "test", status, exit_code: 1 }],
                    summary: "failed",
                    log_ref: "after-recheck.log",
                  }
                : { ...identity, status },
              { clock: { now: () => now }, ids: tx.ids },
            ),
          );
          persistEffect(tx, project, effect);
        }
        if (rollback) throw new Error("rollback");
      });
    expect(() => failure(true)).toThrow("rollback");
    expect(read().deliveries).toEqual(before.deliveries);
    failure(false);
    // Preserve the same running author in this synthetic second return.
    for (const c of clients.splice(0)) await c.close();
    await server.close();
    store.close();
    store = Store.open({ dataDir });
    server = await boot();
    const reopened = await connect();
    expect((await request(reopened, winningKey)).structuredContent).toEqual(
      accepted?.structuredContent,
    );
    const refused = await request(reopened, "after-restart");
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("已使用");
    expect(
      read().events.filter((e) => e.type === "recheck_requested"),
    ).toHaveLength(1);
  } finally {
    for (const c of clients) await c.close();
    await server.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
