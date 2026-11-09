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
import { mergePlan } from "./merge.js";
import { reopenMerge } from "./merge-rework.js";

export type MergeResult =
  | {
      readonly kind: "merged";
      readonly merge_sha: string;
      readonly previous_sha: string;
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
      result = {
        kind: r.kind,
        merge_sha: r.merge_sha,
        previous_sha: r.previous_sha,
      };
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
    const plan = unwrap(mergePlan(state, card.id));
    ensure(
      plan.completion_id === p.completion_id,
      "stale_target",
      "Merge result belongs to an older completion request",
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
    d.emit(
      type,
      card.id,
      {
        completion_id: p.completion_id,
        result,
        ...(work_item_id ? { work_item_id, run_kind: "fix" } : {}),
      },
      {
        type: "status_change",
        body: r.kind === "failed" ? r.reason : type,
        ...(work_item_id ? { work_item_id } : {}),
      },
    );
    return next;
  });
}
