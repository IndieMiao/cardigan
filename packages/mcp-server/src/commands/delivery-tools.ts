import {
  type Clock,
  type DeliveryVerifier,
  parseId,
  prepareDelivery,
  type ReadableIdKind,
  type SubmitDeliveryParams,
  type SubmitReviewParams,
  submitDelivery,
  submitReview,
} from "@cardigan/domain";
import { z } from "zod";
import { defineTool } from "../tools/types.js";
import { executeCommand, executePreparedCommand, unwrap } from "./execute.js";

const id = <K extends ReadableIdKind>(kind: K) =>
  z
    .string()
    .refine((s) => parseId(kind, s).ok, `Invalid ${kind} ID`)
    .transform((s) => unwrap(parseId(kind, s)).id);
const attachments = z.array(z.string().min(1)).optional();
const idempotency_key = z
  .string()
  .min(1)
  .max(200)
  .refine((key) => key.trim().length > 0, "Idempotency key must not be blank");
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
  requested_verifiers: z.array(id("work_item")).min(1),
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

export interface DeliveryToolOptions {
  readonly deliveryVerifier?: DeliveryVerifier;
  readonly clock?: Clock;
}
/** M1 stub, explicitly not evidence of actual Git verification. M4 supplies the real port. */
const acceptingVerifier: DeliveryVerifier = {
  verify: async () => ({ ok: true, value: [] }),
};
export function deliveryTools(options: DeliveryToolOptions = {}) {
  const verifier = options.deliveryVerifier ?? acceptingVerifier;
  return [
    defineTool({
      name: "submit_delivery",
      description: "Submit a versioned delivery or card completion request.",
      input: deliveryInput,
      handler: ({ idempotency_key, ...params }, context) =>
        executePreparedCommand(
          context,
          "submit_delivery",
          idempotency_key,
          params as SubmitDeliveryParams,
          (state, actor, p) => prepareDelivery(state, actor, p, verifier),
          (state, actor, p, receipt, ports) =>
            submitDelivery(state, actor, p, unwrap(receipt), ports),
          options.clock,
        ),
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
