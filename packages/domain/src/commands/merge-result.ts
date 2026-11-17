import type { Actor, Card, JsonValue } from "../entities.js";
import type { CardId, DeliveryId, WorkItemId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { mergePlan, prepareMergePlan } from "./merge.js";
import { hasPassedMergeCheck } from "./merge-check.js";
import { queueMergedPush } from "./merge-push.js";
import { reopenMerge } from "./merge-rework.js";
import { openConflictWindow } from "./merge-window.js";

export type MergeResult =
  | {
      readonly kind: "merged";
      readonly merge_sha: string;
      readonly previous_sha: string;
      /** Host reads this tree from the exact candidate being published. */
      readonly tree_sha?: string;
      /** Host verified every planned delivery is already an ancestor of this unchanged baseline. */
      readonly noop?: boolean;
    }
  | {
      readonly kind: "conflicted";
      readonly delivery_id: DeliveryId;
      readonly files: readonly string[];
    }
  | { readonly kind: "failed"; readonly reason: string };
/** completion_id binds late/replayed Git results to the accepted version. */
export function recordMergeResult(
  state: CommandState,
  actor: Actor,
  p: { card_id: CardId; completion_id: DeliveryId; result: MergeResult },
  ports: CommandPorts,
) {
  return command(state, actor, "record_merge_result", ports, (d): Card => {
    const card = d.card(p.card_id);
    const r = p.result;
    let result: JsonValue;
    if (r.kind === "merged") {
      ensure(
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(r.merge_sha) &&
          r.previous_sha.length === r.merge_sha.length &&
          /^[a-f0-9]+$/u.test(r.previous_sha),
        "validation_failed",
        "Merge result requires full commit SHAs",
      );
      ensure(
        (r.noop === undefined || typeof r.noop === "boolean") &&
          (r.tree_sha === undefined ||
            (r.tree_sha.length === r.merge_sha.length &&
              /^[a-f0-9]+$/u.test(r.tree_sha))),
        "validation_failed",
        "Invalid merged tree or no-op marker",
      );
      result = {
        kind: r.kind,
        merge_sha: r.merge_sha,
        previous_sha: r.previous_sha,
        ...(r.tree_sha ? { tree_sha: r.tree_sha } : {}),
        ...(r.noop ? { noop: true } : {}),
      };
      ensure(
        !r.noop || r.merge_sha === r.previous_sha,
        "invariant_violation",
        "No-op cannot change the baseline",
      );
    } else if (r.kind === "conflicted") {
      ensure(
        r.files.length > 0 && r.files.every((f) => f.trim()),
        "validation_failed",
        "Conflict files are required",
      );
      result = {
        kind: r.kind,
        delivery_id: r.delivery_id,
        files: [...new Set(r.files)].sort(),
      };
    } else {
      ensure(r.kind === "failed", "validation_failed", "Invalid merge result");
      text(r.reason, "reason");
      result = { kind: r.kind, reason: r.reason };
    }
    const planOnly =
      r.kind === "conflicted" &&
      r.files.every((path) => path === "docs/development-plan.md");
    const type =
      r.kind === "merged"
        ? "card_merged"
        : r.kind === "conflicted"
          ? "merge_conflicted"
          : "merge_failed";
    if (
      state.events.some((e) => {
        const payload = e.payload as {
          completion_id?: string;
          result?: JsonValue;
        } | null;
        return (
          e.card_id === card.id &&
          e.type === type &&
          payload?.completion_id === p.completion_id &&
          JSON.stringify(payload.result) === JSON.stringify(result)
        );
      })
    )
      return card;
    const plan = unwrap(
      state.project_settings?.merge_gate_enabled && r.kind !== "merged"
        ? prepareMergePlan(state, card.id)
        : mergePlan(state, card.id),
    );
    ensure(
      plan.completion_id === p.completion_id,
      "stale_target",
      "Merge result belongs to an older completion request",
    );
    if (
      r.kind === "merged" &&
      state.project_settings?.merge_gate_enabled &&
      !r.noop
    )
      ensure(
        r.tree_sha &&
          hasPassedMergeCheck(
            state.events,
            card.id,
            p.completion_id,
            r.tree_sha,
            r.previous_sha,
          ),
        "invariant_violation",
        "Invariant 21: the merged tree requires a passed check for this completion",
      );
    ensure(
      r.kind !== "merged" || r.noop || !state.project_settings?.merge_queue,
      "invariant_violation",
      "Queued projects can only publish through a checked batch",
    );
    let next = card;
    let work_item_id: WorkItemId | undefined;
    if (r.kind === "merged")
      next = {
        ...card,
        status: unwrap(transition("card", card.status, "merge_succeeded")),
        resolution: "done",
      };
    if (r.kind === "conflicted") {
      const target = plan.deliveries.find(
        (v) => v.delivery_id === r.delivery_id,
      );
      ensure(
        target,
        "stale_target",
        "Conflicting delivery is not in the current merge plan",
      );
      work_item_id = target.work_item_id;
      next = reopenMerge(
        d,
        card,
        d.get("deliveries", plan.completion_id),
        target.work_item_id,
        "merge_conflicted",
      );
    }
    if (next !== card) d.put("cards", next);
    const event = d.emit(
      type,
      card.id,
      {
        completion_id: p.completion_id,
        result,
        ...(planOnly
          ? {
              conflict_kind: "development_plan",
              guidance:
                "只在开发方案发生冲突，请保留双方正文后重新交付；冲突修复不消耗审核轮数。",
            }
          : {}),
        ...(work_item_id ? { work_item_id, run_kind: "fix" } : {}),
      },
      {
        type: "status_change",
        body:
          r.kind === "failed"
            ? r.reason
            : planOnly
              ? "只在 docs/development-plan.md 发生冲突，请作者保留双方正文后重新交付；不消耗审核轮数。"
              : type,
        ...(work_item_id ? { work_item_id } : {}),
      },
    );
    if (r.kind === "conflicted") openConflictWindow(d, card);
    if (r.kind === "merged")
      queueMergedPush(d, {
        merge_event_id: event.id,
        card_id: card.id,
        completion_id: p.completion_id,
        sha: r.merge_sha,
      });
    return next;
  });
}
