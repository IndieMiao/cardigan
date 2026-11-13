import type { Actor, HumanAction } from "../entities.js";
import type { CommandPorts, CommandState } from "./core.js";
import { command, ensure } from "./core.js";

/** Host-supplied, already redacted deployment evidence; never an execution request. */
export interface DeploymentRecord {
  readonly attempt: string;
  readonly from: string;
  readonly to: string;
  readonly status: "started" | "deployed" | "failed" | "rolled_back";
  readonly build: "not_run" | "passed" | "failed";
  readonly ready: boolean;
  readonly downtime_ms: number;
  readonly summary: string;
  readonly log_tail?: string;
  readonly post_deploy_failed?: boolean;
}

export function recordDeployment(
  state: CommandState,
  actor: Actor,
  record: DeploymentRecord,
  ports: CommandPorts,
) {
  return command(state, actor, "record_deployment", ports, (d) => {
    ensure(
      /^[a-f0-9]{40}$/u.test(record.from) && /^[a-f0-9]{40}$/u.test(record.to),
      "validation_failed",
      "部署记录需要完整提交 SHA",
    );
    ensure(
      Number.isFinite(record.downtime_ms) && record.downtime_ms >= 0,
      "validation_failed",
      "停服时长无效",
    );
    d.emit("host_deployment_recorded", undefined, { ...record });
    return record;
  });
}

export function requestDeploymentAction(
  state: CommandState,
  actor: Actor,
  input: { readonly key: string; readonly instructions: string },
  ports: CommandPorts,
) {
  return command(state, actor, "record_deployment", ports, (d) => {
    const prior = state.events.find(
      (e) =>
        e.type === "host_deployment_action_requested" &&
        (e.payload as { key?: string }).key === input.key,
    );
    const existing =
      prior &&
      d
        .list("human_actions")
        .find(
          (h) =>
            h.id ===
            (prior.payload as { human_action_id?: string }).human_action_id,
        );
    if (existing) return existing;
    const id = d.ids.next(d.state.project_id, "human_action");
    const action: HumanAction = {
      id,
      key: id,
      requested_by: "system",
      status: "open",
      triage: "human",
      instructions: input.instructions,
      why_human: "部署或角色权限变更需要主机管理员处理，Agent 没有执行权限",
      expected_return: "记录核对及处理结果后标记完成",
      blocked_work_items: [],
    };
    d.put("human_actions", action);
    d.emit("host_deployment_action_requested", undefined, {
      key: input.key,
      human_action_id: id,
    });
    d.emit("human_action_requested", undefined, {
      human_action_id: id,
      blocked_work_items: [],
    });
    return action;
  });
}
