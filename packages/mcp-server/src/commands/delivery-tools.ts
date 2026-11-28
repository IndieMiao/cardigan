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
import { defineTool, type ToolContext } from "../tools/types.js";
import { executeCommand, executePreparedCommand, unwrap } from "./execute.js";
import { InFlightCalls, inFlightKey, settleWithin } from "./in-flight.js";

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
      basis: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "必改项的依据：ACn（本卡第 n 条验收标准）、INVn（card.invariants 第 n 条）、PCn（当前通过条件清单第 n 条）或常驻不变量 lost_work、dual_executor、security、check_failed、ui_copy。流程版本 ≥5 缺依据的必改项改记为后续跟进，不挡合并",
        ),
    }),
  ),
  pass_conditions: z
    .array(
      z
        .object({
          description: z.string().trim().min(1).max(500),
          basis: z.string().trim().min(1),
        })
        .strict(),
    )
    .min(1)
    .max(10)
    .optional()
    .describe(
      "通过条件清单：同一验证项第 2 次驳回时必填，1–10 条可验证的条件，每条的 basis 为 ACn、INVn 或常驻不变量；之后的审核只核对这份清单，必改项用 PCn 引用",
    ),
  evidence_pending: z
    .object({
      items: z
        .array(
          z
            .object({
              description: z.string().trim().min(1).max(500),
              basis: z.string().trim().min(1),
            })
            .strict(),
        )
        .min(1)
        .max(10),
      blocker: z
        .object({
          kind: z.enum(["card_merged", "deployment_ready"]),
          target_id: z.string().trim().min(1).max(100),
        })
        .strict(),
    })
    .strict()
    .optional()
    .describe(
      "流程版本 ≥5：必需验收证据只因可核查的平台阻塞暂时拿不到时填写。items 写缺的证据和它对应的 ACn/INVn/PCn；blocker 为 {kind:card_merged, target_id:本项目未完成的平台卡} 或 {kind:deployment_ready, target_id:平台修复的完整提交 SHA}。没有代码必改时结论为不通过的 conditional，不算驳回、不消耗轮数、不重置连续驳回；代码或功能必改照常写进 issues。阻塞解除后系统通知作者补证",
    ),
  evidence_attachments: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .optional()
    .describe(
      "核对本验证项此前标为待补的证据：引用绑定当前交付的证据附件。待补证据未核对时不能通过；旧版本上的附件不能沿用",
    ),
  evidence_seen: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .optional()
    .describe(
      "驳回时，如果审核开始后交付又到了证据附件，系统会拦下驳回并列出这些附件编号；重新读取卡片和附件核对后仍要驳回时，在这里列出它们",
    ),
  evidence_not_applicable: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "此前待补的证据对当前版本已不适用时写明理由，代替 evidence_attachments",
    ),
  issue_refs: z
    .array(
      z.union([
        z.string().min(1),
        z
          .object({
            finding_id: z.string().min(1),
            proof: z.string().trim().min(1),
          })
          .strict(),
      ]),
    )
    .optional()
    .describe(
      "同一交付的已有必改项：引用 get_card.shared_must_fixes 的 finding_id，补充本次审核证据时传 {finding_id, proof}，不要在 issues 中重复新建。仍须自行审核当前交付。",
    ),
  rejection_category: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .optional()
    .describe("驳回的主要原因类别，例如并发时序；重复问题沿用同一类别"),
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
  /**
   * C-847: how long submit_delivery waits for verification before answering
   * "processing" while it continues; defaults to {@link DELIVERY_REPLY_WITHIN_MS}.
   */
  readonly deliveryReplyWithinMs?: number;
}
/**
 * C-847: well under half of the shortest client tool timeout in use (Codex's
 * default 60 s; Claude Code's default is far longer, the Codex stdio bridge
 * allows 300 s), so a slow verification is answered before any client gives up.
 */
export const DELIVERY_REPLY_WITHIN_MS = 20_000;
const RETRY_AFTER_SECONDS = 15;
export const SUBMIT_DELIVERY_DESCRIPTION =
  "Submit a versioned delivery or card completion request. 大仓库的 Git 校验可能要一两分钟：约 20 秒内没校验完时返回 status=processing（尚未登记，服务端继续校验）。收到 processing 或客户端超时后，先等约 15 秒，再用同一 idempotency_key 和完全相同的参数重提 submit_delivery 取结果（会接上进行中的校验或直接返回已登记的交付），也可用 get_card / get_updates 查看是否已登记；等待期间不要 report_blocker、finish_run 或改动工作项，否则结果会因状态已变被拒。";

/** Not registered yet: the same call again returns the outcome. */
function deliveryProcessing(idempotency_key: string, waitedMs: number) {
  return {
    status: "processing" as const,
    delivered: false,
    idempotency_key,
    waited_seconds: Math.round(waitedMs / 1000),
    retry_after_seconds: RETRY_AFTER_SECONDS,
    message: `交付仍在校验，尚未登记。约 ${RETRY_AFTER_SECONDS} 秒后用同一 idempotency_key 和完全相同的参数再调用 submit_delivery 取结果；不要因此 report_blocker、finish_run 或改动工作项。`,
  };
}
export function deliveryTools(options: DeliveryToolOptions) {
  const configured = (state: CommandState): CommandState => ({
    ...state,
    project_settings: options.projectSettings?.(state.project_id) ?? {},
  });
  const inFlight = new InFlightCalls();
  const watched = new WeakSet<Promise<unknown>>();
  const replyWithinMs =
    options.deliveryReplyWithinMs ?? DELIVERY_REPLY_WITHIN_MS;
  /** Verification, the delivery transaction and the pin: one joinable call. */
  const submit = async (
    idempotency_key: string,
    params: SubmitDeliveryParams,
    context: ToolContext,
  ) => {
    const delivery = await executePreparedCommand(
      context,
      "submit_delivery",
      idempotency_key,
      params,
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
  };
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
      description: SUBMIT_DELIVERY_DESCRIPTION,
      input: deliveryInput,
      handler: async ({ idempotency_key, ...params }, context) => {
        const started = performance.now();
        const call = inFlight.run(
          inFlightKey(context, "submit_delivery", idempotency_key, params),
          () =>
            submit(idempotency_key, params as SubmitDeliveryParams, context),
        );
        const settled = await settleWithin(call, replyWithinMs);
        if (settled) return settled.value;
        // Still verifying: answer now, and record once how the call ends.
        if (!watched.has(call)) {
          watched.add(call);
          call
            .then(
              () => "ok",
              (error: unknown) =>
                typeof error === "object" && error !== null && "code" in error
                  ? String((error as { code: unknown }).code)
                  : "internal_error",
            )
            .then((code) =>
              options.log?.({
                event: "tool",
                method: "background",
                tool: "submit_delivery",
                assignment_id: context.identity.actor.assignment_id,
                code,
                duration_ms: performance.now() - started,
              }),
            )
            .catch(() => undefined);
        }
        return deliveryProcessing(idempotency_key, replyWithinMs);
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
      description:
        "Withdraw your own passed review with a required rationale. Also voids a rejection made before evidence that arrived after the review started was read: allowed to the rejecting reviewer or PM Ops; the same delivery awaits review again, the author need not resubmit and the rejection spends no review round.",
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
