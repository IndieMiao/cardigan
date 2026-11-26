import {
  type CardDependencyState,
  unmetCardDependencies,
} from "../card-dependencies.js";
import type { Card, CardCloseRequest, WorkItem } from "../entities.js";
import { eventById, streamEvents } from "../event-index.js";
import type { CardId } from "../ids.js";
import { isTerminalNotification, type Notification } from "../notification.js";
import { cardTemplate, isStoryTemplate } from "../templates.js";
import { transition } from "../transitions.js";
import { dependencyState } from "./card-dependencies.js";
import { type CommandDraft, type CommandState, ensure, text } from "./core.js";
import { workCompleted } from "./work-status.js";

const field = (p: unknown, name: string) =>
  p && typeof p === "object" ? (p as Record<string, unknown>)[name] : undefined;

export type CardCloseRequestInput = Pick<CardCloseRequest, "reason"> | null;

/**
 * C-750: why the owner cannot mark a non-story card done right now, or
 * undefined when `markCardDone` would accept it. Mirrors that command's
 * non-story checks (terminal status, hold, template, prerequisite cards,
 * every required work item accepted or passed) without throwing, so the
 * Needs You list never offers a mark-done that is known to fail.
 */
function closeBlocker(
  d: CommandDraft,
  card: Card,
  required: readonly WorkItem[],
  dependencies: () => CardDependencyState,
): string | undefined {
  if (card.story) return "需求卡按对照总结结项";
  if (!transition("card", card.status, "human_mark_done").ok)
    return "卡片已结束";
  if (card.hold) return "卡片已暂停，请先解除暂停";
  const template = cardTemplate(card, [
    ...(d.ports?.templates ?? []),
    ...d.list("card_templates"),
  ]);
  if (!template) return "卡片使用的模板版本不存在";
  if (isStoryTemplate(template)) return "需求卡按对照总结结项";
  if (template.completion.mode !== "human_mark_done")
    return "该模板不允许人标记完成";
  if (card.depends_on_cards?.length) {
    const missing = unmetCardDependencies(dependencies(), card);
    if (missing.length) return `前置卡尚未正常完成：${missing.join("、")}`;
  }
  if (!required.every(workCompleted)) return "必需工作项尚未全部完成";
  return undefined;
}

function requiredItems(d: CommandDraft) {
  const byCard = new Map<CardId, WorkItem[]>();
  for (const item of d.list("work_items"))
    if (item.required)
      byCard.set(item.card_id, [...(byCard.get(item.card_id) ?? []), item]);
  return byCard;
}

export interface CardAwaitingOwnerClose {
  readonly card_id: CardId;
  readonly card_title: string;
  readonly template: string;
  readonly required_work_items: number;
  readonly close_request: CardCloseRequest | null;
  /** When the card became closable: its last required-item event or PM's request. */
  readonly since: string | null;
}

/**
 * C-750 "待你标记完成": open, non-story human_mark_done cards the owner can
 * mark done now. A card with required work items is listed once they have all
 * been accepted or passed; one without (general rules, investigations) only
 * after PM asked via `close_request`. Derived, so there is one entry per card
 * and it disappears once the card is done or cancelled. Nothing is pushed.
 */
export function cardsAwaitingOwnerClose(
  d: CommandDraft,
): CardAwaitingOwnerClose[] {
  const required = requiredItems(d);
  let dependencies: CardDependencyState | undefined;
  const deps = () => {
    dependencies ??= dependencyState(d);
    return dependencies;
  };
  return d.list("cards").flatMap((card) => {
    if (card.story || ["done", "cancelled"].includes(card.status)) return [];
    const items = required.get(card.id) ?? [];
    if (!items.length && !card.close_request) return [];
    if (closeBlocker(d, card, items, deps)) return [];
    const ids = new Set<string>(items.map((w) => w.id));
    const settled = streamEvents(d.state.events, card.id).findLast((e) => {
      const id = field(e.payload, "work_item_id");
      return typeof id === "string" && ids.has(id);
    })?.created_at;
    const since = [settled, card.close_request?.set_at]
      .filter((at): at is string => !!at)
      .sort()
      .at(-1);
    return [
      {
        card_id: card.id,
        card_title: card.title,
        template: card.template,
        required_work_items: items.length,
        close_request: card.close_request ? { ...card.close_request } : null,
        since: since ?? null,
      },
    ];
  });
}

/**
 * C-750: PM asks the owner to close a finished card, with a reason shown on
 * the owner's Needs You item; `null` withdraws it. Only for a card the owner
 * could mark done now. Never marks the card done and never pushes externally.
 */
export function applyCloseRequest(
  d: CommandDraft,
  card: Card,
  input: CardCloseRequestInput,
) {
  d.pm();
  d.projectAccess();
  if (input !== null) {
    ensure(
      typeof input === "object" &&
        Object.keys(input).every((k) => k === "reason"),
      "validation_failed",
      "请所有者结卡只接受理由",
    );
    text(input.reason, "结卡理由");
    const blocker = closeBlocker(
      d,
      card,
      d.list("work_items").filter((w) => w.card_id === card.id && w.required),
      () => dependencyState(d),
    );
    ensure(!blocker, "illegal_transition", `不能请所有者结卡：${blocker}`);
  }
  if (
    (!input && !card.close_request) ||
    (input && card.close_request?.reason === input.reason.trim())
  )
    return card;
  const { close_request: previous, ...rest } = card;
  const request: CardCloseRequest | undefined = input
    ? { reason: input.reason.trim(), set_by: d.author, set_at: d.now }
    : undefined;
  const result: Card = {
    ...rest,
    ...(request ? { close_request: request } : {}),
  };
  d.put("cards", result);
  const notice = request
    ? `请所有者标记完成：${request.reason}`
    : "已撤回请所有者结卡";
  d.emit(
    request ? "card_close_requested" : "card_close_request_withdrawn",
    card.id,
    {
      card_id: card.id,
      notice,
      previous_close_request: previous ? { ...previous } : null,
      close_request: request ? { ...request } : null,
    },
    { type: "status_change", body: notice },
  );
  return result;
}

/** Human actions an event was raised for: its own id or its reminders'. */
function humanActionIds(payload: unknown): string[] {
  const own = field(payload, "human_action_id");
  const reminders = field(payload, "reminders");
  return [
    ...(typeof own === "string" ? [own] : []),
    ...(Array.isArray(reminders)
      ? reminders.flatMap((r) => {
          const id = field(r, "human_action_id");
          return typeof id === "string" ? [id] : [];
        })
      : []),
  ];
}

/**
 * C-750: an owner (`needs_you`) notification raised for human actions that
 * have all been completed or cancelled. Such rows never ring and nobody ACKs
 * them, so the dispatcher resolves them; existing ones go on its next pass.
 * A missing event or action is not proof, so the row stays. C-788: only a
 * `needs_you` row whose source event payload carries `human_action_id` or a
 * `reminders` array can match; callers may leave other rows out of a scan.
 */
export function settledHumanActionNeedsYou(
  state: CommandState,
  note: Notification,
): boolean {
  if (
    note.recipient.kind !== "needs_you" ||
    isTerminalNotification(note.status)
  )
    return false;
  const event = eventById(state.events, note.event_id);
  const ids = humanActionIds(event?.payload);
  return (
    ids.length > 0 &&
    ids.every((id) => {
      const action = state.human_actions.find((h) => h.id === id);
      return action !== undefined && action.status !== "open";
    })
  );
}
