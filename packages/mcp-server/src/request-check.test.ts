import { prechecks, recordPrecheck } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { authenticate } from "./auth.js";
import { loadCommandState, persistEffect, unwrap } from "./commands/execute.js";
import { serverTools } from "./server.js";
import {
  acceptingVerifierFor,
  assignments,
  card_id,
  project_id,
  seedProject,
  workItems,
} from "./test-support.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
function fixture() {
  const store = Store.open({ dbPath: ":memory:" });
  stores.push(store);
  seedProject(store, {
    allowed_tools: ["request_check", "get_card", "get_check_log"],
  });
  store.uow.run((tx) => {
    tx.cards.put(project_id, {
      ...tx.cards.get(project_id, card_id)!,
      flow_version: 3,
    });
    tx.work_items.put(project_id, {
      ...workItems,
      kind: "produce",
      assignment_id: assignments.id,
    });
    tx.assignments.put(project_id, {
      ...assignments,
      scope: "work_item",
      work_item_id: workItems.id,
      branch: "agent/check",
      worktree_path: "/synthetic/private",
    });
  });
  const issued = store.issueToken({
    project_id,
    assignment_id: assignments.id,
    role: {
      role_version: 1,
      allowed_tools: ["request_check", "get_card", "get_check_log"],
    },
  });
  const auth = authenticate(store, issued.token);
  if (!auth.ok) throw new Error("No authentication");
  const context = {
    store,
    identity: auth.value,
    revalidateToken: () => {
      if (!store.verifyToken(issued.token)) throw new Error("Revoked");
    },
  };
  const head = vi.fn(async () => "a".repeat(40));
  const tools = serverTools({
    deliveryVerifier: acceptingVerifierFor,
    checkHead: () => ({ head }),
    checkLogReader: async () => ({
      text: "[REDACTED] FAIL fixture.test.ts",
      next_offset: 32,
      size: 32,
    }),
  });
  const tool = tools.find((t) => t.name === "request_check")!;
  return { store, context, head, tools, tool, issued };
}
test("strict self-service schema rejects caller SHA/path/executor and removes the PM delivery-precheck tool", () => {
  const f = fixture();
  const args = { work_item_id: workItems.id, idempotency_key: "request-1" };
  expect(f.tool.input.safeParse(args).success).toBe(true);
  for (const extra of [
    { sha: "a".repeat(40) },
    { path: "/secret" },
    { executor: "ci" },
    { assignment_id: "A-2" },
  ])
    expect(f.tool.input.safeParse({ ...args, ...extra }).success).toBe(false);
  expect(f.tools.some((t) => t.name === "request_delivery_precheck")).toBe(
    false,
  );
});
test("idempotent request persists once, separate concurrent request refuses, get_card and get_check_log expose only bounded public data", async () => {
  const f = fixture();
  const args = { work_item_id: workItems.id, idempotency_key: "request-1" };
  const first = (await f.tool.handler(args, f.context)) as {
    attempt_id: string;
  };
  expect(await f.tool.handler(args, f.context)).toEqual(first);
  expect(f.head).toHaveBeenCalledTimes(1);
  await expect(
    f.tool.handler({ ...args, idempotency_key: "request-2" }, f.context),
  ).rejects.toThrow();
  f.store.uow.run((tx) => {
    const state = loadCommandState(tx, project_id);
    const check = prechecks(state.events)[0]!;
    persistEffect(
      tx,
      project_id,
      unwrap(
        recordPrecheck(
          state,
          { kind: "system", project_id },
          { ...check, status: "environment_failed", summary: "日志环境故障" },
          { ids: tx.ids, clock: { now: () => "2026-01-02T00:00:00Z" } },
        ),
      ),
    );
  });
  const view = await f.tools
    .find((t) => t.name === "get_card")!
    .handler({ card_id }, f.context);
  expect(JSON.stringify(view)).toContain(first.attempt_id);
  expect(JSON.stringify(view)).not.toContain("/synthetic/private");
  const log = await f.tools
    .find((t) => t.name === "get_check_log")!
    .handler({ card_id, attempt_id: first.attempt_id }, f.context);
  expect(log).toMatchObject({
    text: expect.stringContaining("FAIL fixture.test.ts"),
  });
});
test("revocation during HEAD IO rolls back the request", async () => {
  const f = fixture();
  f.head.mockImplementation(async () => {
    f.store.revokeToken(f.issued.id);
    return "a".repeat(40);
  });
  await expect(
    f.tool.handler(
      { work_item_id: workItems.id, idempotency_key: "request-1" },
      f.context,
    ),
  ).rejects.toThrow();
  expect(
    f.store.uow.read((tx) =>
      prechecks(tx.events.listAfter(project_id, card_id, 0)),
    ),
  ).toEqual([]);
});
