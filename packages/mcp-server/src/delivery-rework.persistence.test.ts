import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Decision,
  recordDecision,
  withdrawReview,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { mergeFixture } from "../../domain/src/commands/merge/test-fixtures.js";
import { human, now, value } from "../../domain/src/commands/test-fixtures.js";
import { authenticate } from "./auth.js";
import { deliveryTools } from "./commands/delivery-tools.js";
import { loadCommandState, persistEffect } from "./commands/execute.js";
import { visibleTools } from "./tools/types.js";

const missing = (): never => {
  throw new Error("Missing fixture");
};

test("human return rolls back as one effect, survives reconnect, and cannot replay under another key", async () => {
  const f = mergeFixture();
  const { product } = await f.accept();
  const review =
    f.state.reviews.find((r) => r.delivery_id === product.id) ?? missing();
  f.commit(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      { work_item_id: review.work_item_id, rationale: "New requirement" },
      f.io,
    ),
  );
  const dataDir = mkdtempSync(join(tmpdir(), "cg-rework-"));
  const store = Store.open({ dataDir });
  const other = Store.open({ dataDir });
  const project = f.state.project_id;
  try {
    store.createProject({ id: project });
    store.uow.run((tx) => {
      for (const v of f.state.cards) tx.cards.put(project, v);
      for (const v of f.state.work_items) tx.work_items.put(project, v);
      for (const v of f.state.assignments) tx.assignments.put(project, v);
      for (const v of f.state.runs) tx.runs.put(project, v);
      for (const v of f.state.deliveries) tx.deliveries.put(project, v);
      for (const v of f.state.reviews) tx.reviews.put(project, v);
      for (const v of f.state.decisions) tx.decisions.put(project, v);
      for (const v of f.state.roles) tx.roles.put(project, v);
      for (const v of f.state.events) tx.events.append(project, v);
      for (const stream of new Set(
        f.state.events.map((e) => e.card_id ?? ""),
      )) {
        store.database
          .prepare(
            "INSERT INTO event_counters (project_id, stream, seq) VALUES (?, ?, ?) ON CONFLICT(project_id, stream) DO UPDATE SET seq = excluded.seq",
          )
          .run(
            project,
            stream,
            Math.max(
              ...f.state.events
                .filter((e) => (e.card_id ?? "") === stream)
                .map((e) => e.seq),
            ),
          );
      }
    });
    const read = () => other.uow.read((tx) => loadCommandState(tx, project));
    const params = {
      work_item_id: product.work_item_id,
      delivery_id: product.id,
      target_sha: product.subject.value,
      review_id: review.id,
      rationale: "Return exact target",
    };
    const { work_item_id: _work, ...base } = f.pm;
    const ops = {
      ...base,
      id: "A-900" as const,
      scope: "standing" as const,
      standing_mode: "ops" as const,
    };
    store.uow.run((tx) => tx.assignments.put(project, ops));
    const token = store.issueToken({
      project_id: project,
      assignment_id: ops.id,
      role: {
        role_version: ops.role_version,
        allowed_tools: ["request_delivery_rework"],
      },
    }).token;
    const identity = value(authenticate(store, token));
    const tool = deliveryTools({
      deliveryVerifier: () => ({
        verify: async () => ({ ok: true as const, value: [] }),
      }),
    }).find((t) => t.name === "request_delivery_rework");
    if (!tool) throw new Error("Missing request tool");
    const inputRequest = {
      ...params,
      idempotency_key: "request-current-rework",
    };
    const q = (await tool.handler(inputRequest, {
      store,
      identity,
    })) as Decision;
    expect(await tool.handler(inputRequest, { store, identity })).toEqual(q);
    expect(
      read().events.filter(
        (e) =>
          e.type === "decision_requested" &&
          (e.payload as { decision_id?: string }).decision_id === q.id,
      ),
    ).toHaveLength(1);
    const before = read();
    const input = {
      decision_id: q.id,
      option: "return_for_rework",
      rationale: "Confirm",
      raw_quote: "Confirm",
    };
    const execute = (rollback: boolean) =>
      store.uow.run((tx) => {
        const effect = value(
          recordDecision(loadCommandState(tx, project), human, input, {
            ids: tx.ids,
            clock: { now: () => now },
          }),
        );
        persistEffect(tx, project, effect);
        if (rollback) throw new Error("rollback");
      });
    expect(() => execute(true)).toThrow("rollback");
    expect(read()).toEqual(before);
    execute(false);
    expect(
      read().decisions.find((v) => v.id === q.id)?.resolution?.resolved_by,
    ).toBe("human");
    expect(read().deliveries.every((v) => v.status === "superseded")).toBe(
      true,
    );
    expect(() => execute(false)).toThrow();
    expect(
      read().events.filter((e) => e.type === "merge_changes_requested"),
    ).toHaveLength(1);
    expect(read().reviews).toEqual(before.reviews);
  } finally {
    other.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("request tool is visible only to Ops and rejects incomplete inputs", async () => {
  const tools = deliveryTools({
    deliveryVerifier: () => ({
      verify: async () => ({ ok: true as const, value: [] }),
    }),
  });
  const tool =
    tools.find((t) => t.name === "request_delivery_rework") ?? missing();
  for (const assignment of [
    { scope: "work_item", role_id: "pm" },
    { scope: "standing", role_id: "pm", standing_mode: "office" },
    { scope: "standing", role_id: "host_ops" },
  ])
    expect(visibleTools([tool], [tool.name], assignment)).toEqual([]);
  expect(
    visibleTools([tool], [tool.name], {
      scope: "standing",
      role_id: "pm",
      standing_mode: "ops",
    }),
  ).toEqual([tool]);
  expect(
    tool.input.safeParse({
      work_item_id: "W-1",
      delivery_id: "D-1",
      review_id: "V-1",
      target_sha: "abc",
      rationale: "reason",
      idempotency_key: "rework",
    }).success,
  ).toBe(false);
});
