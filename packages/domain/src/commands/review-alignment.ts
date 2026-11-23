import type { TimelineEntry, WorkItem } from "../entities.js";
import type { WorkItemId } from "../ids.js";
import { MAX_ALIGNMENT_INVARIANTS } from "../review-convergence.js";
import { type CommandDraft, ensure } from "./core.js";
import { applyFlowReviewLimit } from "./flow-review-limit.js";
import { requestReviewLimit } from "./review-limit.js";
import { currentReviewTarget, openAlignment } from "./review-round.js";

export type ReviewAlignmentComment = {
  readonly work_item_id: WorkItemId;
  readonly step: "propose" | "confirm" | "dispute";
  readonly invariants?: readonly string[];
};

function instruct(
  d: CommandDraft,
  recipient: WorkItem,
  verifier: WorkItem,
  body: string,
) {
  d.emit(
    "instruction_issued",
    recipient.card_id,
    { work_item_id: recipient.id, alignment_work_item_id: verifier.id },
    {
      type: "instruction",
      author: "system",
      work_item_id: recipient.id,
      body,
    },
    { kind: "system", project_id: d.state.project_id },
  );
}

/** C-610: author and verifier settle the invariants of a rejection streak. */
export function recordReviewAlignment(
  d: CommandDraft,
  entry: TimelineEntry,
  p: ReviewAlignmentComment,
) {
  const verifier = d.work(p.work_item_id);
  const card = d.card(entry.card_id);
  const alignment = openAlignment(d, verifier);
  ensure(
    verifier.kind === "verify" &&
      verifier.card_id === card.id &&
      !!alignment &&
      !["done", "cancelled", "awaiting_merge"].includes(card.status),
    "illegal_transition",
    "该验证项没有进行中的对齐回合",
  );
  const producer = d.work(
    d.get("deliveries", d.get("reviews", alignment.review_id).delivery_id)
      .work_item_id,
  );
  const a = d.assignment;
  ensure(
    a?.scope === "work_item" &&
      (a.work_item_id === verifier.id || a.work_item_id === producer.id),
    "unauthorized",
    "只有本次驳回的作者和审核员参与对齐回合",
  );
  d.ownWork(a.work_item_id);
  const other = a.work_item_id === verifier.id ? producer : verifier;
  if (p.step === "propose") {
    const invariants = (Array.isArray(p.invariants) ? p.invariants : []).map(
      (text) => (typeof text === "string" ? text.trim() : ""),
    );
    ensure(
      invariants.length > 0 &&
        invariants.length <= MAX_ALIGNMENT_INVARIANTS &&
        invariants.every((text) => text.length > 0 && text.length <= 300),
      "validation_failed",
      `invariants 须为 1–${MAX_ALIGNMENT_INVARIANTS} 条、每条 1–300 字的不变量`,
    );
    d.put("work_items", {
      ...verifier,
      review_alignment: {
        ...alignment,
        proposal: { entry_id: entry.id, by: a.id, invariants },
      },
    });
    instruct(
      d,
      other,
      verifier,
      `对齐回合：请核对 ${entry.id} 提出的不变量清单。同意时用 post_comment 回复该条（reply_to），传 review_alignment={work_item_id:"${verifier.id}",step:"confirm"}；有分歧时传 step:"dispute" 并写明分歧，系统交 PM 裁决。也可以提出修改后的清单（step:"propose"）。`,
    );
    return;
  }
  const proposal = alignment.proposal;
  ensure(
    proposal &&
      entry.reply_to === proposal.entry_id &&
      ["confirm", "dispute"].includes(p.step),
    "validation_failed",
    "请回复当前的不变量提案",
  );
  ensure(proposal.by !== a.id, "unauthorized", "提案需由对方确认或提出分歧");
  if (p.step === "dispute") {
    const disputed = {
      ...verifier,
      review_alignment: {
        ...alignment,
        status: "disputed" as const,
        reply_entry_id: entry.id,
      },
    };
    d.put("work_items", disputed);
    d.emit(
      "review_alignment_disputed",
      card.id,
      {
        work_item_id: verifier.id,
        review_id: alignment.review_id,
        proposal_entry_id: proposal.entry_id,
        reply_entry_id: entry.id,
      },
      {
        type: "system",
        author: "system",
        work_item_id: verifier.id,
        body: `${verifier.id} 对齐回合未达成一致，交 PM 裁决。`,
      },
      { kind: "system", project_id: d.state.project_id },
    );
    requestReviewLimit(d, disputed);
    return;
  }
  const first = (card.invariants?.length ?? 0) + 1;
  d.put("cards", {
    ...card,
    invariants: [
      ...(card.invariants ?? []),
      ...proposal.invariants.map((text) => ({
        text,
        work_item_id: verifier.id,
        entry_id: proposal.entry_id,
      })),
    ],
  });
  d.put("work_items", {
    ...verifier,
    review_alignment: {
      ...alignment,
      status: "agreed",
      reply_entry_id: entry.id,
    },
  });
  const last = first + proposal.invariants.length - 1;
  applyFlowReviewLimit(d, d.work(verifier.id));
  const target = currentReviewTarget(d, verifier);
  const reviewed =
    !target ||
    d
      .list("reviews")
      .some(
        (r) => r.delivery_id === target.id && r.work_item_id === verifier.id,
      );
  d.emit(
    "review_alignment_agreed",
    card.id,
    {
      work_item_id: verifier.id,
      producer_id: producer.id,
      review_id: alignment.review_id,
      proposal_entry_id: proposal.entry_id,
      reply_entry_id: entry.id,
      invariants: [...proposal.invariants],
      first_invariant: first,
      ...(target ? { delivery_id: target.id } : {}),
      wake: reviewed ? "producer" : "verifier",
    },
    {
      type: "system",
      author: "system",
      work_item_id: verifier.id,
      body: `${verifier.id} 对齐回合已达成一致：不变量写入本卡 INV${first}${last > first ? `–INV${last}` : ""}，系统恢复审核。之后的必改项只能引用通过条件清单、这些不变量或常驻不变量。`,
    },
    { kind: "system", project_id: d.state.project_id },
  );
}
