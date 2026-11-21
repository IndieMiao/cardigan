import { type CommandState, command } from "./commands/core.js";
import { notices } from "./commands/notices.js";
import { selectNeedsYouDecisions } from "./commands/queries.js";
import type { Event, ReadyCondition } from "./entities.js";
import type { CardId, EventId, ProjectId } from "./ids.js";
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
export interface ExtMessageItem {
  readonly project_id: ProjectId;
  readonly card_id?: CardId;
  readonly event_id: EventId;
  readonly created_at?: string;
  /** Replay evidence, not dispatch authorization. No date is inferred for an unmet gate. */
  readonly ready_evidence?: {
    readonly basis: "source" | "release";
    readonly at: string;
  };
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
    };
export type ExtMessage =
  | ExtMessageEntry
  | {
      readonly title: string;
      readonly url: string;
      readonly project: string;
      readonly total: number;
      readonly items: readonly ExtMessageEntry[];
    };

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
  const title = (item.title?.trim() || labels[item.kind]).replace(
    /[\p{Cc}\p{Cf}]/gu,
    " ",
  );
  return {
    project: item.project_id,
    card: item.card_id ?? null,
    item: item.item_id,
    kind: item.kind,
    title: Array.from(title).slice(0, titleLimit).join(""),
    url,
  };
}

/** Digest membership is projected afresh; the outbox never stores message text. */
export function buildExtMessageDigest(
  project: ProjectId,
  items: readonly ExtMessageItem[],
  base: string,
  policy: ExtMessagePolicy = EXT_MESSAGE_DEFAULTS,
): ExtMessage {
  if (!Number.isSafeInteger(policy.digest_limit) || policy.digest_limit < 1)
    throw new Error("Invalid digest limit");
  const pending = items.filter(
    (i) => i.project_id === project && !i.handled && i.ready,
  );
  return {
    project,
    title: `免打扰期间 ${pending.length} 条待处理`,
    total: pending.length,
    items: pending
      .slice(0, policy.digest_limit)
      .map((i) => buildExtMessage(i, base, policy.title_limit)),
    url: extMessageUrl(base, project),
  };
}

// Compare condition facts by their fields, not JSON property insertion order.
function releaseKey(
  id: string,
  condition: Event["payload"],
): string | undefined {
  if (!condition || typeof condition !== "object" || !("kind" in condition))
    return;
  const { kind } = condition;
  if (kind === "manual") return JSON.stringify([id, kind]);
  if (
    (kind !== "card_delivery" && kind !== "card_merged") ||
    !("card_id" in condition)
  )
    return;
  return JSON.stringify([
    id,
    kind,
    condition.card_id,
    kind === "card_delivery" && "after" in condition ? condition.after : null,
  ]);
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
  // Preserve first-match stream order, including legacy events with both references.
  const decisionSources = new Map<string, Event>();
  const actionSources = new Map<string, Event>();
  const released = new Map<string, string>();
  const reissued = new Set<string>();
  for (const e of state.events) {
    const p = e.payload;
    if (!p || typeof p !== "object") continue;
    if (e.type === NEEDS_YOU_ITEM_READY && "condition" in p) {
      const id =
        "human_action_id" in p
          ? p.human_action_id
          : "decision_id" in p
            ? p.decision_id
            : undefined;
      const key = typeof id === "string" && releaseKey(id, p.condition);
      if (key && !released.has(key)) released.set(key, e.created_at);
    }
    // A decision may fan out to several cards in the creation transaction;
    // those are not reissues. A later request or an explicit handoff may
    // change visibility, so its first request no longer proves readiness.
    if ("decision_id" in p && typeof p.decision_id === "string") {
      const first = decisionSources.get(p.decision_id);
      if (!first) decisionSources.set(p.decision_id, e);
      else if (
        e.type === "decision_requested" &&
        (first.created_at !== e.created_at || "previous_decider" in p)
      )
        reissued.add(p.decision_id);
    }
    if ("human_action_id" in p && typeof p.human_action_id === "string") {
      if (!actionSources.has(p.human_action_id))
        actionSources.set(p.human_action_id, e);
      else if (e.type === "human_action_requested")
        reissued.add(p.human_action_id);
    }
  }
  // For gated items the original request is not evidence of readiness. If a
  // matching release fact is unavailable, leave dating to the checked scan.
  function evidence(
    id: string,
    source: Event,
    gate?: ReadyCondition,
    manual?: string,
  ): Pick<ExtMessageItem, "ready_evidence"> {
    const key = gate && releaseKey(id, gate);
    const at = manual ?? (key ? released.get(key) : undefined);
    if (at) return { ready_evidence: { basis: "release", at } };
    return gate ||
      reissued.has(id) ||
      (source.type !== "decision_requested" &&
        source.type !== "human_action_requested")
      ? {}
      : { ready_evidence: { basis: "source", at: source.created_at } };
  }
  const out: ExtMessageItem[] = [];
  for (const q of state.decisions) {
    if (q.decider !== "human") continue;
    const event = decisionSources.get(q.id);
    if (!event) continue;
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
      ...evidence(q.id, event, q.ready_when),
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
    const event = actionSources.get(h.id);
    if (!event) continue;
    out.push({
      project_id: project,
      ...(h.card_id ? { card_id: h.card_id } : {}),
      event_id: event.id,
      created_at: event.created_at,
      ...evidence(h.id, event, h.ready_when, h.ready_released?.at),
      item_id: h.id,
      kind: "human_action",
      ...(h.handoff?.title ? { title: h.handoff.title } : {}),
      sensitive: sensitive([
        ...(h.card_id ? [h.card_id] : []),
        ...h.blocked_work_items.map((id) => work.get(id)),
      ]),
      ready: needsYouItemReady(state, h),
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
      ready_evidence: { basis: "source", at: n.at },
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
