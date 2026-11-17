import type { Actor, WorkItem } from "../entities.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  ensure,
  unwrap,
} from "./core.js";
import { invalidateCompletion } from "./system-completion-invalidation.js";
import { commandWithReadyVerifiers as command } from "./system-rules.js";

/** Repair pre-upgrade omissions through the normal transactional workflow. */
export function refreshRequiredVerifiers(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(state, actor, "refresh_required_verifiers", ports, (d) => {
    for (const item of d.list("work_items")) {
      if (d.card(item.card_id).hold) continue;
      bindRequiredVerifier(d, item);
    }
  });
}

/** A newly required verifier joins the current product without a new delivery. */
export function bindRequiredVerifier(
  d: CommandDraft,
  item: WorkItem,
): WorkItem {
  if (
    item.kind !== "verify" ||
    !item.required ||
    !item.target_work_item_id ||
    item.status !== "todo" ||
    item.replaced_by_work_item_id ||
    item.reported_blocker
  )
    return item;
  const card = d.card(item.card_id);
  const producer = d.work(item.target_work_item_id);
  ensure(
    producer.kind === "produce" && producer.card_id === card.id,
    "invariant_violation",
    "Verification target must be a producing work item on this card",
  );
  if (
    ["done", "cancelled"].includes(card.status) ||
    producer.status === "cancelled" ||
    d.state.events.some(
      (e) => e.card_id === card.id && e.type === "card_merged",
    )
  )
    return item;
  // Select before checking status: an obsolete latest version must never
  // cause a historical delivery to become reviewable again.
  const target = d
    .list("deliveries")
    .filter(
      (v) => v.work_item_id === producer.id && v.kind !== "card_completion",
    )
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  if (
    !target ||
    !["submitted", "accepted"].includes(target.status) ||
    target.requested_verifiers.includes(item.id)
  )
    return item;
  d.put("deliveries", {
    ...target,
    status:
      target.status === "accepted"
        ? unwrap(transition("delivery", target.status, "require_review"))
        : target.status,
    requested_verifiers: [...target.requested_verifiers, item.id],
  });
  if (producer.status === "accepted")
    d.put("work_items", d.move(producer, "delivery_submitted"));
  const ready = d.move(item, "target_delivered");
  d.put("work_items", ready);
  for (const completion of d.list("deliveries"))
    if (
      completion.kind === "card_completion" &&
      completion.status !== "superseded" &&
      d.work(completion.work_item_id).card_id === card.id
    )
      invalidateCompletion(d, card, completion, "required_verifier_added");
  d.emit(
    "delivery_verifier_added",
    card.id,
    {
      delivery_id: target.id,
      target_work_item_id: producer.id,
      work_item_id: item.id,
      target_sha: target.subject.value,
      previous_status: target.status,
    },
    {
      type: "system",
      work_item_id: item.id,
      delivery_id: target.id,
      body: `新增必需验证项 ${item.id} 已加入交付 ${target.id}，等待审核。`,
    },
  );
  return ready;
}
