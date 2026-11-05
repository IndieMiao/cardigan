import {
  type Clock,
  type DeliveryId,
  type DeliveryVerifier,
  type ProjectId,
  prepareDelivery,
  type SubmitDeliveryParams,
  type SubmitReviewParams,
  submitDelivery,
  submitReview,
} from "@cardigan/domain";
import { z } from "zod";
import type { Logger } from "../log.js";
import { defineTool } from "../tools/types.js";
import { executeCommand, executePreparedCommand, unwrap } from "./execute.js";

import { id, idempotency_key } from "./schemas.js";

const attachments = z.array(z.string().min(1)).optional();
const deliveryInput = z.object({
  idempotency_key,
  work_item_id: id("work_item"),
  kind: z.enum([
    "code",
    "design",
    "doc",
    "test_report",
    "card_completion",
    "other",
  ]),
  summary: z
    .string()
    .min(1)
    .refine((s) => [...s].length <= 160, "Summary exceeds 160 code points"),
  subject: z.object({
    kind: z.enum(["git_head", "artifact_sha256", "doc_version"]),
    value: z.string().min(1),
  }),
  // §4.4: a work item that nothing verifies is delivered with an empty list.
  // The domain still refuses an empty list whenever a verifier exists.
  requested_verifiers: z.array(id("work_item")),
  branch: z.string().optional(),
  pr_url: z.string().optional(),
  attachments,
  test_results: z
    .array(z.object({ command: z.string(), result: z.string() }))
    .optional(),
  known_gaps: z
    .array(
      z.object({
        description: z.string(),
        followup_card_id: id("card").optional(),
        precondition: z.string().optional(),
      }),
    )
    .optional(),
  supersedes: id("delivery").optional(),
});
const reviewInput = z.object({
  idempotency_key,
  delivery_id: id("delivery"),
  target_sha: z.string().min(1),
  kind: z.enum(["code", "design", "test", "replay", "product", "user"]),
  issues: z.array(
    z.object({
      severity: z.enum(["critical", "major", "minor"]),
      description: z.string().min(1),
      must_fix: z.boolean(),
      pre_existing: z.boolean(),
      proof: z.string().optional(),
    }),
  ),
  recheck_required: z.boolean().optional(),
  attachments,
});

/**
 * §12.3: a verifier instance binds one project, because Assignment ids are only
 * unique inside a project. The caller resolves it per request, never per token.
 */
export type DeliveryVerifierFor = (project_id: ProjectId) => DeliveryVerifier;
/** §3.3 step 2: pin the accepted commit after the delivery transaction commits. */
export interface PinDeliveryRequest {
  readonly project_id: ProjectId;
  readonly delivery_id: DeliveryId;
  readonly sha: string;
}

export interface DeliveryToolOptions {
  /** Required: production must verify against the real Git service (§3.3). */
  readonly deliveryVerifier: DeliveryVerifierFor;
  /** Omitted only by tests that do not exercise Git pinning. */
  readonly pinDelivery?: (request: PinDeliveryRequest) => Promise<void>;
  readonly clock?: Clock;
  readonly log?: Logger;
}
export function deliveryTools(options: DeliveryToolOptions) {
  return [
    defineTool({
      name: "submit_delivery",
      description: "Submit a versioned delivery or card completion request.",
      input: deliveryInput,
      handler: async ({ idempotency_key, ...params }, context) => {
        const delivery = await executePreparedCommand(
          context,
          "submit_delivery",
          idempotency_key,
          params as SubmitDeliveryParams,
          // The request's project selects the verifier, not the token's claim.
          (state, actor, p) =>
            prepareDelivery(
              state,
              actor,
              p,
              options.deliveryVerifier(actor.project_id),
            ),
          (state, actor, p, receipt, ports) =>
            submitDelivery(state, actor, p, unwrap(receipt), ports),
          options.clock,
        );
        if (delivery.subject.kind === "git_head" && options.pinDelivery) {
          try {
            await options.pinDelivery({
              project_id: context.identity.actor.project_id,
              delivery_id: delivery.id,
              sha: delivery.subject.value,
            });
          } catch {
            // The delivery is already committed: never roll it back. The
            // reconcile loop repairs a missing pin from the candidate ref.
            options.log?.({
              event: "tool",
              method: "tools/call",
              tool: "submit_delivery",
              assignment_id: context.identity.actor.assignment_id,
              code: "delivery_pin_failed",
            });
          }
        }
        return delivery;
      },
    }),
    defineTool({
      name: "submit_review",
      description:
        "Review a delivery; the server derives verdict and blocking.",
      input: reviewInput,
      handler: ({ idempotency_key, ...params }, context) =>
        executeCommand(
          context,
          "submit_review",
          idempotency_key,
          params as SubmitReviewParams,
          submitReview,
          options.clock,
        ),
    }),
  ];
}
