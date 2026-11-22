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
  readonly kind: "merge" | "decision" | "external_message" | "human_action";
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
const officeWaitKey = (e: Event) =>
  field(e, "wait_key") ?? field(e, "source_entry_id");
function noticeIndex(events: readonly Event[]) {
  const recovered = new Set<string | undefined>();
  const overdue = new Set<string | undefined>();
  const closed = new Set<string | undefined>();
  const ids = new Set<string>();
  for (const e of events) {
    if (e.actor.kind === "system") {
      if (e.type === "standing_pm_recovery_started")
        recovered.add(field(e, "source_recovery_event_id"));
      if (e.type === "office_wait_overdue") overdue.add(officeWaitKey(e));
      if (e.type === "office_wait_closed") closed.add(officeWaitKey(e));
    }
    if (
      e.type === "notices_read" &&
      typeof e.payload === "object" &&
      e.payload !== null &&
      "notice_ids" in e.payload &&
      Array.isArray(e.payload.notice_ids)
    )
      for (const id of e.payload.notice_ids)
        if (typeof id === "string") ids.add(id);
  }
  return { read: ids, recovered, overdue, closed };
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
  // C-591: PM held a system-held merge confirmation.
  ["merge_confirmation_snoozed", "hold"],
]);
/** C-177: system alerts shown as notices; they resolve nothing. */
const systemNoticeEvents = new Map([
  [PM_MERGE_STALL_KIND, "stalled"],
  ["launch_model_changed", "主机启动模型已更改"],
  ["host_disk_space_low", "主机磁盘可用空间不足"],
  ["launch_reload_failed", "主机启动配置重载失败"],
  ["host_role_upgraded", "默认角色已自动升级"],
  ["host_role_upgrade_deferred", "角色升级等待系统排查"],
  ["standing_role_rotated", "常驻会话已自动轮换"],
  ["standing_pm_rotated", "常驻 PM 已轮换"],
  ["standing_pm_recovered", "常驻 PM 已安排自动恢复"],
  ["standing_pm_recovery_started", "常驻 PM 已恢复执行"],
  ["standing_pm_stall_restarted", "常驻 PM 停滞，已自动重开会话"],
  ["standing_pm_stall_escalated", "常驻 PM 停滞已升级主机运维"],
  ["standing_pm_stall_handoff_delivered", "常驻 PM 停滞升级已转主机运维"],
  ["office_wait_started", "等待 PM Office"],
  ["office_wait_overdue", "PM Office 等待超时"],
]);
/** Newest first; one notice per delegated resolution, even for multi-card decisions. */
export function notices(state: CommandState): readonly Notice[] {
  const { read, recovered, overdue, closed } = noticeIndex(state.events);
  const decisions = new Map(state.decisions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const out: Notice[] = [];
  // seq is per card stream (§6.1); order across cards by time, then by the
  // time-ordered event id, so a newer notice is never pushed out by older ones.
  const candidates = state.events.filter(
    (e) =>
      ["card_hold_set", "card_hold_released"].includes(e.type) ||
      (e.type === "human_action_completed" &&
        e.actor.kind !== "human" &&
        !!field(e, "result")) ||
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
    if (e.type === "human_action_completed" && e.actor.kind !== "human") {
      out.push({
        id: e.id,
        kind: "human_action",
        card_id: e.card_id ?? null,
        decision_id: null,
        question: `${field(e, "human_action_id")} ${e.actor.kind === "system" ? "系统已核销" : "后台已完成"}`,
        option: "已完成",
        resolved_by:
          e.actor.kind === "assignment"
            ? `assignment:${e.actor.assignment_id}`
            : "system",
        body: field(e, "result") ?? "",
        proxy_authority: null,
        at: e.created_at,
        read: read.has(e.id),
      });
      continue;
    }
    if (
      ["card_hold_set", "card_hold_released"].includes(e.type) &&
      (e.actor.kind === "human" ||
        (e.actor.kind === "assignment" && e.actor.role_id === "pm"))
    ) {
      out.push({
        id: e.id,
        kind: "decision",
        card_id: e.card_id ?? null,
        decision_id: null,
        question: "卡片暂停",
        option: e.type === "card_hold_set" ? "已暂停" : "已解除暂停",
        resolved_by: e.actor.kind === "human" ? "human" : "pm",
        body: noticeBody(e),
        proxy_authority: null,
        at: e.created_at,
        read: read.has(e.id),
      });
      continue;
    }
    if (e.type === "standing_pm_recovered" && recovered.has(e.id)) continue;
    if (e.type === "office_wait_started" && overdue.has(officeWaitKey(e)))
      continue;
    if (
      ["office_wait_started", "office_wait_overdue"].includes(e.type) &&
      closed.has(officeWaitKey(e))
    )
      continue;
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
    if (!decision_id && !systemNotice) continue;
    const q = decision_id ? decisions.get(decision_id) : undefined;
    const key = `${decision_id ?? e.id}/${e.type}/${e.created_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: e.id,
      kind: q?.trigger === "merge_confirmation" ? "merge" : "decision",
      card_id: q?.card_id ?? e.card_id ?? null,
      decision_id: decision_id ?? null,
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
