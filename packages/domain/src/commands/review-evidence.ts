import type {
  Card,
  Delivery,
  EvidencePending,
  PassCondition,
  PlatformBlocker,
  Review,
  WorkItem,
} from "../entities.js";
import { flowAtLeast } from "../flow.js";
import type { AttachmentId } from "../ids.js";
import {
  activeChecklist,
  basisProblem,
  parseBasis,
} from "../review-convergence.js";
import {
  MAX_PENDING_EVIDENCE,
  outstandingEvidence,
  PLATFORM_BLOCKER_KINDS,
  platformBlockerLabel,
} from "../review-evidence.js";
import { type CommandDraft, ensure } from "./core.js";
import { rejectionStreak } from "./review-round.js";
import { platformBlockerResolved } from "./work-waits.js";

export interface ReviewEvidenceInput {
  readonly evidence_pending?: unknown;
  readonly evidence_attachments?: unknown;
  readonly evidence_not_applicable?: unknown;
  readonly recheck_required?: boolean;
  readonly followup_card_id?: unknown;
}
export type ReviewEvidence = Pick<
  Review,
  "evidence_pending" | "evidence_attachments" | "evidence_not_applicable"
>;

/** Only a checkable, still unresolved platform record can hold evidence back. */
function platformBlocker(
  d: CommandDraft,
  card: Card,
  input: unknown,
): PlatformBlocker {
  const blocker = input as Partial<PlatformBlocker> | null;
  ensure(
    !!blocker &&
      PLATFORM_BLOCKER_KINDS.includes(
        blocker.kind as PlatformBlocker["kind"],
      ) &&
      typeof blocker.target_id === "string" &&
      blocker.target_id.trim() === blocker.target_id &&
      blocker.target_id.length > 0 &&
      blocker.target_id.length <= 100,
    "validation_failed",
    "平台阻塞须为 {kind:card_merged, target_id:本项目平台卡号} 或 {kind:deployment_ready, target_id:完整提交 SHA}",
  );
  const value = {
    kind: blocker.kind as PlatformBlocker["kind"],
    target_id: blocker.target_id as string,
  };
  if (value.kind === "card_merged") {
    const platform = d
      .list("cards")
      .find(
        (c) => c.id === value.target_id && c.project_id === d.state.project_id,
      );
    ensure(
      !!platform && platform.id !== card.id && platform.status !== "cancelled",
      "validation_failed",
      `平台卡 ${value.target_id} 不存在于本项目、是本卡或已取消，不是可核查的平台阻塞；请按现有流程审核`,
    );
    ensure(
      platform.status !== "done",
      "validation_failed",
      `平台卡 ${value.target_id} 已完成，证据现在可以取得；请按现有流程审核`,
    );
  } else
    ensure(
      /^[a-f0-9]{40}$/u.test(value.target_id),
      "validation_failed",
      "deployment_ready 的 target_id 须为完整 40 位提交 SHA",
    );
  const resolved = platformBlockerResolved(d, value);
  ensure(
    !resolved,
    "validation_failed",
    `平台阻塞（${platformBlockerLabel(value)}）已解除（依据 ${resolved}），证据现在可以取得；请按现有流程审核`,
  );
  return value;
}

function pendingItems(
  d: CommandDraft,
  card: Card,
  item: WorkItem,
  input: unknown,
): PassCondition[] {
  ensure(
    Array.isArray(input) &&
      input.length > 0 &&
      input.length <= MAX_PENDING_EVIDENCE,
    "validation_failed",
    `evidence_pending.items 须为 1–${MAX_PENDING_EVIDENCE} 条缺失的证据`,
  );
  const checklist = activeChecklist(rejectionStreak(d, item));
  return input.map((raw: unknown) => {
    const entry = raw as Partial<PassCondition> | null;
    ensure(
      typeof entry?.description === "string" &&
        entry.description.trim().length > 0 &&
        entry.description.trim().length <= 500,
      "validation_failed",
      "每条待补证据须写 1–500 字的 description",
    );
    const problem = basisProblem(card, entry.basis, checklist);
    ensure(!problem, "validation_failed", `待补证据的 ${problem}`);
    ensure(
      parseBasis(String(entry.basis))?.kind !== "standing",
      "validation_failed",
      "待补证据须引用它对应的验收标准（ACn）、卡上不变量（INVn）或通过条件（PCn）",
    );
    return {
      description: entry.description.trim(),
      basis: String(entry.basis).trim(),
    };
  });
}

/** Evidence is version-bound when it is attached to the reviewed delivery. */
function versionBoundAttachments(
  d: CommandDraft,
  card: Card,
  target: Delivery,
  input: unknown,
): AttachmentId[] {
  ensure(
    Array.isArray(input) &&
      input.length > 0 &&
      input.length <= MAX_PENDING_EVIDENCE &&
      input.every((id) => typeof id === "string") &&
      new Set(input).size === input.length,
    "validation_failed",
    `evidence_attachments 须为 1–${MAX_PENDING_EVIDENCE} 个不重复的附件编号`,
  );
  const timeline = [...d.state.timeline, ...d.timeline];
  return (input as AttachmentId[]).map((id) => {
    const attachment = d.get("attachments", id);
    const to = attachment.attach_to;
    const delivery =
      to.kind === "delivery"
        ? to.id
        : timeline.find((t) => t.id === to.id)?.delivery_id;
    ensure(
      attachment.card_id === card.id && delivery === target.id,
      "validation_failed",
      `附件 ${id} 没有绑定当前交付 ${target.id}，旧版本证据不能沿用；请作者在新交付上附证据`,
    );
    return id;
  });
}

/**
 * C-618 (flow >= 5): validate pending evidence and its later settlement.
 * Pending evidence never passes; a passing review must settle what this
 * verifier left pending with evidence bound to the reviewed version.
 */
export function reviewEvidence(
  d: CommandDraft,
  card: Card,
  item: WorkItem,
  target: Delivery,
  p: ReviewEvidenceInput,
  passes: boolean,
): ReviewEvidence {
  const outstanding = outstandingEvidence(d.list("reviews"), item.id);
  if (p.evidence_pending !== undefined) {
    ensure(
      flowAtLeast(card, 5),
      "validation_failed",
      "流程版本 ≥5 的卡才能标证据待补",
    );
    ensure(
      target.kind !== "card_completion",
      "validation_failed",
      "证据待补只用于产出交付的审核",
    );
    ensure(
      !p.recheck_required && p.followup_card_id === undefined,
      "validation_failed",
      "证据待补不能与 recheck_required 或 followup_card_id 同用；代码或功能问题照常写成必改项",
    );
    ensure(
      p.evidence_attachments === undefined &&
        p.evidence_not_applicable === undefined,
      "validation_failed",
      "仍在待补时不填 evidence_attachments 或 evidence_not_applicable",
    );
    const raw = p.evidence_pending as Partial<EvidencePending> | null;
    ensure(
      !!raw && typeof raw === "object",
      "validation_failed",
      "evidence_pending 须为 {items, blocker}",
    );
    return {
      evidence_pending: {
        items: pendingItems(d, card, item, raw.items),
        blocker: platformBlocker(d, card, raw.blocker),
      },
    };
  }
  const settled: {
    evidence_attachments?: AttachmentId[];
    evidence_not_applicable?: string;
  } = {};
  if (
    p.evidence_attachments !== undefined ||
    p.evidence_not_applicable !== undefined
  ) {
    ensure(
      !!outstanding,
      "validation_failed",
      "本验证项没有待补证据；evidence_attachments 和 evidence_not_applicable 只用于核对此前标为待补的证据",
    );
    if (p.evidence_attachments !== undefined)
      settled.evidence_attachments = versionBoundAttachments(
        d,
        card,
        target,
        p.evidence_attachments,
      );
    if (p.evidence_not_applicable !== undefined) {
      const reason = p.evidence_not_applicable;
      ensure(
        typeof reason === "string" &&
          reason.trim().length > 0 &&
          reason.trim().length <= 500,
        "validation_failed",
        "evidence_not_applicable 须为 1–500 字的理由",
      );
      settled.evidence_not_applicable = reason.trim();
    }
  }
  ensure(
    !passes ||
      !outstanding ||
      !!settled.evidence_attachments ||
      !!settled.evidence_not_applicable,
    "validation_failed",
    `${outstanding?.id} 标的证据待补尚未核对，证据待补不等于通过：用 evidence_attachments 引用绑定当前交付的证据附件，或用 evidence_not_applicable 说明为何不再适用；平台阻塞仍未解除时继续标 evidence_pending`,
  );
  return settled;
}

/** Timeline suffix for a review's pending or settled evidence. */
export function evidenceNote(review: Review): string {
  const pending = review.evidence_pending;
  if (pending)
    return review.verdict === "reject"
      ? `（另有证据待补 ${pending.items.length} 项，等待${platformBlockerLabel(pending.blocker)}）`
      : `（证据待补 ${pending.items.length} 项，等待${platformBlockerLabel(pending.blocker)}；不算驳回，不算通过）`;
  if (review.evidence_attachments)
    return `（待补证据已核对：${review.evidence_attachments.join("、")}）`;
  if (review.evidence_not_applicable) return "（待补证据已不适用）";
  return "";
}
