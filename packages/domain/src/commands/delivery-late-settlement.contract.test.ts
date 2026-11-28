/**
 * C-847: Git verification of a large repository can outlast the client's
 * tool timeout. The host keeps verifying and settles the delivery later
 * ("processing"); the same call repeated meanwhile joins it. These contracts
 * pin what the settlement may do once the verification is done:
 * - unchanged state (the caller only waited or read): it registers;
 * - the caller changed state meanwhile (finished its Run, started another,
 *   reported a blocker): it is refused with a reason, never registered
 *   against the changed state, and a fresh submission in the current Run
 *   still works;
 * - a failure nobody received is recorded and the same request fetches the
 *   original error once with the same key;
 * - a stale `supersedes` names its replacement and the fix.
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
import {
  claimDeliveryRejection,
  DELIVERY_REJECTION_CLAIM_MS,
  DELIVERY_REJECTION_CLAIMED_EVENT,
  recordDeliveryRejection,
} from "./delivery-rejection.js";
import { finishRun } from "./runtime.js";
import {
  actor,
  apply,
  fixture,
  id,
  run as makeRun,
  now,
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

const system = { kind: "system" as const, project_id: fixture().project_id };
const key = {
  assignment_id: id("assignment", 1),
  work_item_id: work,
  idempotency_key: "slow-delivery",
  request_fingerprint: "f".repeat(64),
};
const failure = {
  code: "illegal_transition" as const,
  message: "Exactly one running Run is required",
};
function record(error = failure) {
  state = apply(
    state,
    value(recordDeliveryRejection(state, system, { ...key, error }, io)),
  );
}
const claim = (k = key) => {
  const effect = value(claimDeliveryRejection(state, system, k, io));
  state = apply(state, effect);
  return effect;
};

test("a failed result can be fetched with the same key: once, with the original error, and only for the same request", async () => {
  record();
  const entry = state.timeline.at(-1);
  expect(entry).toMatchObject({ type: "system", work_item_id: work });
  expect(entry?.body).toContain("幂等键 slow-delivery");
  expect(entry?.body).toContain(`illegal_transition：${failure.message}`);
  // A different request under the same key, or another Assignment, gets nothing.
  for (const other of [
    { ...key, request_fingerprint: "e".repeat(64) },
    { ...key, idempotency_key: "other" },
    { ...key, assignment_id: id("assignment", 2) },
  ]) {
    const none = claim(other);
    expect(none.data).toBeUndefined();
    expect(none.events).toEqual([]);
  }
  const claimed = claim();
  expect(claimed.data).toEqual({ error: failure, settled_at: now });
  expect(claimed.events.map((e) => e.type)).toEqual([
    DELIVERY_REJECTION_CLAIMED_EVENT,
  ]);
  // Handed out once: the next call is evaluated against current state.
  expect(claim().data).toBeUndefined();
  // A later failure of the same request is handed out again.
  record({ ...failure, message: "second" });
  expect(claim().data?.error.message).toBe("second");
});

test("an unclaimed failure expires, and only the host records or claims failures", () => {
  record();
  const later = {
    ...io,
    clock: {
      now: () =>
        new Date(
          Date.parse(now) + DELIVERY_REJECTION_CLAIM_MS + 1000,
        ).toISOString(),
    },
  };
  expect(
    value(claimDeliveryRejection(state, system, key, later)).data,
  ).toBeUndefined();
  expect(
    recordDeliveryRejection(state, actor(), { ...key, error: failure }, io),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  expect(claimDeliveryRejection(state, actor(), key, io)).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  expect(
    recordDeliveryRejection(
      state,
      system,
      { ...key, work_item_id: id("work_item", 2), error: failure },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("a supersedes made stale by a later code delivery names the delivery that replaced it and the fix", async () => {
  state = apply(state, value(settle(await verify())));
  const older = state.deliveries[0]?.id;
  if (!older) throw new Error("Missing first delivery");
  const second = { ...params, subject: { ...subject, value: "b".repeat(40) } };
  const proof = value(
    await prepareDelivery(state, actor(), second, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  state = apply(
    state,
    value(submitDelivery(state, actor(), second, proof, io)),
  );
  const newer = state.deliveries.find((d) => d.id !== older)?.id;
  const third = {
    ...params,
    subject: { ...subject, value: "c".repeat(40) },
    supersedes: older,
  };
  const late = submitDelivery(
    state,
    actor(),
    third,
    value(
      await prepareDelivery(state, actor(), third, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    ),
    io,
  );
  expect(late).toMatchObject({ ok: false, error: { code: "stale_target" } });
  if (!late.ok)
    expect(late.error.message).toContain(
      `${older} 已被 ${newer} 作废，不再是当前有效的交付；去掉 supersedes，或改成当前有效的产出交付 ${newer}`,
    );
});
