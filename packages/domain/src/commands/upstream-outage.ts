import { employeeDisplayName } from "../employee.js";
import type { Actor } from "../entities.js";
import type { AssignmentId, RunId } from "../ids.js";
import {
  openUpstreamOutage,
  type UpstreamOutageResumeResult,
  upstreamOutages,
} from "../upstream-outage.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const clock = (at: string) => `${at.slice(11, 16)}Z`;
const minutes = (from: string, to: string) =>
  Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));

function cardOf(d: CommandDraft, assignment: AssignmentId) {
  const a = d.get("assignments", assignment);
  return a.scope === "work_item"
    ? d.get("work_items", a.work_item_id).card_id
    : undefined;
}
function outage(state: CommandState, id: string) {
  const found = upstreamOutages(state).find((o) => o.id === id);
  ensure(found, "not_found", `Upstream outage ${id} not found`);
  return found;
}
function who(state: CommandState, id: AssignmentId) {
  const a = state.assignments.find((x) => x.id === id);
  const employee =
    a?.employee_id && state.employees?.find((e) => e.id === a.employee_id);
  return employee ? `${employeeDisplayName(employee.name)}（${id}）` : id;
}

/**
 * C-821: a quiet Run whose own terminal shows a model API outage error joins
 * its provider's open outage, or starts one. Recording is the whole effect:
 * no notification, no human action, no per-session alert.
 */
export function recordUpstreamOutageSession(
  state: CommandState,
  actor: Actor,
  p: {
    provider: string;
    assignment_id: AssignmentId;
    run_id: RunId;
    profile?: string | undefined;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    ensure(PROVIDER.test(p.provider), "validation_failed", "Invalid provider");
    const a = d.get("assignments", p.assignment_id);
    const run = d.get("runs", p.run_id);
    ensure(
      a.status === "active" &&
        !a.external &&
        run.assignment_id === a.id &&
        run.status === "running",
      "illegal_transition",
      "Only a running Run of an active Assignment can join an outage",
    );
    // A Run joins at most one outage: after its one resume the existing
    // inactivity flow applies, so a repeating error cannot loop resumes.
    const known = upstreamOutages(state).some((o) =>
      o.sessions.some((s) => s.run_id === run.id),
    );
    if (known) return { outage_id: undefined, started: false };
    const open = openUpstreamOutage(state, p.provider);
    const started = !open;
    const outage_id =
      open?.id ??
      d.emit("upstream_outage_started", undefined, {
        provider: p.provider,
        assignment_id: a.id,
        run_id: run.id,
        body: `模型服务 ${p.provider} 中断：${a.id} 的会话停在模型接口报错上。同一服务后续停住的会话并入这次中断，系统定时探测，恢复后自动发接续消息。`,
      }).id;
    const card = cardOf(d, a.id);
    const body = `${a.id} 的会话停在模型服务 ${p.provider} 的报错上，已并入上游中断；服务恢复后自动发接续消息。`;
    d.emit(
      "upstream_outage_session_added",
      card,
      {
        outage_id,
        provider: p.provider,
        assignment_id: a.id,
        run_id: run.id,
        ...(p.profile ? { profile: p.profile } : {}),
        body,
      },
      { type: "system", author: "system", body },
    );
    return { outage_id, started };
  });
}

/** C-821: the provider answered a model request; the outage is over. */
export function resolveUpstreamOutage(
  state: CommandState,
  actor: Actor,
  p: { outage_id: string; evidence: "model_probe" | "session_activity" },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const o = outage(state, p.outage_id);
    ensure(!o.resolved_at, "illegal_transition", "Outage already resolved");
    const body = `模型服务 ${o.provider} 已恢复（${p.evidence === "model_probe" ? "探测请求成功" : "同一服务的会话恢复了活动"}），${clock(o.started_at)} 到 ${clock(d.now)} 中断约 ${minutes(o.started_at, d.now)} 分钟；给停住的 ${o.sessions.length} 个会话发接续消息。`;
    d.emit("upstream_outage_resolved", undefined, {
      outage_id: o.id,
      provider: o.provider,
      evidence: p.evidence,
      body,
    });
    const action = o.human_action_id
      ? state.human_actions.find((h) => h.id === o.human_action_id)
      : undefined;
    if (action?.status === "open") {
      d.put("human_actions", { ...action, status: "cancelled" });
      d.emit("human_action_cancelled", undefined, {
        human_action_id: action.id,
        reason: "upstream_outage_resolved",
      });
    }
    return { outage_id: o.id };
  });
}

/** C-821: the one resume attempt of a stopped Run after its outage ended. */
export function recordUpstreamOutageResume(
  state: CommandState,
  actor: Actor,
  p: {
    outage_id: string;
    run_id: RunId;
    result: UpstreamOutageResumeResult;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const o = outage(state, p.outage_id);
    const session = o.sessions.find((s) => s.run_id === p.run_id);
    ensure(session, "not_found", `Run ${p.run_id} is not in this outage`);
    ensure(
      o.resolved_at,
      "illegal_transition",
      "Resume only after the outage resolved",
    );
    ensure(
      p.result === "unconfirmed"
        ? session.resume?.result === "sent"
        : !session.resume,
      "illegal_transition",
      "This Run already has a resume attempt",
    );
    const body =
      p.result === "sent"
        ? `已给 ${session.assignment_id} 发接续消息：模型服务 ${o.provider} ${clock(o.started_at)} 到 ${clock(o.resolved_at)} 中断，现已恢复，请从中断处继续。`
        : p.result === "skipped"
          ? `${session.assignment_id} 的会话已不停在模型报错上，未发接续消息。`
          : `给 ${session.assignment_id} 的接续消息未确认送达；之后按会话失活流程处理。`;
    d.emit(
      "upstream_outage_resume",
      cardOf(d, session.assignment_id),
      {
        outage_id: o.id,
        provider: o.provider,
        assignment_id: session.assignment_id,
        run_id: session.run_id,
        result: p.result,
        body,
      },
      { type: "system", author: "system", body },
    );
    return { result: p.result };
  });
}

/**
 * C-821: the single Needs You reminder of an outage that outlasted the
 * reminder period. It names the affected employees and the launch profiles
 * that use another provider; it is cancelled when the outage resolves.
 */
export function remindUpstreamOutage(
  state: CommandState,
  actor: Actor,
  p: { outage_id: string; alternatives: readonly string[] },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const o = outage(state, p.outage_id);
    ensure(
      !o.resolved_at && !o.reminded_at,
      "illegal_transition",
      "Outage already resolved or reminded",
    );
    const affected = [...new Set(o.sessions.map((s) => s.assignment_id))];
    const people = affected.map((id) => who(state, id));
    const alternatives = [...new Set(p.alternatives)].slice(0, 20);
    const body = `模型服务 ${o.provider} 自 ${clock(o.started_at)} 中断，已超过 ${minutes(o.started_at, d.now)} 分钟仍未恢复。受影响员工：${people.join("、") || "无"}。可临时切换的启动配置：${alternatives.join("、") || "无"}。系统继续探测，恢复后自动给停住的会话发接续消息，并撤销这条提醒。`;
    const id = d.ids.next(state.project_id, "human_action");
    d.put("human_actions", {
      id,
      key: id,
      requested_by: "system",
      status: "open",
      triage: "human",
      blocked_work_items: [],
      instructions: body,
      why_human: "模型服务长时间未恢复，是否临时给员工换启动配置需要人决定。",
      expected_return:
        "换好启动配置或决定继续等待后标记完成；服务恢复时自动撤销。",
    });
    d.emit(
      "human_action_requested",
      undefined,
      { human_action_id: id, upstream_outage_id: o.id, disposition: "human" },
      { type: "human_action", body, human_action_id: id },
    );
    d.emit("upstream_outage_reminded", undefined, {
      outage_id: o.id,
      provider: o.provider,
      human_action_id: id,
      assignment_ids: affected,
      profiles: alternatives,
      body,
    });
    return { human_action_id: id };
  });
}
