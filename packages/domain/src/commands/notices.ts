import type { Actor, Event } from "../entities.js";
import type { CardId, DecisionId, EventId } from "../ids.js";
import { PM_MERGE_STALL_KIND } from "../pm-merge-stall-attention.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

/**
 * Needs You "知会" (§7.4): every delegated resolution (PM Ops on project
 * authorization, PM merge confirmation, timed auto-merge, PM returning or
 * rechecking a merge whose check failed) becomes a
 * non-blocking notice derived from its resolution event; a PM-held merge
 * confirmation left open too long (C-177) adds a system notice. Read state is an
 * append-only `notices_read` event, so no stored entity is needed.
 */
export interface Notice {
  readonly id: EventId;
  readonly kind: "merge" | "decision" | "external_message";
  readonly card_id: CardId | null;
  readonly decision_id: DecisionId | null;
  readonly question: string;
  readonly option: string;
  readonly resolved_by: string;
  readonly body: string;
  readonly proxy_authority: string | null;
  readonly at: string;
  readonly read: boolean;
}
const field = (e: Event, key: string) => {
  const value =
    typeof e.payload === "object" &&
    e.payload !== null &&
    !Array.isArray(e.payload)
      ? (e.payload as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" ? value : undefined;
};
function readIds(events: readonly Event[]) {
  const ids = new Set<string>();
  for (const e of events)
    if (
      e.type === "notices_read" &&
      typeof e.payload === "object" &&
      e.payload !== null &&
      "notice_ids" in e.payload &&
      Array.isArray(e.payload.notice_ids)
    )
      for (const id of e.payload.notice_ids)
        if (typeof id === "string") ids.add(id);
  return ids;
}
function noticeBody(e: Event) {
  const notice = field(e, "notice");
  if (notice) return notice;
  const option = field(e, "option_description") || field(e, "option") || "";
  const rationale = field(e, "rationale");
  return rationale ? `${option}。理由：${rationale}` : option;
}
/** Delegated events without a decision resolution, and the option they stand for. */
const noticeOnlyEvents = new Map([
  ["merge_changes_requested", "request_changes"],
  ["merge_check_requeued", "recheck"],
]);
/** C-177: system alerts shown as notices; they resolve nothing. */
const systemNoticeEvents = new Map([[PM_MERGE_STALL_KIND, "stalled"]]);
/** Newest first; one notice per delegated resolution, even for multi-card decisions. */
export function notices(state: CommandState): readonly Notice[] {
  const read = readIds(state.events);
  const seen = new Set<string>();
  const out: Notice[] = [];
  // seq is per card stream (§6.1); order across cards by time, then by the
  // time-ordered event id, so a newer notice is never pushed out by older ones.
  const candidates = state.events.filter(
    (e) =>
      e.type === "ext_message_failed" ||
      systemNoticeEvents.has(e.type) ||
      ((e.type === "decision_resolved" ||
        e.type === "decision_provisionally_resolved" ||
        noticeOnlyEvents.has(e.type)) &&
        (field(e, "via") === "delegated" ||
          (e.actor.kind === "system" &&
            e.type === "decision_resolved" &&
            field(e, "via") === "system_rule"))),
  );
  const chronological = candidates.sort(
    (a, b) =>
      Date.parse(a.created_at) - Date.parse(b.created_at) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const e of chronological) {
    if (
      e.type === "ext_message_failed" &&
      e.actor.kind === "system" &&
      e.payload &&
      typeof e.payload === "object" &&
      "final" in e.payload &&
      e.payload.final === true
    ) {
      out.push({
        id: e.id,
        kind: "external_message",
        card_id: e.card_id ?? null,
        decision_id: null,
        question: "外部提醒未能送达，请在工作台查看待办",
        option: "",
        resolved_by: "system",
        body: "外部提醒已停止重试。原事项仍可在工作台处理。",
        proxy_authority: null,
        at: e.created_at,
        read: read.has(e.id),
      });
      continue;
    }
    const systemNotice =
      systemNoticeEvents.has(e.type) && e.actor.kind === "system";
    if (
      !systemNotice &&
      (![
        "decision_resolved",
        "decision_provisionally_resolved",
        // P2a-1 §2.6: PM Ops returned or rechecked after a failed merge check.
        ...noticeOnlyEvents.keys(),
      ].includes(e.type) ||
        !(
          field(e, "via") === "delegated" ||
          (e.actor.kind === "system" &&
            e.type === "decision_resolved" &&
            field(e, "via") === "system_rule")
        ))
    )
      continue;
    const decision_id = field(e, "decision_id") as DecisionId | undefined;
    if (!decision_id) continue;
    const q = state.decisions.find((q) => q.id === decision_id);
    const key = `${decision_id}/${e.type}/${e.created_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: e.id,
      kind: q?.trigger === "merge_confirmation" ? "merge" : "decision",
      card_id: q?.card_id ?? e.card_id ?? null,
      decision_id,
      question: q?.question ?? "",
      option:
        systemNoticeEvents.get(e.type) ??
        noticeOnlyEvents.get(e.type) ??
        field(e, "option") ??
        "",
      resolved_by: e.actor.kind === "system" ? "system" : "pm",
      body: noticeBody(e),
      proxy_authority: field(e, "proxy_authority") ?? null,
      at: e.created_at,
      read: read.has(e.id),
    });
  }
  return out.reverse();
}
/** Human-only; marking is idempotent and never blocks or changes any decision. */
export function markNoticesRead(
  state: CommandState,
  actor: Actor,
  p: { readonly notice_ids: readonly string[] },
  ports: CommandPorts,
) {
  return command(state, actor, "mark_notices_read", ports, (d) => {
    ensure(
      actor.kind === "human",
      "unauthorized",
      "Only the human can mark notices as read",
    );
    ensure(
      Array.isArray(p.notice_ids) && p.notice_ids.length > 0,
      "validation_failed",
      "notice_ids is required",
    );
    const all = notices(state);
    const unread = p.notice_ids.filter((id) => {
      const notice = all.find((n) => n.id === id);
      ensure(notice, "not_found", `Notice ${id} was not found`);
      return !notice.read;
    });
    if (unread.length)
      d.emit("notices_read", undefined, { notice_ids: [...new Set(unread)] });
    return { notice_ids: unread };
  });
}
