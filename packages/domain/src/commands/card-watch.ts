import {
  CARD_WATCH_END_LABELS,
  CARD_WATCH_ENDED,
  CARD_WATCH_NOTE_MAX_LENGTH,
  CARD_WATCH_OPEN_LIMIT,
  CARD_WATCH_REGISTERED,
  CARD_WATCH_TRIGGERED,
  CARD_WATCH_UNTIL,
  CARD_WATCH_UNTIL_LABELS,
  type CardWatch,
  type CardWatchRecipient,
  type CardWatchRegistered,
  type CardWatchUntil,
  cardWatches,
  cardWatchOutcome,
  sameCardWatchRecipient,
} from "../card-watch.js";
import type { Actor, Card } from "../entities.js";
import { type CardId, type EventId, parseId } from "../ids.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

export interface WatchCardInput {
  readonly card_id: string;
  readonly until: CardWatchUntil;
  /** Default `self`; the human may only register for PM Ops. */
  readonly notify?: "self" | "pm_ops" | undefined;
  /** Where the registrant waits; a work-item PM defaults to its own card. */
  readonly context_card_id?: string | undefined;
  readonly note?: string | undefined;
}

export interface WatchCardResult {
  readonly watch_id: EventId;
  /** False when the same open watch already existed. */
  readonly created: boolean;
  readonly target_card_id: CardId;
  readonly until: CardWatchUntil;
  readonly recipient: CardWatchRecipient;
  readonly posted_on: CardId;
}

const recipientLabel = (r: CardWatchRecipient) =>
  r.kind === "assignment" ? r.assignment_id : "PM Ops";
const closed = (card: Card) =>
  card.status === "done" || card.status === "cancelled";

function sameProjectCard(d: CommandDraft, raw: string, field: string): Card {
  const parsed = parseId("card", raw);
  ensure(parsed.ok, "validation_failed", `${field}无效`);
  const card = d.get("cards", parsed.value.id);
  ensure(
    card.project_id === d.state.project_id,
    "unauthorized",
    "只能登记本项目的卡片",
  );
  return card;
}

/**
 * C-763: PM registers "wake me when that card is done / merged / cancelled".
 * Only an audit event is written; no card, work item, Run or dependency
 * changes, so neither side is blocked or locked by the watch.
 */
export function watchCard(
  state: CommandState,
  actor: Actor,
  input: WatchCardInput,
  ports: CommandPorts,
) {
  return command(state, actor, "watch_card", ports, (d): WatchCardResult => {
    d.pm();
    ensure(
      (CARD_WATCH_UNTIL as readonly string[]).includes(input.until),
      "validation_failed",
      "until 只能是 done、merged 或 cancelled",
    );
    // Any same-project card, including for a work-item PM: reading a target's
    // status is not access to its contents.
    const target = sameProjectCard(d, input.card_id, "目标卡编号");
    ensure(
      !closed(target),
      "validation_failed",
      `${target.id} 已结束（${target.status}${target.resolution ? `/${target.resolution}` : ""}），无需登记`,
    );
    let context: Card | undefined;
    if (input.context_card_id !== undefined) {
      const parsed = parseId("card", input.context_card_id);
      ensure(parsed.ok, "validation_failed", "等待所在卡编号无效");
      context = d.card(parsed.value.id);
    } else if (d.assignment?.scope === "work_item")
      context = d.card(d.get("work_items", d.assignment.work_item_id).card_id);
    ensure(
      context?.id !== target.id,
      "validation_failed",
      "不能登记等待自己所在的卡",
    );
    const notify = input.notify ?? (actor.kind === "human" ? "pm_ops" : "self");
    ensure(
      notify === "self" || notify === "pm_ops",
      "validation_failed",
      "notify 只能是 self 或 pm_ops",
    );
    ensure(
      notify === "pm_ops" || d.assignment,
      "validation_failed",
      "人登记时只能通知 PM Ops",
    );
    const recipient: CardWatchRecipient =
      notify === "self" && d.assignment
        ? { kind: "assignment", assignment_id: d.assignment.id }
        : { kind: "pm_ops" };
    const note = input.note?.trim() || undefined;
    ensure(
      note === undefined ||
        ([...note].length <= CARD_WATCH_NOTE_MAX_LENGTH &&
          // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
          !/[\u0000-\u001f\u007f]/u.test(note)),
      "validation_failed",
      `备注最多 ${CARD_WATCH_NOTE_MAX_LENGTH} 字，不能含控制字符`,
    );
    const open = cardWatches(d.state.events, d.state.project_id).filter(
      (w) => !w.settled_by && sameCardWatchRecipient(w.recipient, recipient),
    );
    const posted_on = context?.id ?? target.id;
    const existing = open.find(
      (w) =>
        w.target_card_id === target.id &&
        w.until === input.until &&
        w.card_id === posted_on &&
        (w.context_card_id ?? undefined) === context?.id,
    );
    if (existing)
      return {
        watch_id: existing.id,
        created: false,
        target_card_id: target.id,
        until: existing.until,
        recipient,
        posted_on,
      };
    ensure(
      open.length < CARD_WATCH_OPEN_LIMIT,
      "validation_failed",
      `${recipientLabel(recipient)} 已有 ${open.length} 条未触发的观察，达到上限；需要真正的前置依赖请用 depends_on_cards`,
    );
    const payload: CardWatchRegistered = {
      target_card_id: target.id,
      until: input.until,
      recipient,
      ...(context ? { context_card_id: context.id } : {}),
      ...(note ? { note } : {}),
    };
    const body = `登记观察：${target.id} ${CARD_WATCH_UNTIL_LABELS[input.until]}时通知 ${recipientLabel(recipient)}${note ? `（${note}）` : ""}。`;
    const event = d.emit(
      CARD_WATCH_REGISTERED,
      posted_on,
      { ...payload },
      {
        type: "system",
        body,
        refs: [{ kind: "card", id: target.id }],
      },
    );
    return {
      watch_id: event.id,
      created: true,
      target_card_id: target.id,
      until: input.until,
      recipient,
      posted_on,
    };
  });
}

/** Watches whose target settled since the last pass; none settles twice. */
export function cardWatchesDue(state: CommandState) {
  const watches = cardWatches(state.events, state.project_id).filter(
    (w) => !w.settled_by,
  );
  if (!watches.length) return [];
  const cards = new Map(state.cards.map((c) => [c.id, c]));
  return watches.flatMap((watch) => {
    const target = cards.get(watch.target_card_id);
    const outcome =
      target && cardWatchOutcome(state.events, target, watch.until);
    return target && outcome ? [{ watch, target, outcome }] : [];
  });
}

const registrar = (w: CardWatch) =>
  w.registered_by.startsWith("assignment:")
    ? w.registered_by.slice("assignment:".length)
    : w.registered_by === "human"
      ? "人"
      : w.registered_by;

/**
 * C-763 system pass: one settlement event per watch, posted where the watch
 * was registered. The settlement itself is the durable ledger, so replaying
 * the pass (or routing the event again) never rings twice.
 */
export function settleCardWatches(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(state, actor, "settle_card_watches", ports, (d) => {
    const settled: EventId[] = [];
    for (const { watch, target, outcome } of cardWatchesDue(d.state)) {
      const wanted = CARD_WATCH_UNTIL_LABELS[watch.until];
      const since = `${registrar(watch)} 于 ${watch.registered_at} 登记${watch.note ? `：${watch.note}` : ""}`;
      const reached = outcome.kind === "reached";
      const notice = reached
        ? `${target.id} 已${wanted}，到达观察条件（${since}）。`
        : `${target.id} ${CARD_WATCH_END_LABELS[outcome.reason]}，不会再${wanted}，观察结束（${since}）。`;
      d.emit(
        reached ? CARD_WATCH_TRIGGERED : CARD_WATCH_ENDED,
        watch.card_id,
        {
          watch_id: watch.id,
          target_card_id: target.id,
          until: watch.until,
          recipient: watch.recipient,
          ...(watch.context_card_id
            ? { context_card_id: watch.context_card_id }
            : {}),
          registered_by: watch.registered_by,
          registered_at: watch.registered_at,
          target_status: target.status,
          ...(target.resolution
            ? { target_resolution: target.resolution }
            : {}),
          ...(target.superseded_by
            ? { superseded_by: target.superseded_by }
            : {}),
          ...(outcome.kind === "ended"
            ? { reason: outcome.reason }
            : outcome.evidence_event_id
              ? { evidence_event_id: outcome.evidence_event_id }
              : {}),
          notice,
        },
        {
          type: "system",
          author: "system",
          body: notice,
          refs: [
            { kind: "card", id: target.id },
            ...(target.superseded_by
              ? [{ kind: "card" as const, id: target.superseded_by }]
              : []),
          ],
        },
      );
      settled.push(watch.id);
    }
    return { settled };
  });
}

/** True when a pass would emit anything; keeps the tick free of empty commands. */
export const cardWatchesPending = (state: CommandState) =>
  cardWatchesDue(state).length > 0;
