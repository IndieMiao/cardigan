import type { CommandState } from "./commands/core.js";
import { notices } from "./commands/notices.js";
import { listNeedsYou } from "./commands/queries.js";
import type { CardId, EventId, ProjectId } from "./ids.js";
import { needsYouItemReady } from "./readiness.js";

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

/** Replayable projection of canonical Needs You facts, including handled items for skip auditing. */
export function extMessageItems(
  state: CommandState,
  project: ProjectId,
): ExtMessageItem[] {
  const result = listNeedsYou(state, { kind: "human", project_id: project });
  if (!result.ok) return [];
  const view = result.value.data;
  const sensitive = (ids: readonly CardId[]) =>
    ids.some((id) => {
      const card = state.cards.find((c) => c.id === id);
      return !card || card.sensitive === true;
    });
  const source = (field: string, id: string) =>
    state.events.find(
      (e) =>
        e.payload &&
        typeof e.payload === "object" &&
        field in e.payload &&
        (e.payload as Record<string, unknown>)[field] === id,
    );
  const out: ExtMessageItem[] = [];
  for (const q of state.decisions) {
    if (q.decider !== "human") continue;
    const event = source("decision_id", q.id);
    if (!event) continue;
    const cards = [
      ...q.affected_cards,
      ...(q.card_id ? [q.card_id] : []),
      ...state.work_items
        .filter((w) => q.affected_work_items.includes(w.id))
        .map((w) => w.card_id),
    ];
    out.push({
      project_id: project,
      ...(q.card_id ? { card_id: q.card_id } : {}),
      event_id: event.id,
      created_at: event.created_at,
      item_id: q.id,
      kind:
        q.trigger === "merge_confirmation" ? "merge_confirmation" : "decision",
      title: q.question,
      sensitive: sensitive(cards),
      ready: needsYouItemReady(state, q),
      handled:
        !view.decisions.some((v) => v.id === q.id) &&
        !view.later.some((v) => v.kind === "decision" && v.id === q.id),
    });
  }
  for (const h of state.human_actions) {
    if (h.triage === "pm_ops") continue;
    const event = source("human_action_id", h.id);
    if (!event) continue;
    out.push({
      project_id: project,
      ...(h.card_id ? { card_id: h.card_id } : {}),
      event_id: event.id,
      created_at: event.created_at,
      item_id: h.id,
      kind: "human_action",
      ...(h.handoff?.title ? { title: h.handoff.title } : {}),
      sensitive: sensitive([
        ...(h.card_id ? [h.card_id] : []),
        ...state.work_items
          .filter((w) => h.blocked_work_items.includes(w.id))
          .map((w) => w.card_id),
      ]),
      ready: needsYouItemReady(state, h),
      handled:
        h.status !== "open" ||
        (!view.human_actions.some((v) => v.id === h.id) &&
          !view.later.some((v) => v.kind === "human_action" && v.id === h.id)),
    });
  }
  for (const n of notices(state)) {
    // A failed external delivery is a Workbench-only notice. Never recurse.
    if (n.kind === "external_message") continue;
    const decision = state.decisions.find((q) => q.id === n.decision_id);
    const createdAt = state.events.find((e) => e.id === n.id)?.created_at;
    out.push({
      project_id: project,
      ...(n.card_id ? { card_id: n.card_id } : {}),
      event_id: n.id,
      ...(createdAt ? { created_at: createdAt } : {}),
      item_id: n.id,
      kind: "notice",
      title: n.question,
      ...(n.decision_id ? { anchor: `decision-${n.decision_id}` } : {}),
      sensitive: sensitive([
        ...(n.card_id ? [n.card_id] : []),
        ...(decision?.affected_cards ?? []),
        ...state.work_items
          .filter((w) => decision?.affected_work_items.includes(w.id))
          .map((w) => w.card_id),
      ]),
      ready: true,
      handled: n.read,
    });
  }
  return out;
}
