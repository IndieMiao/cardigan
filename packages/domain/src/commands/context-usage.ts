import {
  type ContextLevel,
  type ContextObservation,
  contextNoticeRecorded,
  contextObservationCurrent,
  contextUsageFresh,
  contextUsageLevel,
} from "../context-usage.js";
import type { Actor } from "../entities.js";
import { type CommandPorts, type CommandState, command } from "./core.js";
import { projectPreferences } from "./preferences.js";

/** Host patrol records each threshold once and returns durable inbox work. */
export function recordContextUsageNotices(
  state: CommandState,
  actor: Actor,
  usage: ContextObservation,
  staleAfterMs: number,
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const a = d.get("assignments", usage.assignment_id);
    const ops = state.assignments.find(
      (item) =>
        item.scope === "standing" &&
        item.role_id === "host_ops" &&
        item.status === "active",
    );
    if (
      !ops ||
      !contextObservationCurrent(a, usage, state.events) ||
      !contextUsageFresh(usage, d.now, staleAfterMs)
    )
      return [];
    const level = contextUsageLevel(usage, projectPreferences(state));
    if (!level) return [];
    const employee = state.employees?.find((e) => e.id === a.employee_id);
    const card =
      a.scope === "work_item"
        ? d.get("work_items", a.work_item_id).card_id
        : undefined;
    if (card && ["done", "cancelled"].includes(d.card(card).status)) return [];
    // C-211: crossing both thresholds within one patrol interval still gives
    // the Agent one round to update its handoff before the restart notice.
    const levels: ContextLevel[] =
      level === "restart" &&
      contextNoticeRecorded(state.events, usage, "handoff")
        ? ["restart"]
        : ["handoff"];
    return levels.flatMap((threshold) => {
      if (contextNoticeRecorded(state.events, usage, threshold)) return [];
      const remaining = Math.round((100 - usage.used_percentage) * 10) / 10;
      const who = `${employee?.name ?? a.id}（${a.id}）`;
      const instruction =
        threshold === "handoff"
          ? "请先更新交接文档或卡片交接记录，记录当前进度、未提交改动和下一步。"
          : a.external
            ? "请人在该会话终端执行 /clear，然后让新会话读取交接文档；系统不会操作外接终端。"
            : "请主机运维核对交接记录后，用现有重启工具并携带 context_session_id 换会话，无需人确认。";
      const body = `主机运维上下文巡检：${who}，会话 ${usage.session_id}，已用 ${usage.used_percentage}%，剩余 ${remaining}%。${instruction}`;
      const event = d.emit(
        "context_usage_notice",
        card,
        {
          assignment_id: a.id,
          employee_id: a.employee_id ?? null,
          employee_name: employee?.name ?? null,
          session_id: usage.session_id,
          level: threshold,
          used_percentage: usage.used_percentage,
          remaining_percentage: remaining,
          context_tokens: usage.context_tokens,
          context_window_size: usage.context_window_size,
          source: usage.source,
          updated_at: usage.updated_at,
          host_ops_assignment_id: ops.id,
          action:
            threshold === "handoff"
              ? "update_handoff"
              : a.external
                ? "request_manual_clear"
                : "request_session_restart",
          result: "queued",
          body,
        },
        { type: "system", body },
      );
      if (threshold === "restart" && a.external) {
        const id = d.ids.next(state.project_id, "human_action");
        d.put("human_actions", {
          id,
          key: id,
          requested_by: "system",
          status: "open",
          triage: "human",
          blocked_work_items: [],
          instructions: body,
          why_human: "外接会话由人管理，只能由人在终端清空上下文。",
          expected_return: "执行 /clear 并读取交接文档后标记完成。",
        });
        d.emit(
          "human_action_requested",
          undefined,
          {
            human_action_id: id,
            assignment_id: a.id,
            context_session_id: usage.session_id,
            disposition: "human",
          },
          { type: "human_action", body, human_action_id: id },
        );
      }
      return [
        {
          event,
          recipient: threshold === "handoff" || a.external ? a.id : ops.id,
        },
      ];
    });
  });
}
