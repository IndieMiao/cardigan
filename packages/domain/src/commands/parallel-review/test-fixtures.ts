import type {
  CommandPorts,
  CommandState,
  SubmitReviewParams,
} from "../../index.js";
import { prepareDelivery, submitDelivery, submitReview } from "../../index.js";
import {
  actor,
  apply,
  fixture,
  id,
  ports,
  subject,
  value,
} from "../test-fixtures.js";

export const parallelParams = {
  work_item_id: id("work_item", 1),
  kind: "code" as const,
  summary: "Ready",
  subject,
  requested_verifiers: [id("work_item", 2), id("work_item", 3)],
};
export const parallelBug = {
  severity: "major" as const,
  description: "Synthetic missing validation",
  impact: "functional" as const,
  basis: "AC1",
  must_fix: true,
  pre_existing: false,
};
export function parallelState(version: number | undefined = 5): CommandState {
  const base = fixture();
  return {
    ...base,
    cards: base.cards.map((c) => ({ ...c, flow_version: version })),
    work_items: base.work_items.map((w) =>
      w.id === id("work_item", 3) && w.kind === "verify"
        ? {
            ...w,
            template_key: "parallel",
            target_work_item_id: id("work_item", 1),
          }
        : w,
    ),
  };
}
export async function parallelDelivery(state: CommandState, io: CommandPorts) {
  const proof = value(
    await prepareDelivery(state, actor(), parallelParams, {
      verify: async () => ({
        ok: true,
        value: [
          {
            kind: "commit",
            details: { sha: subject.value, tree_sha: "c".repeat(40) },
          },
        ],
      }),
    }),
  );
  return value(submitDelivery(state, actor(), parallelParams, proof, io));
}
export async function rejectedParallel(
  version: number | undefined = 5,
  io = ports(),
) {
  let state = parallelState(version);
  const delivered = await parallelDelivery(state, io);
  state = apply(state, delivered);
  const review: SubmitReviewParams = {
    delivery_id: delivered.data.id,
    target_sha: subject.value,
    kind: "code",
    issues: [],
  };
  const rejected = value(
    submitReview(
      state,
      actor(2, "reviewer"),
      {
        ...review,
        issues: [parallelBug],
      },
      io,
    ),
  );
  state = apply(state, rejected);
  return { state, io, target: delivered.data, review, rejected };
}
