import { type CommandState, command } from "./commands/core.js";
import { notices } from "./commands/notices.js";
import { selectNeedsYouDecisions } from "./commands/queries.js";
import type { Event, ReadyCondition } from "./entities.js";
import {
  eventById,
  eventsForDecision,
  eventsForHumanAction,
} from "./event-index.js";
import type { CardId, EventId, ProjectId } from "./ids.js";
import { qualifyId, qualifyText } from "./project-code.js";
import { NEEDS_YOU_ITEM_READY, needsYouItemReady } from "./readiness.js";

export const EXT_MESSAGE_DEFAULTS = {
  timeout_ms: 10_000,
  max_attempts: 3,
  retry_delays_ms: [30_000, 60_000] as readonly number[],
  title_limit: 120,
  digest_limit: 20,
};
export type ExtMessagePolicy = typeof EXT_MESSAGE_DEFAULTS;
export type ExtMessageKind =
  | "decision"
  | "merge_confirmation"
  | "human_action"
  | "notice";
export const EXT_MESSAGE_KINDS: readonly ExtMessageKind[] = [
  "decision",
  "human_action",
  "merge_confirmation",
  "notice",
];
/**
 * C-580: which Needs You items are pushed at all. An item that fails the
 * filter is never queued, retried or reported as undelivered. The sensitive
 * rule (generic text and link only) applies unchanged to items that pass.
 */
export interface ExtMessageFilter {
  /**
   * `merge_confirmation` covers only confirmations whose decider is the
   * human: system and PM-held confirmations are never items to begin with.
   */
  readonly kinds: Readonly<Record<ExtMessageKind, boolean>>;
  /** Projects never pushed; projects created later are pushed by default. */
  readonly excluded_projects: readonly ProjectId[];
}
export const EXT_MESSAGE_FILTER_DEFAULTS: ExtMessageFilter = {
  kinds: {
    decision: true,
    human_action: true,
    merge_confirmation: true,
    notice: false,
  },
  excluded_projects: [],
};
export function extMessageAllowed(
  filter: ExtMessageFilter,
  item: Pick<ExtMessageItem, "kind" | "project_id">,
): boolean {
  return (
    filter.kinds[item.kind] === true &&
    !filter.excluded_projects.includes(item.project_id)
  );
}
export interface ExtMessageItem {
  readonly project_id: ProjectId;
  readonly card_id?: CardId;
  readonly event_id: EventId;
  readonly created_at?: string;
  /** Server-recorded creation, readiness and routing times; never adapter input. */
  readonly activity_at?: readonly string[];
  /** Legacy gated state with no recorded release/trigger time. */
  readonly undated_ready?: true;
  readonly item_id: string;
  readonly kind: ExtMessageKind;
  readonly title?: string;
  readonly anchor?: string;
  readonly sensitive: boolean;
  readonly handled: boolean;
  readonly ready: boolean;
}
export type ExtMessageEntry =
  | { readonly title: string; readonly url: string; readonly project?: string }
  | {
      readonly title: string;
      readonly url: string;
      readonly project: string;
      readonly card: string | null;
      readonly item: string;
      readonly kind: ExtMessageKind;
      /** C-674: full number of the card (or project-level item), e.g. `SEN-C-34`. */
      readonly ref?: string;
    };
export type ExtMessage = ExtMessageEntry;

/** The adapter receives only the approved projection, never domain objects or credentials. */
export interface ExtMessageSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
export interface ExtMessagePort {
  send(
    message: ExtMessage,
    signal: ExtMessageSignal,
  ): Promise<"sent" | "retryable" | "permanent">;
}

export function extMessageUrl(
  base: string,
  project: string,
  card?: string,
  anchor?: string,
): string {
  const root = `${base.replace(/\/+$/u, "")}/#/p/${encodeURIComponent(project)}`;
  return card
    ? `${root}/cards/${encodeURIComponent(card)}${anchor ? `?at=${encodeURIComponent(anchor)}` : ""}`
    : `${root}/needs-you`;
}

/** Pure allowlist: missing titles get a fixed label, never a body/context fallback. */
export function buildExtMessage(
  item: ExtMessageItem,
  base: string,
  titleLimit = EXT_MESSAGE_DEFAULTS.title_limit,
  /** C-674: the project's code; numbers in the message get it as prefix. */
  code?: string,
): ExtMessageEntry {
  if (!Number.isSafeInteger(titleLimit) || titleLimit < 1)
    throw new Error("Invalid title limit");
  const anchor =
    item.anchor ??
    (item.kind === "human_action"
      ? `human-action-${item.item_id}`
      : item.kind === "notice"
        ? item.item_id
        : `decision-${item.item_id}`);
  const url = extMessageUrl(base, item.project_id, item.card_id, anchor);
  if (item.sensitive)
    return { project: item.project_id, title: "有 1 条敏感事项待处理", url };
  const labels: Record<ExtMessageKind, string> = {
    decision: "有新的拍板事项",
    merge_confirmation: "请确认合并",
    human_action: "有新的待你执行事项",
    notice: "有新的知会",
  };
  // C-676: short numbers in the title read as this project's full numbers.
  const title = qualifyText(
    code,
    (item.title?.trim() || labels[item.kind]).replace(/[\p{Cc}\p{Cf}]/gu, " "),
  );
  const local = item.card_id ?? item.item_id;
  const ref = qualifyId(code, local);
  return {
    project: item.project_id,
    card: item.card_id ?? null,
    item: item.item_id,
    kind: item.kind,
    title: Array.from(title).slice(0, titleLimit).join(""),
    url,
    ...(ref === local ? {} : { ref }),
  };
}

/** Intentionally cannot accept titles, item URLs, or actions. */
export function buildExtMessageDigest(
  count: number,
  workbench: string,
): ExtMessageEntry {
  return { title: `${count} 条待处理`, url: workbench };
}

function sameGate(gate: ReadyCondition | undefined, recorded: unknown) {
  if (
    !gate ||
    !recorded ||
    typeof recorded !== "object" ||
    !("kind" in recorded) ||
    recorded.kind !== gate.kind
  )
    return false;
  if (gate.kind === "manual") return true;
  return (
    "card_id" in recorded &&
    recorded.card_id === gate.card_id &&
    (gate.kind !== "card_delivery" ||
      ("after" in recorded ? recorded.after : undefined) === gate.after)
  );
}

/**
 * Facts of one Needs You item from the events naming it, in history order:
 * the first is the source, including legacy events with both references.
 * C-653: keyed lookups (decision and human action ids never share a prefix),
 * never a scan of the whole history.
 */
function itemHistory(
  history: readonly Event[],
  events: readonly Event[],
  gate: ReadyCondition | undefined,
) {
  const [source] = events;
  if (!source) return undefined;
  const times = new Set<string>();
  let datedRelease = false;
  // A handoff or reissue never erases an earlier quiet touch. The readiness
  // notification and the source change it references can straddle quiet hours.
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    times.add(e.created_at);
    const trigger =
      typeof p.source_event_id === "string"
        ? eventById(history, p.source_event_id)?.created_at
        : undefined;
    if (!trigger) continue;
    times.add(trigger);
    if (
      e.type === NEEDS_YOU_ITEM_READY &&
      "condition" in p &&
      sameGate(gate, p.condition)
    )
      datedRelease = true;
  }
  return { source, times, datedRelease };
}

/** Replayable projection of canonical Needs You facts, including handled items for skip auditing. */
export function extMessageItems(
  state: CommandState,
  project: ProjectId,
): ExtMessageItem[] {
  const result = command(
    state,
    { kind: "human", project_id: project },
    "list_needs_you",
    undefined,
    (d) => {
      d.pm();
      d.projectAccess();
      return new Set(selectNeedsYouDecisions(d).map((q) => q.id));
    },
  );
  if (!result.ok) return [];
  const visible = result.value.data;
  const cards = new Map(state.cards.map((c) => [c.id, c]));
  const work = new Map(state.work_items.map((w) => [w.id, w.card_id]));
  const decisions = new Map(state.decisions.map((q) => [q.id, q]));
  const sensitive = (ids: readonly (CardId | undefined)[]) =>
    ids.some(
      (id) => !id || !cards.has(id) || cards.get(id)?.sensitive === true,
    );
  const out: ExtMessageItem[] = [];
  for (const q of state.decisions) {
    if (q.decider !== "human") continue;
    const facts = itemHistory(
      state.events,
      eventsForDecision(state.events, q.id),
      q.ready_when,
    );
    if (!facts) continue;
    const { source: event, times, datedRelease } = facts;
    const ready = needsYouItemReady(state, q);
    const related = [
      ...q.affected_cards,
      ...(q.card_id ? [q.card_id] : []),
      ...q.affected_work_items.map((id) => work.get(id)),
    ];
    out.push({
      project_id: project,
      ...(q.card_id ? { card_id: q.card_id } : {}),
      event_id: event.id,
      created_at: event.created_at,
      activity_at: [...times],
      ...(ready && q.ready_when && !datedRelease
        ? { undated_ready: true as const }
        : {}),
      item_id: q.id,
      kind:
        q.trigger === "merge_confirmation" ? "merge_confirmation" : "decision",
      title: q.question,
      sensitive: sensitive(related),
      ready,
      handled:
        !visible.has(q.id) &&
        (ready || !["open", "provisional", "snoozed"].includes(q.status)),
    });
  }
  for (const h of state.human_actions) {
    if (h.triage === "pm_ops") continue;
    const facts = itemHistory(
      state.events,
      eventsForHumanAction(state.events, h.id),
      h.ready_when,
    );
    if (!facts) continue;
    const { source: event, times, datedRelease } = facts;
    if (h.ready_released) times.add(h.ready_released.at);
    if (h.handoff) times.add(h.handoff.rewritten_at);
    const ready = needsYouItemReady(state, h);
    out.push({
      project_id: project,
      ...(h.card_id ? { card_id: h.card_id } : {}),
      event_id: event.id,
      created_at: event.created_at,
      activity_at: [...times],
      ...(ready && h.ready_when && !h.ready_released && !datedRelease
        ? { undated_ready: true as const }
        : {}),
      item_id: h.id,
      kind: "human_action",
      ...(h.handoff?.title ? { title: h.handoff.title } : {}),
      sensitive: sensitive([
        ...(h.card_id ? [h.card_id] : []),
        ...h.blocked_work_items.map((id) => work.get(id)),
      ]),
      ready,
      handled: h.status !== "open",
    });
  }
  for (const n of notices(state)) {
    // A failed external delivery is a Workbench-only notice. Never recurse.
    if (n.kind === "external_message") continue;
    const decision = n.decision_id ? decisions.get(n.decision_id) : undefined;
    out.push({
      project_id: project,
      ...(n.card_id ? { card_id: n.card_id } : {}),
      event_id: n.id,
      created_at: n.at,
      item_id: n.id,
      kind: "notice",
      title: n.question,
      ...(n.decision_id ? { anchor: `decision-${n.decision_id}` } : {}),
      sensitive: sensitive([
        ...(n.card_id ? [n.card_id] : []),
        ...(decision?.affected_cards ?? []),
        ...(decision?.affected_work_items.map((id) => work.get(id)) ?? []),
      ]),
      ready: true,
      handled: n.read,
    });
  }
  return out;
}
