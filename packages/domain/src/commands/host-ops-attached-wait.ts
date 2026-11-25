import type { Actor, Event } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import { type HostOpsExecution, pendingHostOpsActions } from "../host-ops.js";
import { type CommandPorts, type CommandState, command } from "./core.js";

/**
 * C-678: a host action that would end an Agent session waits while a human
 * holds the terminal through `cardigan assignment attach`. The protection
 * itself is unchanged; these facts only make the wait visible to the human
 * in the terminal, the requesting Agent, PM, and (after a while) Needs You.
 */
export const ATTACHED_HUMAN_WAIT_REASON = "waiting_for_attached_human";
/** Needs You notice, once per action, after the wait has lasted this long. */
export const ATTACHED_HUMAN_WAIT_OVERDUE = "host_ops_attached_wait_overdue";
export const DEFAULT_ATTACHED_HUMAN_NOTICE_MS = 10 * 60_000;
/** hc's detach key; the same text the attach command prints on entry. */
export const ATTACH_DETACH_KEY = "Ctrl+\\";

export interface AttachedHuman {
  readonly mode: "interactive" | "observe";
  readonly started_at: string;
}

interface WaitPayload {
  readonly action_id?: string;
  readonly reason?: string;
  readonly attached_since?: string;
  readonly attach_mode?: string;
}

const ROLE_LABELS: Record<string, string> = {
  host_ops: "主机运维",
  pm: "PM",
};
function requester(actor: Actor | undefined) {
  if (!actor || actor.kind === "system") return "系统";
  if (actor.kind === "assignment")
    return `${actor.assignment_id}（${ROLE_LABELS[actor.role_id] ?? actor.role_id}）`;
  return "人";
}
function operation(action: HostOpsExecution) {
  if (action.automatic_context_restart) return "上下文到档换会话";
  if (action.dispatch_stall_id) return "停滞恢复重启会话";
  if (action.tool === "host_ops_restart_standing_pm") return "重启常驻 PM 会话";
  if (action.tool === "host_ops_cancel_run") return "取消 Run 并结束会话";
  return "重启会话";
}
const minute = (at: string) => `${at.slice(0, 16).replace("T", " ")}Z`;

function isAttachedWait(e: Event, actionId: string) {
  const p = e.payload as WaitPayload;
  return p.action_id === actionId && p.reason === ATTACHED_HUMAN_WAIT_REASON;
}

/** Waits recorded for this action, oldest first. */
export function attachedHumanWaits(
  events: readonly Event[],
  actionId: string,
): readonly Event[] {
  return eventsOfType(events, "host_ops_action_deferred").filter((e) =>
    isAttachedWait(e, actionId),
  );
}

/**
 * The reason a pending action is waiting, for host operations diagnostics.
 * An attached-human wait followed by a claim is over: the lock was free again.
 */
export function hostOpsActionWaitStatus(
  events: readonly Event[],
  actionId: string,
): {
  readonly status_reason: string;
  readonly attached_since?: string;
  readonly attach_mode?: string;
  readonly waiting_since?: string;
} {
  let last: Event | undefined;
  let firstAttached: Event | undefined;
  for (const e of events) {
    const p = e.payload as WaitPayload;
    if (p.action_id !== actionId) continue;
    if (e.type === "host_ops_action_deferred") {
      last = e;
      if (p.reason === ATTACHED_HUMAN_WAIT_REASON) firstAttached ??= e;
    } else if (
      e.type === "host_ops_action_claimed" &&
      (last?.payload as WaitPayload | undefined)?.reason ===
        ATTACHED_HUMAN_WAIT_REASON
    ) {
      last = undefined;
      firstAttached = undefined;
    }
  }
  const p = last?.payload as WaitPayload | undefined;
  if (!p) return { status_reason: "pending" };
  if (p.reason !== ATTACHED_HUMAN_WAIT_REASON)
    return { status_reason: p.reason ?? "pending" };
  return {
    status_reason: ATTACHED_HUMAN_WAIT_REASON,
    ...(p.attached_since ? { attached_since: p.attached_since } : {}),
    ...(p.attach_mode ? { attach_mode: p.attach_mode } : {}),
    ...(firstAttached ? { waiting_since: firstAttached.created_at } : {}),
  };
}

/**
 * Record that a pending action cannot take the terminal because a human is
 * attached. One wait fact per attach session (its start time), and one Needs
 * You notice per action once the first wait is `notice_after_ms` old.
 */
export function recordAttachedHumanWait(
  state: CommandState,
  actor: Actor,
  input: {
    readonly action_id: HostOpsExecution["action_id"];
    readonly attached: AttachedHuman;
    readonly notice_after_ms?: number;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const action = pendingHostOpsActions(state.events).find(
      (a) => a.action_id === input.action_id,
    );
    if (!action) return { waiting: undefined, overdue: undefined };
    const request = state.events.find((e) => e.id === action.action_id);
    const ref = action.runtime_ref;
    const terminal = !ref
      ? "（未记录）"
      : ref.runtime_machine === "local" ||
          ref.terminal_ref.startsWith(`${ref.runtime_machine}/`)
        ? ref.terminal_ref
        : `${ref.runtime_machine}/${ref.terminal_ref}`;
    const who = requester(request?.actor);
    const op = operation(action);
    const mode = input.attached.mode === "interactive" ? "交互" : "只读观察";
    const facts = {
      action_id: action.action_id,
      assignment_id: action.assignment_id,
      tool: action.tool,
      terminal_ref: ref?.terminal_ref ?? null,
      requested_by: who,
      operation: op,
      attach_mode: input.attached.mode,
      attached_since: input.attached.started_at,
    };
    const waits = attachedHumanWaits(state.events, action.action_id);
    const waiting = waits.some(
      (e) =>
        (e.payload as WaitPayload).attached_since === input.attached.started_at,
    )
      ? undefined
      : d.emit("host_ops_action_deferred", undefined, {
          ...facts,
          reason: ATTACHED_HUMAN_WAIT_REASON,
          notice: `${who}要对 ${action.assignment_id}（终端 ${terminal}）${op}；有人自 ${minute(input.attached.started_at)} 起以${mode}方式连着该终端，动作暂不执行。连着的人按 ${ATTACH_DETACH_KEY} 断开后自动继续，无需重发。`,
        });
    const since = waits[0]?.created_at ?? d.now;
    const after = input.notice_after_ms ?? DEFAULT_ATTACHED_HUMAN_NOTICE_MS;
    const waited = Date.parse(d.now) - Date.parse(since);
    const overdue =
      waited >= after &&
      !eventsOfType(state.events, ATTACHED_HUMAN_WAIT_OVERDUE).some(
        (e) => (e.payload as WaitPayload).action_id === action.action_id,
      )
        ? d.emit(ATTACHED_HUMAN_WAIT_OVERDUE, undefined, {
            ...facts,
            waiting_since: since,
            waited_ms: waited,
            notice: `终端 ${terminal}（${action.assignment_id}）有人以${mode}方式连着，${who}的「${op}」已等待 ${Math.floor(waited / 60_000)} 分钟。请在该终端按 ${ATTACH_DETACH_KEY} 断开，动作会自动继续。`,
          })
        : undefined;
    return { waiting, overdue };
  });
}
