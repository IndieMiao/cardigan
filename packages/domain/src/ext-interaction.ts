import type { CommandState } from "./commands/core.js";
import { suggestionBasis } from "./commands/decision-suggestion.js";
import {
  currentMergeConfirmations,
  humanMergeBlockers,
} from "./commands/merge-delegation.js";
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
  if (subject.card_id) ids.add(subject.card_id);
  if (subject.ready_when && "card_id" in subject.ready_when)
    ids.add(subject.ready_when.card_id);
  for (const c of q?.affected_cards ?? []) ids.add(c);
  for (const w of q?.affected_work_items ?? h?.blocked_work_items ?? [])
    work(w);
  const deliveryId =
    q?.kind === "approve" && "delivery_id" in q.target
      ? q.target.delivery_id
      : undefined;
  const target = deliveryId
    ? s.deliveries.find((d) => d.id === deliveryId)
    : undefined;
  if (q?.kind === "approve" && "delivery_id" in q.target) {
    if (target) work(target.work_item_id);
    else missing = true;
  }
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
        if (d.card_id) ids.add(d.card_id);
        for (const a of d.affected_cards) ids.add(a);
        for (const w of d.affected_work_items) work(w);
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
          if (a.card_id) ids.add(a.card_id);
          for (const w of a.blocked_work_items) work(w);
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
        ].includes(d.category ?? "general"),
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
  const relevantEvents = s.events.filter(
    (e) =>
      !e.type.startsWith("ext_message_") &&
      ((e.card_id &&
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
      [...related],
      target?.subject,
      q ? suggestionBasis(s, q) : null,
      blockers,
      relevantEvents.map((e) => e.id),
      merge ? s.project_preferences : null,
    ]),
  };
}
