import type { CommandState } from "./commands/core.js";
import { suggestionBasis } from "./commands/decision-suggestion.js";
import {
  currentMergeConfirmations,
  humanMergeBlockers,
} from "./commands/merge-delegation.js";
import { fullEventHistory } from "./event-index.js";
import type { ExtMessageItem } from "./ext-message.js";
import type { CardId, WorkItemId } from "./ids.js";

/** The basis is host-only input to a digest. Never put it on an external card. */
export function extInteraction(s: CommandState, item: ExtMessageItem) {
  let sensitive = item.sensitive;
  const readOnly = () => ({
    sensitive,
    options: [] as { key: string; label: string }[],
    basis: "",
  });
  if (
    s.project_id !== item.project_id ||
    item.handled ||
    !item.ready ||
    item.kind === "notice"
  )
    return readOnly();
  const q = s.decisions.find((d) => d.id === item.item_id),
    h = s.human_actions.find((a) => a.id === item.item_id);
  const subject = q ?? h;
  if (!subject) return readOnly();
  const ids = new Set<CardId>();
  let missing = false;
  function work(id: WorkItemId) {
    const w = s.work_items.find((w) => w.id === id);
    if (w) ids.add(w.card_id);
    else missing = true;
  }
  // Follow the same edges for the requested item and every inherited source.
  // In particular, an approval may point to a delivery on a different card.
  const inspect = (d: typeof subject) => {
    if (d.card_id) ids.add(d.card_id);
    if (d.ready_when && "card_id" in d.ready_when)
      ids.add(d.ready_when.card_id);
    if ("blocked_work_items" in d) {
      for (const w of d.blocked_work_items) work(w);
      for (const w of d.follow_up_work_items ?? []) work(w);
      return;
    }
    for (const c of d.affected_cards) ids.add(c);
    for (const w of d.affected_work_items) work(w);
    if (d.kind !== "approve" || !("delivery_id" in d.target)) return;
    const id = d.target.delivery_id;
    const target = s.deliveries.find((row) => row.id === id);
    if (target) work(target.work_item_id);
    else missing = true;
    return target;
  };
  const target = inspect(subject);
  // Trace related facts, including a general merge confirmation whose source is restricted.
  const related = new Set<typeof subject>();
  related.add(subject);
  for (const id of ids) {
    const c = s.cards.find((c) => c.id === id);
    if (!c) {
      missing = true;
      continue;
    }
    if (c.sensitive) sensitive = true;
    for (const linked of c.related_cards) ids.add(linked);
    const source =
      c.source.kind === "decision" ? c.source.decision_id : undefined;
    if (source && !s.decisions.some((d) => d.id === source)) missing = true;
    for (const d of s.decisions) {
      if (
        d.id === source ||
        (item.kind === "merge_confirmation" &&
          (d.card_id === id ||
            d.affected_cards.includes(id) ||
            d.affected_work_items.some((w) =>
              s.work_items.some((i) => i.id === w && i.card_id === id),
            )))
      ) {
        related.add(d);
        inspect(d);
      }
    }
    if (item.kind === "merge_confirmation")
      for (const a of s.human_actions)
        if (
          a.card_id === id ||
          a.blocked_work_items.some((w) =>
            s.work_items.some((i) => i.id === w && i.card_id === id),
          )
        ) {
          related.add(a);
          inspect(a);
        }
  }
  if (missing) sensitive = true;
  if (
    sensitive ||
    [...related].some(
      (d) =>
        ![
          "general",
          "feature_detail",
          "spending",
          "account",
          "credential",
          "permission",
        ].includes(d.category ?? ""),
    )
  )
    return readOnly();
  if (
    q &&
    (q.status !== "open" ||
      q.decider !== "human" ||
      (q.trigger && q.trigger !== "merge_confirmation") ||
      (target && target.status === "superseded"))
  )
    return readOnly();
  if (h && (h.status !== "open" || (h.triage && h.triage !== "human")))
    return readOnly();
  const merge = q?.trigger === "merge_confirmation";
  if (
    merge &&
    (!q.card_id ||
      !currentMergeConfirmations(s, q.card_id).some((d) => d.id === q.id))
  )
    return readOnly();
  const blockers = merge ? humanMergeBlockers(s, q) : [];
  const options = h
    ? [{ key: "complete", label: "标记完成" }]
    : (q?.options ?? [])
        .filter(
          (o) =>
            !merge ||
            o.key === "hold" ||
            (o.key === "merge" && !blockers.length),
        )
        .map((o) => ({ key: o.key, label: o.description }));
  // A system Run ending can carry the decision ID (C-643: telemetry).
  const relevantEvents = fullEventHistory(s.events).filter(
    (e) =>
      !e.type.startsWith("ext_message_") &&
      ((e.type === "card_sensitivity_changed" &&
        e.card_id &&
        ids.has(e.card_id)) ||
        (merge &&
          e.card_id &&
          ids.has(e.card_id) &&
          /decision|merge|review|sensitive|human_action|delivery/u.test(
            e.type,
          )) ||
        (e.payload &&
          typeof e.payload === "object" &&
          (("decision_id" in e.payload && e.payload.decision_id === q?.id) ||
            ("human_action_id" in e.payload &&
              e.payload.human_action_id === h?.id)))),
  );
  return {
    sensitive,
    options,
    basis: JSON.stringify([
      subject,
      merge ? [...related] : [...related].map((d) => [d.id, d.category]),
      [...ids].sort(),
      target ? [target.subject, target.status] : null,
      merge ? suggestionBasis(s, q) : null,
      blockers,
      relevantEvents.map((e) => e.id),
      merge ? s.project_preferences : null,
    ]),
  };
}
