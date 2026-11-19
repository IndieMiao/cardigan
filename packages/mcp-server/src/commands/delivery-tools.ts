import {
  type CheckHeadReader,
  type Clock,
  type CommandState,
  type DeliveryId,
  type DeliveryVerifier,
  type ProjectId,
  prepareCheck,
  prepareDelivery,
  prepareRecheck,
  REVIEW_IMPACTS,
  requestCheck,
  requestDeliveryRework,
  requestRecheck,
  type SubmitDeliveryParams,
  type SubmitReviewParams,
  submitDelivery,
  submitReview,
  withdrawReview,
} from "@cardigan/domain";
import { z } from "zod";
import type { Logger } from "../log.js";
import { defineTool } from "../tools/types.js";
import { executeCommand, executePreparedCommand, unwrap } from "./execute.js";

import { id, idempotency_key, plainSummary } from "./schemas.js";

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
  plain_summary: plainSummary
    .optional()
    .describe(
      "Required with kind=card_completion; also allowed on flow >=5 product deliveries: the plain change note (人话改动说明) the human sees first on the merge confirmation.",
    ),
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
      impact: z
        .enum(REVIEW_IMPACTS)
        .optional()
        .describe("Required for every must_fix issue"),
      pre_existing: z.boolean(),
      proof: z.string().optional(),
    }),
  ),
  recheck_required: z.boolean().optional(),
  followup_card_id: id("card")
    .optional()
    .describe(
      "Accept with conditions: defer exclusively UX-only must-fix issues to this open card",
    ),
  attachments,
  screenshot_check: z
    .enum(["passed", "failed"])
    .optional()
    .describe(
      "仅独立复核员：界面卡截图核对（亮色、暗色、390px）的结论；项目开启截图核对计入代确认时投影为合并前核对项“截图核对”",
    ),
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
  /** Trusted host configuration, re-read at preparation and settlement. */
  readonly projectSettings?: (
    project_id: ProjectId,
  ) => CommandState["project_settings"];
  readonly checkHead?: (project: ProjectId) => CheckHeadReader;
  /** Omitted only by tests that do not exercise Git pinning. */
  readonly pinDelivery?: (request: PinDeliveryRequest) => Promise<void>;
  readonly clock?: Clock;
  readonly log?: Logger;
}
export function deliveryTools(options: DeliveryToolOptions) {
  const configured = (state: CommandState): CommandState => ({
    ...state,
    project_settings: options.projectSettings?.(state.project_id) ?? {},
  });
  return [
    defineTool({
      name: "request_delivery_rework",
      description:
        "PM Ops only: request human confirmation to return the current accepted Git delivery after its reviewer withdrew their own pass. Never performs the return itself.",
      input: z.object({
        idempotency_key,
        work_item_id: id("work_item"),
        delivery_id: id("delivery"),
        target_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
        review_id: id("review"),
        rationale: z.string().trim().min(1),
      }),
      handler: ({ idempotency_key, ...params }, context) =>
        executeCommand(
          context,
          "request_delivery_rework",
          idempotency_key,
          params,
          requestDeliveryRework,
          options.clock,
        ),
    }),
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
              configured(state),
              actor,
              p,
              options.deliveryVerifier(actor.project_id),
            ),
          (state, actor, p, receipt, ports) =>
            submitDelivery(configured(state), actor, p, unwrap(receipt), ports),
          options.clock,
        );
        if (delivery.subject.kind === "git_head" && options.pinDelivery) {
          const started = performance.now();
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
          } finally {
            context.recordTiming?.("delivery_pin", performance.now() - started);
          }
        }
        return delivery;
      },
    }),
    defineTool({
      name: "request_check",
      description:
        "Check the active producer's recorded branch HEAD using this project's check executor (flow >= 3).",
      input: z
        .object({ idempotency_key, work_item_id: id("work_item") })
        .strict(),
      handler: ({ idempotency_key, ...params }, context) =>
        executePreparedCommand(
          context,
          "request_check",
          idempotency_key,
          params,
          (s, a, p) =>
            prepareCheck(
              s,
              a,
              p,
              options.checkHead?.(a.project_id) ?? {
                head: async () => {
                  throw new Error("No check HEAD reader");
                },
              },
            ),
          (s, a, p, prepared, ports) =>
            requestCheck(s, a, p, unwrap(prepared), ports),
          options.clock,
        ),
    }),
    defineTool({
      name: "request_recheck",
      description:
        "Request one same-SHA recheck after an A1 system return, as the active primary producer.",
      input: z
        .object({
          idempotency_key,
          card_id: id("card"),
          reason: z.string().trim().min(1),
        })
        .strict(),
      handler: async ({ idempotency_key, ...params }, context) => {
        const result = await executePreparedCommand(
          context,
          "request_recheck",
          idempotency_key,
          params,
          (state, actor, p) =>
            prepareRecheck(
              configured(state),
              actor,
              p,
              options.deliveryVerifier(actor.project_id),
            ),
          (state, actor, p, receipt, ports) =>
            requestRecheck(configured(state), actor, p, unwrap(receipt), ports),
          options.clock,
        );
        if (options.pinDelivery)
          for (const delivery of [result.product, result.completion]) {
            try {
              await options.pinDelivery({
                project_id: context.identity.actor.project_id,
                delivery_id: delivery.id,
                sha: delivery.subject.value,
              });
            } catch {
              options.log?.({
                event: "tool",
                method: "tools/call",
                tool: "request_recheck",
                assignment_id: context.identity.actor.assignment_id,
                code: "delivery_pin_failed",
              });
            }
          }
        return result;
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
    defineTool({
      name: "withdraw_review",
      description: "Withdraw your own passed review with a required rationale.",
      input: z.object({
        idempotency_key,
        work_item_id: id("work_item"),
        rationale: z.string().trim().min(1),
      }),
      handler: ({ idempotency_key, ...params }, context) =>
        executeCommand(
          context,
          "withdraw_review",
          idempotency_key,
          params,
          withdrawReview,
          options.clock,
        ),
    }),
  ];
}
