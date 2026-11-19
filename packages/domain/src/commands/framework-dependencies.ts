import type { Card } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import type { CommandDraft } from "./core.js";

export const DEFAULT_FRAMEWORK_WAIT_REMINDER_MS = 4 * 60 * 60 * 1000;

function open(card: Card) {
  return card.status !== "done" && card.status !== "cancelled";
}

/** Record each newly formed pair on the dependent's stream in the editing transaction. */
export function recordFrameworkLinks(
  d: CommandDraft,
  card: Card,
  previous?: Card,
) {
  if (!open(card)) return;
  const link = (dependent: Card, framework: Card) => {
    const notice = `${dependent.id} 依赖界面框架卡 ${framework.id}。请优先合并框架，让只需要框架的后续卡不必等复杂交互。`;
    d.emit(
      "framework_dependency_linked",
      dependent.id,
      { framework_card_id: framework.id, notice },
      { type: "system", body: notice },
    );
  };
  for (const id of card.depends_on_cards ?? []) {
    if (previous?.depends_on_cards?.includes(id)) continue;
    const framework = d.get("cards", id);
    if (framework.is_ui_framework && open(framework)) link(card, framework);
  }
  if (card.is_ui_framework && !previous?.is_ui_framework) {
    for (const dependent of d.list("cards"))
      if (
        dependent.project_id === card.project_id &&
        open(dependent) &&
        dependent.depends_on_cards?.includes(card.id)
      )
        link(dependent, card);
  }
}

/** A link event starts a wait episode; removing/re-adding the edge or marker starts a new one. */
export function remindFrameworkWaits(d: CommandDraft, thresholdMs: number) {
  const links = eventsOfType(d.state.events, "framework_dependency_linked");
  if (!links.length) return;
  const cards = new Map(
    d.state.cards
      .filter((c) => c.project_id === d.state.project_id)
      .map((c) => [c.id, c]),
  );
  const reminded = new Set(
    eventsOfType(d.state.events, "framework_dependency_overdue").map(
      (e) => (e.payload as { link_event_id: string }).link_event_id,
    ),
  );
  const seen = new Set<string>();
  const now = Date.parse(d.now);
  // Events within a dependent's stream are in ascending seq order.
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    if (!link?.card_id) continue;
    const frameworkId = (link.payload as { framework_card_id: Card["id"] })
      .framework_card_id;
    const key = `${link.card_id}:${frameworkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      reminded.has(link.id) ||
      now - Date.parse(link.created_at) <= thresholdMs
    )
      continue;
    const dependent = cards.get(link.card_id),
      framework = cards.get(frameworkId);
    if (
      !dependent ||
      !framework?.is_ui_framework ||
      !dependent.depends_on_cards?.includes(frameworkId) ||
      !open(dependent) ||
      !open(framework) ||
      dependent.early_start ||
      dependent.hold ||
      framework.hold
    )
      continue;
    const notice = `${dependent.id} 等待框架卡 ${frameworkId} 已超过阈值；请评估进一步拆分，或写明理由后提前开工。完成和合并仍须等待前置卡。`;
    d.emit(
      "framework_dependency_overdue",
      dependent.id,
      {
        framework_card_id: frameworkId,
        link_event_id: link.id,
        threshold_ms: thresholdMs,
        notice,
      },
      { type: "system", body: notice },
    );
  }
}
