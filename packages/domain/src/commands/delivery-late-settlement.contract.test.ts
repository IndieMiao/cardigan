/**
 * C-847: Git verification of a large repository can outlast the client's
 * tool timeout. The host keeps verifying and settles the delivery later
 * ("processing"); the same call repeated meanwhile joins it. These contracts
 * pin what the settlement may do once the verification is done:
 * - unchanged state (the caller only waited or read): it registers;
 * - the caller changed state meanwhile (finished its Run, started another,
 *   reported a blocker): it is refused with a reason, never registered
 *   against the changed state, and a fresh submission in the current Run
 *   still works.
 */
import { beforeEach, expect, test } from "vitest";
import { reportBlocker } from "./coordination.js";
import type { CommandState } from "./core.js";
import {
  prepareDelivery,
  type SubmitDeliveryParams,
  submitDelivery,
  type VerifiedDelivery,
} from "./delivery.js";
import { finishRun } from "./runtime.js";
import {
  actor,
  apply,
  fixture,
  id,
  run as makeRun,
  ports,
  subject,
  value,
} from "./test-fixtures.js";

const work = id("work_item", 1);
const params: SubmitDeliveryParams = {
  work_item_id: work,
  kind: "code",
  summary: "Ready",
  subject,
  requested_verifiers: [id("work_item", 2)],
};
let io = ports(),
  state: CommandState = fixture(),
  verifications = 0;
beforeEach(() => {
  io = ports();
  state = fixture();
  verifications = 0;
});
/** The slow part: runs once per verification, before any transaction. */
async function verify(): Promise<VerifiedDelivery> {
  return value(
    await prepareDelivery(state, actor(), params, {
      verify: async () => {
        verifications++;
        return {
          ok: true,
          value: [{ kind: "commit", details: { sha: subject.value } }],
        };
      },
    }),
  );
}
const settle = (proof: VerifiedDelivery) =>
  submitDelivery(state, actor(), params, proof, io);
const item = () => state.work_items.find((w) => w.id === work);

test("processing, then a repeated call: a verification done earlier registers once state is unchanged", async () => {
  const proof = await verify();
  // While "processing" the caller only waits: nothing in the state changes.
  const settled = value(settle(proof));
  state = apply(state, settled);
  expect(verifications).toBe(1);
  expect(settled.data).toMatchObject({
    work_item_id: work,
    status: "submitted",
    subject,
    evidence: [{ kind: "commit", details: { sha: subject.value } }],
  });
  expect(item()?.status).toBe("delivered");
  expect(state.deliveries).toHaveLength(1);
});

test("changed after the timeout: the caller finished its Run, so the late settlement is refused and nothing registers", async () => {
  const proof = await verify();
  state = apply(
    state,
    value(
      finishRun(
        state,
        actor(),
        { run_id: id("run", 1), outcome: "failed", summary: "tool timeout" },
        io,
      ),
    ),
  );
  expect(settle(proof)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  // The next Run cannot reuse the verification made for the ended one.
  state = { ...state, runs: [...state.runs, makeRun(5, 1)] };
  const late = settle(proof);
  expect(late).toMatchObject({ ok: false, error: { code: "stale_target" } });
  if (!late.ok) expect(late.error.message).toContain("请在当前 Run 重新提交");
  expect(state.deliveries).toEqual([]);
  // Submitting again in the current Run verifies afresh and registers.
  state = apply(state, value(settle(await verify())));
  expect(verifications).toBe(2);
  expect(state.deliveries).toHaveLength(1);
  expect(state.deliveries[0]?.run_id).toBe(id("run", 5));
});

test("changed after the timeout: the caller reported a blocker, so the late settlement is refused and the blocker stays", async () => {
  const proof = await verify();
  state = apply(
    state,
    value(
      reportBlocker(
        state,
        actor(),
        { work_item_id: work, reason: "submit_delivery 超时", needs: "role" },
        io,
      ),
    ),
  );
  const late = settle(proof);
  expect(late).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  if (!late.ok) expect(late.error.message).toContain("工作项仍有阻塞");
  expect(item()?.status).toBe("blocked");
  expect(item()?.reported_blocker).toBeDefined();
  expect(state.deliveries).toEqual([]);
});
