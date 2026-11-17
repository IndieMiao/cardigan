import type {
  Actor,
  Delivery,
  DeliveryVerifier,
  SubmitDeliveryParams,
} from "../../index.js";
import {
  assign,
  createWorkItem,
  prepareDelivery,
  recordMergeCheck,
  submitDelivery,
  submitReview,
  updateCard,
} from "../../index.js";
import { mergeFixture } from "../merge/test-fixtures.js";
import { fixture, human, ports, role, value } from "../test-fixtures.js";

export const recheckTree = "c".repeat(40);
export const recheckVerifier = (
  head = "a".repeat(40),
  tree = recheckTree,
): DeliveryVerifier => ({
  verify: async (s) => ({
    ok: true,
    value: [
      {
        kind: "commit",
        details: {
          sha: s.value,
          tree_sha: tree,
          branch_head_sha: head,
        },
      },
    ],
  }),
});

/** Synthetic version 2 state for A1 return, review reuse and recheck contracts. */
export async function returnedRecheckFixture(
  beforeFailure?: (f: ReturnType<typeof mergeFixture>) => void,
  extras: {
    independent?: boolean;
    secondary?: boolean;
    fail?: (f: ReturnType<typeof mergeFixture>, completion: Delivery) => void;
  } = {},
) {
  const seed = fixture();
  const f = mergeFixture("confirm", 3, {
    state: {
      ...seed,
      cards: [],
      work_items: [],
      assignments: [],
      runs: [],
      roles: [...seed.roles, role("independent_reviewer")],
    },
    ports: ports(),
  });
  f.commit({
    ok: true,
    value: {
      data: null,
      events: [],
      timeline: [],
      token_requests: [],
      changes: [
        { collection: "cards", entity: { ...f.card, flow_version: 2 } },
      ],
    },
  });
  const add = (kind: "produce" | "verify", role_id: string) => {
    const w = f.commit(
      createWorkItem(
        f.state,
        human,
        {
          card_id: f.card.id,
          title: role_id,
          role_id,
          kind,
          required: true,
          completion_criteria: ["pass"],
          ...(kind === "verify"
            ? {
                target_work_item_id: f.coder
                  .work_item_id as Delivery["work_item_id"],
              }
            : {}),
        },
        f.io,
      ),
    );
    return f.commit(
      assign(f.state, human, { work_item_id: w.id, role_id }, f.io),
    );
  };
  const independent = extras.independent
    ? add("verify", "independent_reviewer")
    : undefined;
  const secondary = extras.secondary ? add("produce", "coder") : undefined;
  if (independent)
    f.commit(
      updateCard(
        f.state,
        human,
        { card_id: f.card.id, risk_tags: ["permission"] },
        f.io,
      ),
    );
  if (secondary) {
    f.start(secondary);
    const p: SubmitDeliveryParams = {
      work_item_id: secondary.work_item_id as Delivery["work_item_id"],
      kind: "code",
      summary: "Secondary",
      subject: { kind: "git_head", value: "d".repeat(40) },
      requested_verifiers: [],
    };
    f.commit(
      submitDelivery(
        f.state,
        f.actor(secondary),
        p,
        value(
          await prepareDelivery(
            f.state,
            f.actor(secondary),
            p,
            recheckVerifier("d".repeat(40), "e".repeat(40)),
          ),
        ),
        f.io,
      ),
    );
  }
  const deliver = async (kind: Delivery["kind"]) => {
    f.start(f.coder);
    const p: SubmitDeliveryParams = {
      work_item_id: f.coder.work_item_id as Delivery["work_item_id"],
      kind,
      summary: "Ready",
      subject: { kind: "git_head", value: "a".repeat(40) },
      requested_verifiers:
        kind === "card_completion"
          ? [f.pm.work_item_id as Delivery["work_item_id"]]
          : [f.reviewer, ...(independent ? [independent] : [])].map(
              (a) => a.work_item_id as Delivery["work_item_id"],
            ),
      ...(kind === "card_completion"
        ? {
            plain_summary: {
              changed: "修正显示",
              impact: "显示正确",
              risk: "无",
            },
          }
        : {}),
    };
    const proof = value(
      await prepareDelivery(f.state, f.actor(f.coder), p, recheckVerifier()),
    );
    return f.commit(submitDelivery(f.state, f.actor(f.coder), p, proof, f.io));
  };
  const product = await deliver("code");
  f.review(product);
  if (independent) {
    f.start(independent);
    f.commit(
      submitReview(
        f.state,
        f.actor(independent),
        {
          delivery_id: product.id,
          target_sha: product.subject.value,
          kind: "code",
          issues: [],
        },
        f.io,
      ),
    );
  }
  const completion = await deliver("card_completion");
  f.review(completion);
  const system: Actor = { kind: "system", project_id: f.state.project_id };
  const fail = (target = completion) => {
    const identity = {
      card_id: f.card.id,
      completion_id: target.id,
      attempt_id: `attempt-${target.id}`,
      candidate_sha: "b".repeat(40),
      tree_sha: recheckTree,
    };
    for (const status of ["queued", "running", "failed"] as const) {
      f.commit(
        recordMergeCheck(
          { ...f.state, project_settings: { merge_gate_enabled: true } },
          system,
          status === "failed"
            ? {
                ...identity,
                status,
                checks: [{ name: "test", status: "failed", exit_code: 1 }],
                summary: "FAIL synthetic unrelated test",
                log_ref: `${identity.attempt_id}.log`,
              }
            : { ...identity, status },
          f.io,
        ),
      );
    }
  };
  beforeFailure?.(f);
  if (extras.fail) extras.fail(f, completion);
  else fail();
  const returned = f.state.events.findLast(
    (e) => e.type === "merge_changes_requested",
  );
  if (!returned) throw new Error("Missing A1 return");
  f.start(f.coder, returned);
  return { f, product, completion, returned, fail, independent, secondary };
}
