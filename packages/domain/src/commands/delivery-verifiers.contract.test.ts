import { beforeEach, expect, test } from "vitest";
import {
  acknowledgeRun,
  createWorkItem,
  prepareDelivery,
  submitDelivery,
} from "../index.js";
import {
  actor,
  commit,
  dispatch,
  f,
  item,
  queue,
  setup,
} from "./launch/test-fixtures.js";
import { human, subject, value } from "./test-fixtures.js";

beforeEach(() => {
  setup();
  const run = commit(dispatch(commit(queue())));
  commit(acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io));
});
const params = () => ({
  work_item_id: item().id,
  kind: "code" as const,
  summary: "Ready",
  subject,
  requested_verifiers: [item(f.reviewer).id],
});
const verifier = { verify: async () => ({ ok: true as const, value: [] }) };
test("S8 invariant 11: invalid verifier diagnostics identify PM acceptance and non-verifier IDs", async () => {
  const pm = f.state.work_items.find((w) => w.template_key === "pm_acceptance");
  if (!pm) throw new Error("Missing acceptance item");
  const p = {
    ...params(),
    requested_verifiers: [item(f.reviewer).id, pm.id, item().id],
  };
  const prepared = await prepareDelivery(f.state, actor(), p, verifier);
  expect(prepared).toMatchObject({
    ok: false,
    error: {
      code: "invariant_violation",
      message: expect.stringContaining(`${pm.id}, ${item().id}`),
    },
  });
  const valid = value(
    await prepareDelivery(f.state, actor(), params(), verifier),
  );
  expect(submitDelivery(f.state, actor(), p, valid, f.io)).toMatchObject({
    ok: false,
    error: {
      code: "invariant_violation",
      message: expect.stringContaining(`${pm.id}, ${item().id}`),
    },
  });
  expect(f.state.deliveries).toEqual([]);
});
test("S8 invariant 11: missing required verifier diagnostics name the missing item", async () => {
  const required = commit(
    createWorkItem(
      f.state,
      human,
      {
        card_id: item().card_id,
        title: "Required test",
        kind: "verify",
        role_id: "reviewer",
        required: true,
        target_work_item_id: item().id,
        completion_criteria: ["Pass"],
      },
      f.io,
    ),
  );
  expect(
    await prepareDelivery(f.state, actor(), params(), verifier),
  ).toMatchObject({
    ok: false,
    error: {
      code: "invariant_violation",
      message: expect.stringContaining(required.id),
    },
  });
});
test("S8 invariants 11, 14: code requests its target verifier without PM completion acceptance", async () => {
  const p = params(),
    receipt = value(await prepareDelivery(f.state, actor(), p, verifier));
  const delivery = commit(submitDelivery(f.state, actor(), p, receipt, f.io));
  expect(delivery.requested_verifiers).toEqual([item(f.reviewer).id]);
});
