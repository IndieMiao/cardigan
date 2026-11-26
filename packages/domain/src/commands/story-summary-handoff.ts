import type { Actor, Card, Event } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import type { CardId } from "../ids.js";
import { officeOnDuty } from "../office-changes.js";
import { storyProgress, storyTerminal } from "../story.js";
import { type CommandPorts, type CommandState, command } from "./core.js";

/**
 * C-762: an external PM Office has no system Run reading its inbox, so a
 * settled story would wait for its summary forever. The system tick surfaces
 * the wait in Needs You and, after this long, hands the draft to PM Ops.
 */
export const DEFAULT_STORY_SUMMARY_HANDOFF_MS = 24 * 60 * 60_000;
export const STORY_SUMMARY_ESCALATED = "story_summary_escalated";
export const STORY_SUMMARY_HANDED_OFF = "story_summary_handed_off";

const CONCLUSION_MAX = 120;

const field = (e: Event, key: string): unknown =>
  e.payload && typeof e.payload === "object" && !Array.isArray(e.payload)
    ? (e.payload as Record<string, unknown>)[key]
    : undefined;

const systemEvents = (events: readonly Event[], type: string) =>
  eventsOfType(events, type).filter((e) => e.actor.kind === "system");

/** The newest settlement of each story: a new child starts a new episode. */
function latestSettlements(events: readonly Event[]) {
  const latest = new Map<CardId, Event>();
  for (const e of systemEvents(events, "story_children_settled")) {
    if (!e.card_id) continue;
    const prior = latest.get(e.card_id);
    if (!prior || e.seq > prior.seq) latest.set(e.card_id, e);
  }
  return latest;
}

/** Open, schedulable story whose children all ended and has no summary yet. */
function awaitingSummary(cards: readonly Card[], card: Card | undefined) {
  if (
    !card?.story ||
    card.story.summary_entry_id ||
    storyTerminal(card) ||
    card.hold ||
    card.status === "backlog"
  )
    return false;
  const { finished, total } = storyProgress(cards, card);
  return total > 0 && finished === total;
}

/**
 * True once the system handed the current settlement of `card_id` to PM Ops.
 * Only then may PM Ops write the summary; confirming the story stays human.
 */
export function storySummaryHandedOff(
  events: readonly Event[],
  card_id: CardId,
): boolean {
  const settled = latestSettlements(events).get(card_id);
  return (
    !!settled &&
    systemEvents(events, STORY_SUMMARY_HANDED_OFF).some(
      (e) =>
        e.card_id === card_id && field(e, "settled_event_id") === settled.id,
    )
  );
}

/** Whether a Needs You notice for this escalation is still open. */
export function storySummaryEscalationOpen(
  state: Pick<CommandState, "cards" | "events">,
  e: Event,
): boolean {
  const card = state.cards.find((c) => c.id === e.card_id);
  return (
    !!e.card_id &&
    awaitingSummary(state.cards, card) &&
    latestSettlements(state.events).get(e.card_id)?.id ===
      field(e, "settled_event_id")
  );
}

function clip(value: string) {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length > CONCLUSION_MAX
    ? `${line.slice(0, CONCLUSION_MAX - 1)}…`
    : line;
}

const STATUS_LABEL = { done: "已完成", cancelled: "已取消" } as const;

/** Child list for PM Ops; a sensitive child shows only its id, title and status. */
function childConclusions(state: CommandState, story: Card) {
  return storyProgress(state.cards, story).children.map((child) => {
    const card = state.cards.find((c) => c.id === child.id);
    const items = new Set(
      state.work_items.filter((w) => w.card_id === child.id).map((w) => w.id),
    );
    const completion = card?.sensitive
      ? undefined
      : state.deliveries
          .filter(
            (v) =>
              v.kind === "card_completion" &&
              v.status !== "superseded" &&
              items.has(v.work_item_id),
          )
          .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
    const status =
      STATUS_LABEL[child.status as keyof typeof STATUS_LABEL] ?? child.status;
    const conclusion = completion
      ? clip(completion.plain_summary?.changed ?? completion.summary)
      : card?.resolution && card.resolution !== "done"
        ? `${status}（${card.resolution}）`
        : status;
    return {
      card_id: child.id,
      title: child.title,
      status: child.status,
      ...(card?.resolution ? { resolution: card.resolution } : {}),
      conclusion,
    };
  });
}

/**
 * C-762 system tick. For each settled story still waiting for its summary:
 * - the project's Office on duty is external and nothing was raised yet:
 *   raise one Needs You notice (`story_summary_escalated`);
 * - `handoffMs` or more after that notice: hand the draft to PM Ops once
 *   (`story_summary_handed_off`), with the children and their conclusions.
 * A non-external Office is left to read the settlement when it next runs.
 * Nothing here completes the story; only the human's existing entry does.
 */
export function maintainStorySummaries(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
  handoffMs = DEFAULT_STORY_SUMMARY_HANDOFF_MS,
) {
  return command(state, actor, "maintain_story_summaries", ports, (d) => {
    const settlements = latestSettlements(state.events);
    if (!settlements.size) return null;
    const escalations = new Map(
      systemEvents(state.events, STORY_SUMMARY_ESCALATED).map((e) => [
        field(e, "settled_event_id"),
        e,
      ]),
    );
    const handed = new Set(
      systemEvents(state.events, STORY_SUMMARY_HANDED_OFF).map((e) =>
        field(e, "settled_event_id"),
      ),
    );
    // Command state holds one project: another project's Office never counts.
    const office = officeOnDuty(state.assignments);
    const now = Date.parse(d.now);
    const hours = Math.round((handoffMs / 3_600_000) * 10) / 10;
    for (const [card_id, settled] of settlements) {
      const card = state.cards.find((c) => c.id === card_id);
      if (!card || !awaitingSummary(state.cards, card)) continue;
      const escalated = escalations.get(settled.id);
      if (!escalated) {
        if (office?.external !== true) continue;
        const notice = `需求卡 ${card.id}「${card.title}」子卡均已结束，等待外接 PM Office ${office.id} 提交对照总结；${hours} 小时内未提交将转交 PM Ops 代笔，完成仍由人确认。`;
        d.emit(
          STORY_SUMMARY_ESCALATED,
          card.id,
          {
            settled_event_id: settled.id,
            office_assignment_id: office.id,
            handoff_after_ms: handoffMs,
            notice,
          },
          { type: "system", body: notice },
        );
        continue;
      }
      if (
        handed.has(settled.id) ||
        !Number.isFinite(now) ||
        now - Date.parse(escalated.created_at) < handoffMs
      )
        continue;
      const children = childConclusions(state, card);
      const notice = [
        `需求卡 ${card.id}「${card.title}」的对照总结已等待外接 PM Office 超过 ${hours} 小时，转交 PM Ops 代笔：用 post_comment(story_summary=true) 在需求卡提交总结。代笔不会完成需求卡，仍由人确认或取消。`,
        "子卡：",
        ...children.map((c) => `- ${c.card_id}「${c.title}」：${c.conclusion}`),
      ].join("\n");
      d.emit(
        STORY_SUMMARY_HANDED_OFF,
        card.id,
        {
          settled_event_id: settled.id,
          escalated_event_id: escalated.id,
          handoff_after_ms: handoffMs,
          children,
          notice,
        },
        { type: "system", body: notice },
      );
    }
    return null;
  });
}
