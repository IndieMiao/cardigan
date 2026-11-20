import { HttpRejection } from "./http.js";
import type { readPagedCard } from "./timeline-state.js";

type Detail = NonNullable<ReturnType<typeof readPagedCard>>;

/** The unqualified route remains the original full DTO. Section responses do
 * not overload a missing collection with the meaning 'this card has none'. */
export function cardSectionPayload(detail: Detail, section: string | null) {
  const {
    work_items,
    deliveries,
    reviews,
    review_matrix,
    attachments,
    ...head
  } = detail;
  switch (section) {
    case null:
      return detail;
    case "overview":
      return {
        ...head,
        overview: {
          work_count: work_items.length,
          completed_work_count: work_items.filter((w) =>
            ["accepted", "passed"].includes(w.status),
          ).length,
          verifiers: work_items
            .filter((w) => w.kind === "verify")
            .map(({ id, role_id, completion_criteria }) => ({
              id,
              role_id,
              completion_criteria,
              verdict:
                review_matrix.findLast((row) => row.work_item_id === id)
                  ?.verdict ?? null,
            })),
          attachment_count: attachments.length,
          completion_id: deliveries.findLast(
            (d) => d.kind === "card_completion" && d.status === "accepted",
          )?.id,
          waiting_delivery: work_items
            .filter(
              (w) => w.verification_activity?.status === "waiting_delivery",
            )
            .map((w) => w.id),
          conclusion_reviews: head.recent_conclusions.flatMap((e) => {
            const r = reviews.find((r) => r.id === e.review_id);
            if (!r) return [];
            const d = deliveries.find((d) => d.id === r.delivery_id);
            return [
              {
                id: r.id,
                verdict: r.verdict,
                delivery_id: r.delivery_id,
                work_title: work_items.find((w) => w.id === r.work_item_id)
                  ?.title,
                delivery_kind: d?.kind,
                delivery_status: d?.status,
              },
            ];
          }),
        },
      };
    case "work":
      return {
        work_items,
        work_delivery_links: deliveries.map(({ id, work_item_id, status }) => ({
          id,
          work_item_id,
          status,
        })),
      };
    case "records":
      return { deliveries, reviews, review_matrix };
    case "attachments":
      return { attachments };
    // The timeline can expand records and show attachments from any loaded
    // page. Fetch its lookups once, independently of the opaque paging cursor.
    case "timeline":
      return { work_items, deliveries, reviews, attachments };
    default:
      throw new HttpRejection(400, "validation_failed", "未知卡片区块");
  }
}
