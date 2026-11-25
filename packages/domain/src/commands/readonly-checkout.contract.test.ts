import { expect, test } from "vitest";
import {
  type Delivery,
  prepareDelivery,
  READONLY_CHECKOUT_EVENT,
  type ReadonlyCheckoutObservation,
  readonlyReviewTarget,
  recordReadonlyCheckout,
  submitDelivery,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human } from "./test-fixtures.js";

// C-630: verifiers of artifact deliveries get a baseline or source checkout.

const system = { kind: "system" as const, project_id: human.project_id };
const artifact = "c".repeat(64);
const built = "b".repeat(40);
const head = "e".repeat(40);

async function deliverArtifact(f: ReturnType<typeof mergeFixture>) {
  f.start(f.coder);
  const p = {
    work_item_id: f.coder.work_item_id as Delivery["work_item_id"],
    kind: "other" as const,
    summary: "APK",
    subject: { kind: "artifact_sha256" as const, value: artifact },
    requested_verifiers: [f.reviewer.work_item_id as Delivery["work_item_id"]],
  };
  const proof = await prepareDelivery(f.state, f.actor(f.coder), p, {
    verify: async () => ({ ok: true, value: [] }),
  });
  if (!proof.ok) throw new Error(proof.error.message);
  return f.commit(
    submitDelivery(f.state, f.actor(f.coder), p, proof.value, f.io),
  );
}
const reviewItem = (f: ReturnType<typeof mergeFixture>) => {
  const item = f.state.work_items.find((w) => w.id === f.reviewer.work_item_id);
  if (!item) throw new Error("Missing review item");
  return item;
};
const record = (
  f: ReturnType<typeof mergeFixture>,
  p: Omit<ReadonlyCheckoutObservation, "assignment_id">,
  actor: Parameters<typeof recordReadonlyCheckout>[1] = system,
) => {
  const result = recordReadonlyCheckout(
    f.state,
    actor,
    { assignment_id: f.reviewer.id, ...p },
    f.io,
  );
  return result.ok ? f.commit(result) : result.error;
};
const checkouts = (f: ReturnType<typeof mergeFixture>) =>
  f.state.events.filter((e) => e.type === READONLY_CHECKOUT_EVENT);

test("pure artifact: the target is the artifact on the baseline, recorded once", async () => {
  const f = mergeFixture();
  const product = await deliverArtifact(f);
  expect(readonlyReviewTarget(f.state.deliveries, reviewItem(f))).toEqual({
    kind: "artifact",
    delivery_id: product.id,
  });
  // A source observation does not match a delivery without a source commit.
  expect(
    record(f, { delivery_id: product.id, sha: built, source: "source_commit" }),
  ).toBe(false);
  const baseline = {
    delivery_id: product.id,
    sha: head,
    source: "baseline" as const,
    baseline_ref: "origin/main",
  };
  expect(record(f, baseline)).toBe(true);
  expect(record(f, baseline)).toBe(false);
  expect(checkouts(f)).toHaveLength(1);
  expect(checkouts(f)[0]).toMatchObject({
    card_id: f.card.id,
    actor: system,
    payload: {
      assignment_id: f.reviewer.id,
      work_item_id: f.reviewer.work_item_id,
      delivery_id: product.id,
      subject_kind: "artifact_sha256",
      source: "baseline",
      baseline_ref: "origin/main",
      sha: head,
    },
  });
  const note = f.state.timeline.findLast(
    (t) => t.event_seq === checkouts(f)[0]?.seq,
  );
  expect(note).toMatchObject({
    type: "system",
    delivery_id: product.id,
    work_item_id: f.reviewer.work_item_id,
  });
  expect(note?.body).toContain(`检出基线 origin/main 的当前 HEAD ${head}`);
});

test("Git then artifact: the earlier Git delivery is the recorded source commit", async () => {
  const f = mergeFixture();
  const git = await f.deliver("code", built);
  const product = await deliverArtifact(f);
  expect(f.state.deliveries.find((d) => d.id === git.id)?.status).toBe(
    "superseded",
  );
  expect(readonlyReviewTarget(f.state.deliveries, reviewItem(f))).toEqual({
    kind: "artifact",
    delivery_id: product.id,
    source: { delivery_id: git.id, sha: built },
  });
  expect(
    record(f, {
      delivery_id: product.id,
      sha: head,
      source: "baseline",
      baseline_ref: "origin/main",
    }),
  ).toBe(false);
  expect(
    record(f, { delivery_id: product.id, sha: head, source: "source_commit" }),
  ).toBe(false);
  expect(
    record(f, { delivery_id: product.id, sha: built, source: "source_commit" }),
  ).toBe(true);
  expect(checkouts(f)).toHaveLength(1);
  expect(checkouts(f)[0]?.payload).toMatchObject({
    source: "source_commit",
    source_delivery_id: git.id,
    sha: built,
  });
});

test("Git target, plan-only and completion targets keep their existing selection", async () => {
  const f = mergeFixture();
  // Only a plan discussion: no delivery target, the host keeps its plan path.
  expect(
    readonlyReviewTarget(f.state.deliveries, reviewItem(f)),
  ).toBeUndefined();
  const product = await deliverArtifact(f);
  const git = await f.deliver("code", built);
  expect(readonlyReviewTarget(f.state.deliveries, reviewItem(f))).toEqual({
    kind: "git",
    delivery_id: git.id,
    sha: built,
  });
  expect(
    record(f, {
      delivery_id: product.id,
      sha: head,
      source: "baseline",
      baseline_ref: "origin/main",
    }),
  ).toBe(false);
  expect(checkouts(f)).toHaveLength(0);
  f.review(git);
  const completion = await f.deliver("card_completion", built);
  const pmItem = f.state.work_items.find((w) => w.id === f.pm.work_item_id);
  if (!pmItem) throw new Error("Missing acceptance item");
  expect(readonlyReviewTarget(f.state.deliveries, pmItem)).toEqual({
    kind: "git",
    delivery_id: completion.id,
    sha: built,
  });
  const productItem = f.state.work_items.find(
    (w) => w.id === f.coder.work_item_id,
  );
  if (!productItem) throw new Error("Missing product item");
  expect(readonlyReviewTarget(f.state.deliveries, productItem)).toBeUndefined();
});

test("only the system may record, with a full commit and a baseline ref", async () => {
  const f = mergeFixture();
  const product = await deliverArtifact(f);
  const baseline = {
    delivery_id: product.id,
    sha: head,
    source: "baseline" as const,
    baseline_ref: "origin/main",
  };
  expect(record(f, baseline, human)).toMatchObject({ code: "unauthorized" });
  expect(record(f, baseline, f.actor(f.reviewer))).toMatchObject({
    code: "unauthorized",
  });
  expect(record(f, { ...baseline, sha: "abc" })).toMatchObject({
    code: "validation_failed",
  });
  const { baseline_ref: _ref, ...unnamed } = baseline;
  expect(record(f, unnamed)).toMatchObject({ code: "validation_failed" });
  expect(record(f, { ...baseline, baseline_ref: "../main" })).toMatchObject({
    code: "validation_failed",
  });
  expect(checkouts(f)).toHaveLength(0);
});
