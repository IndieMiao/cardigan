import { isReviewStale } from "./derived.js";
import type { Delivery, Event, Review, Run, WorkItem } from "./entities.js";

export interface VerificationActivity {
  readonly status: string;
  readonly label: string;
  readonly delivery_id?: string;
}
type Input = {
  readonly deliveries: readonly Delivery[];
  readonly reviews: readonly Review[];
  readonly runs: readonly Run[];
  readonly events: readonly Event[];
};

/** One current target per verifier, shared by workflow summaries and Web activity. */
export function verificationTarget(
  item: WorkItem,
  input: Pick<Input, "deliveries" | "reviews">,
): Delivery | undefined {
  if (item.kind !== "verify") return undefined;
  const superseded = new Set(
    input.deliveries.flatMap((v) => (v.supersedes ? [v.supersedes] : [])),
  );
  const latest = input.deliveries
    .filter(
      (v) =>
        v.status !== "superseded" &&
        !superseded.has(v.id) &&
        (item.target_work_item_id
          ? v.work_item_id === item.target_work_item_id &&
            v.kind !== "card_completion"
          : v.kind === "card_completion" &&
            v.requested_verifiers.includes(item.id)),
    )
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
    .at(-1);
  return latest?.status === "submitted" &&
    latest.requested_verifiers.includes(item.id) &&
    !input.reviews.some(
      (r) => r.work_item_id === item.id && !isReviewStale(r, latest),
    )
    ? latest
    : undefined;
}

/** An Assignment is ownership; only a current, reviewable target is work. */
export function verificationActivity(
  item: WorkItem,
  input: Input,
): VerificationActivity | undefined {
  if (item.kind !== "verify") return undefined;
  if (
    ["passed", "cancelled", "failed", "blocked", "waiting_decision"].includes(
      item.status,
    )
  )
    return undefined;
  const target = verificationTarget(item, input);
  if (!target) return { status: "waiting_delivery", label: "等待新交付" };
  const run = input.runs
    .filter(
      (r) =>
        r.assignment_id === item.assignment_id &&
        !["completed", "failed", "cancelled"].includes(r.status),
    )
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
    .at(-1);
  const submitted = input.events.find(
    (e) =>
      e.type === "delivery_submitted" &&
      (e.payload as { delivery_id?: string }).delivery_id === target.id,
  );
  const started =
    run &&
    input.events.find(
      (e) =>
        e.type === "run_started" &&
        (e.payload as { run_id?: string }).run_id === run.id,
    );
  const current =
    run &&
    submitted &&
    started &&
    started.card_id === submitted.card_id &&
    started.seq > submitted.seq;
  if (current && ["acked", "running"].includes(run.status))
    return { status: "running", label: "正在审核", delivery_id: target.id };
  if (run?.status === "unknown")
    return {
      status: "unknown",
      label: "审核执行状态待确认",
      delivery_id: target.id,
    };
  if (item.manual_assign)
    return {
      status: "manual_assign",
      label: "待审核 · 手动派活",
      delivery_id: target.id,
    };
  if (run?.status === "queued")
    return { status: "queued", label: "审核排队中", delivery_id: target.id };
  if (run?.status === "dispatched")
    return {
      status: "dispatched",
      label: "审核启动中",
      delivery_id: target.id,
    };
  return { status: "ready", label: "待审核", delivery_id: target.id };
}
