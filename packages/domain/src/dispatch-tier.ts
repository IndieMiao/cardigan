import type { CommandState } from "./commands/core.js";
import { latestMergeCheck } from "./commands/merge-check.js";
import type { Assignment, Event, Run } from "./entities.js";
import { runById } from "./run-index.js";
import { originalRunTrigger } from "./run-trigger.js";

type DispatchState = Pick<
  CommandState,
  "project_id" | "assignments" | "work_items" | "deliveries" | "runs" | "events"
>;

/** The same inference is used before creating a Run and when queueing it. */
export function dispatchRunKind(
  event: Event | undefined,
  assignment: Assignment,
  review = false,
): Run["kind"] {
  if (event?.type === "work_item_assigned") return "initial";
  if (
    ["merge_conflicted", "merge_changes_requested"].includes(event?.type ?? "")
  )
    return "fix";
  if (
    event?.type === "review_reuse_invalidated" ||
    (event?.type === "decision_resolved" &&
      assignment.scope === "work_item" &&
      (event.payload as Record<string, unknown> | null)?.rework_work_item_id ===
        assignment.work_item_id) ||
    (review &&
      ["review_submitted", "completion_reviewed"].includes(event?.type ?? ""))
  )
    return "rework";
  return (event?.type === "decision_resolved" ||
    (event?.type === "work_item_resume_requested" &&
      (event.payload as Record<string, unknown> | null)?.kind ===
        "decision_resumed")) &&
    assignment.scope === "work_item"
    ? "decision_resumed"
    : "followup";
}

/** Ranking only: callers must still apply every existing eligibility fence. */
export function dispatchTier(
  state: DispatchState,
  assignment: Assignment,
  run: Run | undefined,
  trigger: Event | undefined,
  kind = run?.kind ?? dispatchRunKind(trigger, assignment),
): { dispatch_tier: 1 | 2 | 3 | 4; dispatch_reason: string } {
  const item =
    assignment.scope === "work_item"
      ? state.work_items.find((w) => w.id === assignment.work_item_id)
      : undefined;
  if (item) {
    const cause = run ? originalRunTrigger(state, run) : trigger;
    const p = cause?.payload as Record<string, unknown> | null | undefined;
    const completion = state.deliveries.find(
      (d) => d.id === p?.completion_id && d.kind === "card_completion",
    );
    const completionItem = state.work_items.find(
      (w) => w.id === completion?.work_item_id,
    );
    const trusted =
      cause?.actor.project_id === state.project_id &&
      (cause.actor.kind === "human" ||
        cause.actor.kind === "system" ||
        (cause.actor.kind === "assignment" && cause.actor.role_id === "pm"));
    if (
      item.kind === "produce" &&
      kind === "fix" &&
      trusted &&
      cause?.card_id === item.card_id &&
      p?.work_item_id === item.id &&
      completion !== undefined &&
      completionItem?.card_id === item.card_id
    ) {
      if (cause.type === "merge_conflicted" && cause.actor.kind === "system")
        return {
          dispatch_tier: 1,
          dispatch_reason: "第1档 · 合并修复：已确认合并冲突",
        };
      const check = latestMergeCheck(
        state.events.filter(
          (e) =>
            e.seq < cause.seq &&
            e.actor.kind === "system" &&
            e.actor.project_id === state.project_id,
        ),
        item.card_id,
        completion.id,
      );
      if (
        cause.type === "merge_changes_requested" &&
        check &&
        ["failed", "timed_out"].includes(check.status)
      )
        return {
          dispatch_tier: 1,
          dispatch_reason: "第1档 · 合并修复：合并检查失败后退回",
        };
    }
    if (item.kind === "verify")
      return {
        dispatch_tier: 2,
        dispatch_reason: "第2档 · 验证：审核、复核或验收",
      };
    const delivered = state.deliveries.some((d) => {
      if (d.work_item_id !== item.id || d.kind === "card_completion")
        return false;
      const source = runById(state.runs, d.run_id);
      return (
        source &&
        source.id !== run?.id &&
        state.assignments.some(
          (a) =>
            a.id === source.assignment_id &&
            a.scope === "work_item" &&
            a.work_item_id === item.id,
        )
      );
    });
    if (
      item.kind === "produce" &&
      delivered &&
      ["rework", "followup", "decision_resumed"].includes(kind)
    )
      return {
        dispatch_tier: 3,
        dispatch_reason: "第3档 · 交付后续：同一工作项已有正式交付",
      };
  }
  return {
    dispatch_tier: 4,
    dispatch_reason: "第4档 · 新产出：首次开工或收尾证据不足",
  };
}
