import type { CommandState } from "./commands/core.js";
import { suggestionBasis } from "./commands/decision-suggestion.js";
import {
  currentMergeConfirmations,
  humanMergeBlockers,
} from "./commands/merge-delegation.js";
import {
  DECISION_OTHER_OPTION,
  humanDecisionOptions,
} from "./decision-other.js";
import type { Event } from "./entities.js";
import {
  eventsForDecision,
  eventsForHumanAction,
  fullEventHistory,
  streamEvents,
} from "./event-index.js";
import { historyIndex } from "./event-log.js";
import type { ExtMessageItem } from "./ext-message.js";
import { isOperatorAction } from "./human-action-executor.js";
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
  if (
    h &&
    (h.status !== "open" ||
      (h.triage && h.triage !== "human") ||
      isOperatorAction(h))
  )
    return readOnly();
  const merge = q?.trigger === "merge_confirmation";
  if (
    merge &&
    (!q.card_id ||
      !currentMergeConfirmations(s, q.card_id).some((d) => d.id === q.id))
  )
    return readOnly();
  const blockers = merge ? humanMergeBlockers(s, q) : [];
  // C-682: "其他" follows the raiser's options; the Feishu note is its words.
  const options = h
    ? [{ key: "complete", label: "标记完成" }]
    : humanDecisionOptions(q?.options ?? [])
        .filter(
          (o) =>
            !merge ||
            o.key === "hold" ||
            o.key === DECISION_OTHER_OPTION ||
            (o.key === "merge" && !blockers.length),
        )
        .map((o) => ({ key: o.key, label: o.description }));
  // A system Run ending can carry the decision ID (C-643: telemetry).
  // C-671: the related cards' streams and the item's own events come from
  // the indexes, so a closed related card still counts in `slim`.
  const relevant = new Set<Event>();
  for (const id of ids)
    for (const e of streamEvents(s.events, id))
      if (
        !e.type.startsWith("ext_message_") &&
        (e.type === "card_sensitivity_changed" ||
          (merge &&
            /decision|merge|review|sensitive|human_action|delivery/u.test(
              e.type,
            )))
      )
        relevant.add(e);
  for (const e of [
    ...(q ? eventsForDecision(s.events, q.id) : []),
    ...(h ? eventsForHumanAction(s.events, h.id) : []),
  ])
    if (!e.type.startsWith("ext_message_")) relevant.add(e);
  const relevantEvents = historyOrdered(s, relevant);
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

/**
 * `subset` in the order of `fullEventHistory(s.events)`. A Store history is
 * the project stream, then each card's stream (seq ascending) in card order;
 * other arrays keep their own order.
 */
function historyOrdered(s: CommandState, subset: ReadonlySet<Event>) {
  if (!historyIndex(s.events))
    return fullEventHistory(s.events).filter((e) => subset.has(e));
  const rank = new Map<string, number>(s.cards.map((c, i) => [c.id, i + 1]));
  const at = (e: Event) => (e.card_id ? (rank.get(e.card_id) ?? -1) : 0);
  return [...subset].sort((a, b) => at(a) - at(b) || a.seq - b.seq);
}
