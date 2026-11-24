import type { Actor, Decision, Event, TimelineEntry } from "../entities.js";
import {
  eventById,
  eventsAtSeq,
  eventsOfType,
  eventsOfTypes,
} from "../event-index.js";
import type { DecisionId } from "../ids.js";
import { requesterNotificationRecipient } from "../notification.js";
import { pauseLabel, pendingPause } from "../review-pause.js";
import { type CommandPorts, type CommandState, command } from "./core.js";
import { pauseNotice } from "./review-pause.js";
import {
  suggestionProgressEvents,
  suggestionReminderDue,
} from "./suggestion-progress.js";

const field = (e: Event, key: string) =>
  typeof e.payload === "object" && e.payload !== null && key in e.payload
    ? (e.payload as Record<string, unknown>)[key]
    : undefined;
const PROGRESS_TYPES = [
  "card_updated",
  "card_superseded",
  "card_marked_done",
  "card_merged",
  "work_item_created",
  "work_item_updated",
  "work_item_assigned",
  "instruction_issued",
  "delivery_submitted",
  "review_submitted",
  "human_action_completed",
];
/** A resolution becomes due for a follow-up reminder this long after it. */
export const DECISION_FOLLOWUP_DELAY_MS = 30 * 60_000;

interface FollowupEventIndex {
  /** `decision_id\0resolved_at` of every decision_followup_due event. */
  readonly reminded: ReadonlySet<string>;
  /** decision_resolved events per payload decision_id, in event order. */
  readonly resolutions: ReadonlyMap<unknown, readonly Event[]>;
  /** Progress events per (truthy) card id, in event order. */
  readonly progress: ReadonlyMap<string, readonly Event[]>;
}

const remindedKey = (decision: unknown, at: unknown) =>
  JSON.stringify([decision, at]);

/**
 * C-244: per-snapshot indexes. Event and timeline collections are immutable
 * snapshots (C-221 §6.3: every append yields a new array), so an index keyed by
 * the array's identity cannot go stale; weak keys free unused snapshots.
 * C-649: built from the type index (only the relevant events), and events at
 * a (card, seq) are looked up per comment instead of indexing every event.
 */
const eventIndexes = new WeakMap<readonly Event[], FollowupEventIndex>();
const commentIndexes = new WeakMap<
  readonly TimelineEntry[],
  ReadonlyMap<string, readonly TimelineEntry[]>
>();

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

function followupEventIndex(events: readonly Event[]): FollowupEventIndex {
  const cached = eventIndexes.get(events);
  if (cached) return cached;
  const reminded = new Set<string>();
  const resolutions = new Map<unknown, Event[]>();
  const progress = new Map<string, Event[]>();
  for (const e of eventsOfType(events, "decision_followup_due"))
    reminded.add(remindedKey(field(e, "decision_id"), field(e, "resolved_at")));
  for (const e of eventsOfType(events, "decision_resolved"))
    push(resolutions, field(e, "decision_id"), e);
  for (const e of eventsOfTypes(events, PROGRESS_TYPES))
    if (e.card_id) push(progress, e.card_id, e);
  const index = { reminded, resolutions, progress };
  eventIndexes.set(events, index);
  return index;
}

/** Comment entries per referenced decision id, in timeline order. */
function commentIndex(timeline: readonly TimelineEntry[]) {
  const cached = commentIndexes.get(timeline);
  if (cached) return cached;
  const index = new Map<string, TimelineEntry[]>();
  for (const entry of timeline) {
    if (entry.type !== "comment") continue;
    const ids = new Set<string>();
    for (const ref of entry.refs) if (ref.kind === "decision") ids.add(ref.id);
    for (const id of ids) push(index, id, entry);
  }
  commentIndexes.set(timeline, index);
  return index;
}

/** Whether a decision_followup_due event exists for this resolution. */
function followupReminded(state: CommandState, q: Decision) {
  return followupEventIndex(state.events).reminded.has(
    remindedKey(q.id, q.resolution?.at),
  );
}

/**
 * How the implementation of a resolution was recorded, if at all. `durable`
 * evidence only depends on append-only events and timeline entries plus the
 * decision itself; `ops` evidence also depends on a comment author still being
 * the active-or-not standing PM Ops Assignment, which can change.
 */
function decisionImplementationEvidence(
  state: CommandState,
  q: Decision,
): "durable" | "ops" | undefined {
  const index = followupEventIndex(state.events);
  const resolutions = index.resolutions.get(q.id) ?? [];
  const at = q.resolution?.at ?? "";
  const after = (e: Event) =>
    e.created_at > at ||
    (e.created_at === at &&
      resolutions.some((r) => r.card_id === e.card_id && e.seq > r.seq));
  const cards = new Set([
    ...q.affected_cards,
    ...(q.card_id ? [q.card_id] : []),
  ]);
  for (const card of cards)
    for (const e of index.progress.get(card) ?? [])
      if (
        after(e) &&
        (!q.affected_work_items.length ||
          !field(e, "work_item_id") ||
          q.affected_work_items.some((id) => id === field(e, "work_item_id")))
      )
        return "durable";
  let ops = false;
  for (const entry of commentIndex(state.timeline).get(q.id) ?? []) {
    if (entry.created_at < at) continue;
    const durable = entry.author === q.raised_by || entry.author === "human";
    if (
      !durable &&
      (ops ||
        !state.assignments.some(
          (a) =>
            `assignment:${a.id}` === entry.author &&
            a.scope === "standing" &&
            a.role_id === "pm" &&
            a.standing_mode === "ops",
        ))
    )
      continue;
    if (!eventsAtSeq(state.events, entry.card_id, entry.event_seq).some(after))
      continue;
    if (durable) return "durable";
    ops = true;
  }
  return ops ? "ops" : undefined;
}

export function decisionImplementationRecorded(
  state: CommandState,
  q: Decision,
) {
  return decisionImplementationEvidence(state, q) !== undefined;
}

/**
 * C-244: where one decision stands in the follow-up reminder, as of `now`.
 * `remindDecisionFollowups` emits exactly for `due`. A caller may skip a
 * decision object while its answer cannot change: `ineligible` and `reminded`
 * depend only on the decision and append-only events, `recorded` with
 * `durable` likewise; `waiting` holds until `due_at`. `recorded` without
 * `durable` must be re-checked, because PM Ops evidence follows Assignments.
 */
export type DecisionFollowupStatus =
  | { readonly kind: "ineligible" }
  | { readonly kind: "waiting"; readonly due_at: number }
  | { readonly kind: "reminded" }
  | { readonly kind: "recorded"; readonly durable: boolean }
  | { readonly kind: "due" };

export function decisionFollowupStatus(
  state: CommandState,
  q: Decision,
  now: string,
): DecisionFollowupStatus {
  const pause = pendingPause(q);
  if (pause) {
    if (
      pause.office_reminded_at ||
      state.cards.some(
        (c) => c.id === q.card_id && ["done", "cancelled"].includes(c.status),
      )
    )
      return { kind: "ineligible" };
    const due_at = pause.ops_reminded_at
      ? Date.parse(pause.ops_reminded_at) + pause.period_ms
      : Date.parse(pause.review_at);
    return Date.parse(now) >= due_at
      ? { kind: "due" }
      : { kind: "waiting", due_at };
  }
  if (
    q.status !== "resolved" ||
    !q.resolution ||
    !q.raised_by.startsWith("assignment:")
  )
    return { kind: "ineligible" };
  const resolved = Date.parse(q.resolution.at);
  if (Date.parse(now) - resolved < DECISION_FOLLOWUP_DELAY_MS)
    return { kind: "waiting", due_at: resolved + DECISION_FOLLOWUP_DELAY_MS };
  if (followupReminded(state, q)) return { kind: "reminded" };
  const evidence = decisionImplementationEvidence(state, q);
  if (evidence) return { kind: "recorded", durable: evidence === "durable" };
  return { kind: "due" };
}

/** Read-only attention: completed decisions must not disappear when nobody can receive a bell. */
export function decisionFollowupNeedsHuman(
  state: CommandState,
  q: Decision,
): boolean {
  if (
    q.status !== "resolved" ||
    !q.resolution ||
    !q.raised_by.startsWith("assignment:")
  )
    return false;
  if (
    q.card_id &&
    state.cards.some(
      (c) => c.id === q.card_id && ["done", "cancelled"].includes(c.status),
    )
  )
    return false;
  const recipient = requesterNotificationRecipient(
    q.raised_by,
    state.assignments,
  );
  const overdue = followupReminded(state, q);
  const fallback = requesterNotificationRecipient(
    q.raised_by,
    state.assignments,
    { skip_requester: true },
  );
  return (
    (recipient?.kind === "needs_you" ||
      (overdue && fallback?.kind === "needs_you")) &&
    !decisionImplementationRecorded(state, q)
  );
}

/**
 * Host tick: one persistent reminder per resolution, independent of bells and
 * ACKs. C-244: `decision_ids` limits the pass to those decisions (the host
 * skips decisions whose status cannot have changed); omitted means all.
 */
export function remindDecisionFollowups(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
  options: { readonly decision_ids?: ReadonlySet<DecisionId> } = {},
) {
  return command(state, actor, "remind_decision_followups", ports, (d) => {
    const reminded: string[] = [];
    for (const q of d.list("decisions")) {
      if (options.decision_ids && !options.decision_ids.has(q.id)) continue;
      if (
        decisionFollowupStatus(state, q, d.now).kind !== "due" ||
        !q.resolution
      )
        continue;
      const pause = pendingPause(q);
      if (pause) {
        const office = !!pause.ops_reminded_at;
        d.put("decisions", {
          ...q,
          review_pause: {
            ...pause,
            ...(office
              ? { office_reminded_at: d.now }
              : { ops_reminded_at: d.now }),
          },
        });
        pauseNotice(
          d,
          q,
          office ? "pm_office" : "pm_ops",
          `${q.id} 暂停复查逾期，${pauseLabel(pause, q.decider)}，请 ${office ? "PM Office" : "PM Ops"} 跟进。`,
        );
        reminded.push(q.id);
        continue;
      }
      d.emit(
        "decision_followup_due",
        q.card_id,
        {
          decision_id: q.id,
          resolved_at: q.resolution.at,
          raised_by: q.raised_by,
          option: q.resolution.option,
          question: q.question,
          impact:
            q.options.find((o) => o.key === q.resolution?.option)?.impact ?? "",
          rationale: q.resolution.rationale,
        },
        {
          type: "system",
          decision_id: q.id,
          body: `${q.id} 已拍板超过 30 分钟，尚未观察到落实结果，请 PM Ops 跟进发起人执行所选方案。`,
        },
      );
      reminded.push(q.id);
    }
    return reminded;
  });
}
export interface DecisionHistoryFilters {
  decider?: "human" | "pm" | "system";
  category?: string;
  card_id?: string;
  from?: string;
  to?: string;
}
export function decisionHistory(
  state: CommandState,
  filters: DecisionHistoryFilters = {},
) {
  return state.decisions
    .filter(
      (
        q,
      ): q is Decision & { resolution: NonNullable<Decision["resolution"]> } =>
        !!q.resolution &&
        (q.status === "resolved" ||
          (["superseded", "revoked"].includes(q.status) &&
            state.events.some(
              (e) =>
                e.type === "decision_resolved" &&
                field(e, "decision_id") === q.id &&
                e.created_at === q.resolution?.at,
            ))),
    )
    .map((q) => ({
      ...q,
      category: q.category ?? "general",
      decision_maker:
        q.resolution.resolved_by === "system"
          ? "system"
          : q.resolution.via === "delegated"
            ? "pm"
            : "human",
    }))
    .filter(
      (q) =>
        (!filters.decider || q.decision_maker === filters.decider) &&
        (!filters.category || q.category === filters.category) &&
        (!filters.card_id ||
          q.card_id === filters.card_id ||
          q.affected_cards.some((id) => id === filters.card_id)) &&
        (!filters.from || q.resolution.at >= filters.from) &&
        (!filters.to || q.resolution.at <= filters.to),
    )
    .sort(
      (a, b) =>
        b.resolution.at.localeCompare(a.resolution.at) ||
        b.id.localeCompare(a.id),
    );
}

/** Details are appended to the host prompt, not encoded into the ID-only bell. */
export function decisionFollowupPrompt(
  state: CommandState,
  eventIds: readonly string[],
  assignmentId: string,
) {
  return state.events
    .filter((e) => eventIds.includes(e.id) && e.type === "decision_resolved")
    .flatMap((e) => {
      const q = state.decisions.find((q) => q.id === field(e, "decision_id"));
      if (!q?.resolution || q.raised_by !== `assignment:${assignmentId}`)
        return [];
      const option = q.options.find((o) => o.key === q.resolution?.option);
      return [
        `拍板落实：${q.id} 已选择 ${q.resolution.option}（${option?.description ?? ""}）。影响：${option?.impact ?? ""}。请执行所选方案，并在卡片时间线引用 ${q.id} 写一句执行结果。`,
      ];
    })
    .join("\n");
}

/** A result notification must not start work while a different blocker remains. */
export function decisionFollowupBlocked(
  state: CommandState,
  eventId: string,
  assignmentId: string,
): boolean {
  // C-244: keyed lookup, same first match as events.find (C-221 eventById).
  const event = eventById(state.events, eventId);
  if (event?.type !== "decision_resolved") return false;
  const q = state.decisions.find((q) => q.id === field(event, "decision_id"));
  if (q?.raised_by !== `assignment:${assignmentId}`) return false;
  const a = state.assignments.find((a) => a.id === assignmentId);
  const item =
    a?.scope === "work_item"
      ? state.work_items.find((w) => w.id === a.work_item_id)
      : undefined;
  return !!item && ["blocked", "waiting_decision"].includes(item.status);
}

/** C-303: host-only, transactional reminders. The budget lives with the suggestion. */
export function remindSuggestionProgress(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(state, actor, "remind_decision_followups", ports, (d) => {
    const reminded: string[] = [];
    for (const q of d.list("decisions")) {
      if (!q.suggestion || !suggestionReminderDue(state, q, d.now)) continue;
      if (
        !state.assignments.some(
          (a) =>
            a.status === "active" &&
            a.scope === "standing" &&
            a.role_id === "pm" &&
            a.standing_mode === "ops",
        )
      )
        continue;
      const events = suggestionProgressEvents(state, q);
      d.put("decisions", {
        ...q,
        suggestion: {
          ...q.suggestion,
          progress_notice: { at: d.now, event_ids: events.map((e) => e.id) },
        },
      });
      d.emit(
        "decision_suggestion_progress",
        q.card_id,
        { decision_id: q.id, count: events.length },
        {
          type: "system",
          decision_id: q.id,
          body: `${q.id} 的建议生成后有 ${events.length} 条新进展，请 PM Ops 复核同一拍板的建议。`,
        },
      );
      reminded.push(q.id);
    }
    return reminded;
  });
}
