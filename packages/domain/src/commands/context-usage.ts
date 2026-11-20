import {
  type ContextLevel,
  type ContextObservation,
  contextNoticeRecorded,
  contextObservationCurrent,
  contextUsageFresh,
  contextUsageLevel,
} from "../context-usage.js";
import type { Actor } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
} from "./core.js";
import {
  completeActionDraft,
  humanOnlyAction,
} from "./human-action-completion.js";
import { projectPreferences } from "./preferences.js";

/** Each clear request is an alarm episode. A fresh recovery rearms it even if
 * a human already completed it; this does not reset the session's notice history. */
function reconcileClearEpisodes(
  d: CommandDraft,
  usage: ContextObservation,
  level: ContextLevel | undefined,
) {
  const requests = new Map<string, { id: string; at: string }>();
  for (const e of eventsOfType(d.state.events, "human_action_requested")) {
    if (
      e.actor.kind !== "system" ||
      e.actor.project_id !== d.state.project_id ||
      e.card_id
    )
      continue;
    const p = e.payload as {
      assignment_id?: string;
      context_session_id?: string;
      human_action_id?: string;
      updated_at?: string;
    };
    if (
      p.assignment_id === usage.assignment_id &&
      p.context_session_id &&
      p.human_action_id
    )
      requests.set(p.context_session_id, {
        id: p.human_action_id,
        at: p.updated_at ?? e.created_at,
      });
  }
  const recoveries = new Map<string, string>();
  for (const e of eventsOfType(d.state.events, "context_clear_recovered")) {
    if (
      e.actor.kind !== "system" ||
      e.actor.project_id !== d.state.project_id ||
      e.card_id
    )
      continue;
    const p = e.payload as { human_action_id: string; updated_at: string };
    recoveries.set(p.human_action_id, p.updated_at);
  }
  const sample = Date.parse(usage.updated_at);
  let needsAction = !requests.has(usage.session_id);
  for (const [session, request] of requests) {
    const recovery = recoveries.get(request.id);
    if (recovery) {
      if (session === usage.session_id)
        needsAction = sample > Date.parse(recovery);
      continue;
    }
    if (
      sample <= Date.parse(request.at) ||
      (session === usage.session_id && level === "restart")
    )
      continue;
    const action = d.get("human_actions", request.id);
    if (
      action.card_id ||
      action.requested_by !== "system" ||
      humanOnlyAction(d, action)
    )
      continue;
    if (action.status === "open")
      completeActionDraft(d, {
        human_action_id: action.id,
        text:
          session !== usage.session_id
            ? `${usage.assignment_id} 的外接会话已由 ${session} 更换为 ${usage.session_id}，原巡检待办已解除。`
            : `${usage.assignment_id} 的外接会话 ${session} 已用 ${usage.used_percentage}%，已低于清理阈值。`,
      });
    d.emit("context_clear_recovered", undefined, {
      human_action_id: action.id,
      updated_at: usage.updated_at,
    });
  }
  return needsAction;
}

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
      !contextObservationCurrent(a, usage, state.events) ||
      !contextUsageFresh(usage, d.now, staleAfterMs)
    )
      return [];
    if (a.external) {
      const cursor = a.context_patrol_cursor;
      const sampleTime = Date.parse(usage.updated_at);
      const previousTime = cursor ? Date.parse(cursor.updated_at) : -Infinity;
      // A repeated identical sample may deliver the second C-211 notice. An
      // older or contradictory sample must never start or settle an episode.
      if (
        sampleTime < previousTime ||
        (sampleTime === previousTime &&
          (cursor?.session_id !== usage.session_id ||
            cursor.used_percentage !== usage.used_percentage))
      )
        return [];
      if (sampleTime > previousTime)
        d.put("assignments", {
          ...a,
          context_patrol_cursor: {
            session_id: usage.session_id,
            updated_at: usage.updated_at,
            used_percentage: usage.used_percentage,
          },
        });
    }
    const level = contextUsageLevel(usage, projectPreferences(state));
    const needsClearAction =
      a.external && reconcileClearEpisodes(d, usage, level);
    if (!ops || !level) return [];
    const employee = state.employees?.find((e) => e.id === a.employee_id);
    const card =
      a.scope === "work_item"
        ? d.get("work_items", a.work_item_id).card_id
        : undefined;
    if (card && ["done", "cancelled"].includes(d.card(card).status)) return [];
    // C-211: crossing both thresholds within one patrol interval still gives
    // the Agent one round to update its handoff before the restart notice.
    const threshold =
      level === "restart" &&
      contextNoticeRecorded(state.events, usage, "handoff")
        ? "restart"
        : "handoff";
    const notified = contextNoticeRecorded(state.events, usage, threshold);
    const createAction = threshold === "restart" && needsClearAction;
    if (notified && !createAction) return [];
    const remaining = Math.round((100 - usage.used_percentage) * 10) / 10;
    const who = `${employee?.name ?? a.id}（${a.id}）`;
    const instruction =
      threshold === "handoff"
        ? "请先更新交接文档或卡片交接记录，记录当前进度、未提交改动和下一步。"
        : a.external
          ? "请人在该会话终端执行 /clear，然后让新会话读取交接文档；系统不会操作外接终端。"
          : a.id === ops.id
            ? "系统会在本会话空闲且没有处理中的运维动作时自动换会话；结果通知 PM Ops，失败交人。"
            : "请主机运维核对交接记录后，用现有重启工具并携带 context_session_id 换会话，无需人确认。";
    const body = `主机运维上下文巡检：${who}，会话 ${usage.session_id}，已用 ${usage.used_percentage}%，剩余 ${remaining}%。${instruction}`;
    if (createAction) {
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
          updated_at: usage.updated_at,
          disposition: "human",
        },
        { type: "human_action", body, human_action_id: id },
      );
    }
    if (notified) return [];
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
    return [
      {
        event,
        notify_pm_ops: a.id === ops.id,
        recipient: threshold === "handoff" || a.external ? a.id : ops.id,
      },
    ];
  });
}
