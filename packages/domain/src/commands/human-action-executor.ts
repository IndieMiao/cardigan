import type { Actor, HumanAction, HumanActionExecutor } from "../entities.js";
import {
  HUMAN_ACTION_OPERATOR_NAME,
  humanActionExecutor,
} from "../human-action-executor.js";
import type { HumanActionId } from "../ids.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
} from "./core.js";

const EXECUTORS: readonly HumanActionExecutor[] = ["owner", "operator"];

export function validExecutor(value: unknown): value is HumanActionExecutor {
  return EXECUTORS.includes(value as HumanActionExecutor);
}

/**
 * C-742: the event the operator's listener reads from the events table. It is
 * written whenever an action becomes the operator's (request or reassign).
 */
export function emitOperatorActionRequested(
  d: CommandDraft,
  action: HumanAction,
  reason: "requested" | "reassigned",
) {
  d.emit("operator_action_requested", action.card_id, {
    human_action_id: action.id,
    executor: "operator",
    reason,
    title:
      action.handoff?.title ??
      action.instructions.split(/\r?\n/u)[0] ??
      action.instructions,
    instructions: action.handoff?.instructions ?? action.instructions,
    why_human: action.handoff?.why_human ?? action.why_human,
    expected_return: action.handoff?.expected_return ?? action.expected_return,
    ...(action.ready_when ? { ready_when: action.ready_when } : {}),
  });
}

/**
 * C-742: hand an open action to the owner or to the operator. The owner may
 * take back an operator action (they still cannot complete it as operator);
 * standing PM identities may route it either way.
 */
export function reassignHumanAction(
  state: CommandState,
  actor: Actor,
  p: {
    human_action_id: HumanActionId;
    executor: HumanActionExecutor;
    reason: string;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "request_human_action", ports, (d) => {
    ensure(
      actor.kind === "human" ||
        (d.assignment?.scope === "standing" && d.assignment.role_id === "pm"),
      "unauthorized",
      "只有人或常驻项目经理能改派待办执行人",
    );
    ensure(
      validExecutor(p.executor),
      "validation_failed",
      "executor 须为 owner 或 operator",
    );
    text(p.reason, "reason");
    const action = d.get("human_actions", p.human_action_id);
    ensure(action.status === "open", "illegal_transition", "只能改派未结待办");
    // System-raised actions carry their own completion checks and owners.
    ensure(
      action.requested_by !== "system",
      "illegal_transition",
      "系统发起的待办不能改派执行人",
    );
    if (action.card_id)
      ensure(
        d.card(action.card_id).status !== "cancelled",
        "illegal_transition",
        "已取消卡片的待办不能改派",
      );
    const previous = humanActionExecutor(action);
    if (previous === p.executor) return action;
    const { executor: _previous, ...rest } = action;
    const next: HumanAction =
      p.executor === "operator" ? { ...rest, executor: "operator" } : rest;
    d.put("human_actions", next);
    const who = (e: HumanActionExecutor) =>
      e === "operator" ? HUMAN_ACTION_OPERATOR_NAME : "所有者";
    d.emit(
      "human_action_reassigned",
      action.card_id,
      {
        human_action_id: action.id,
        previous_executor: previous,
        executor: p.executor,
        reason: p.reason.trim(),
      },
      {
        type: "human_action",
        human_action_id: action.id,
        body: `${action.id} 改由${who(p.executor)}执行（原为${who(previous)}）：${p.reason.trim()}`,
      },
    );
    if (p.executor === "operator")
      emitOperatorActionRequested(d, next, "reassigned");
    return next;
  });
}
