import type { Actor, HumanAction } from "../entities.js";
import type { AssignmentId, CardId, RunId } from "../ids.js";
import type { CommandPorts, CommandState } from "./core.js";
import { command, ensure } from "./core.js";

/** Host-supplied, already redacted deployment evidence; never an execution request. */
export interface DeploymentRecord {
  readonly attempt: string;
  readonly from: string;
  readonly to: string;
  readonly status:
    | "started"
    | "waiting_for_evidence"
    | "stopping"
    | "deployed"
    | "failed"
    | "rolled_back";
  readonly build: "not_run" | "passed" | "failed";
  readonly ready: boolean;
  readonly downtime_ms: number;
  readonly summary: string;
  readonly log_tail?: string;
  readonly post_deploy_failed?: boolean;
  /** Same-project runs observed immediately before requesting server shutdown. */
  readonly stop_snapshot?: {
    readonly captured_at: string;
    readonly runs: readonly {
      readonly run_id: RunId;
      readonly assignment_id: AssignmentId;
      /** Standing/project-level Runs have no owning card. */
      readonly card_id: CardId | null;
    }[];
  };
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
    d.emit("host_deployment_recorded", undefined, {
      ...record,
      ...(record.stop_snapshot
        ? {
            stop_snapshot: {
              captured_at: record.stop_snapshot.captured_at,
              runs: record.stop_snapshot.runs.map((r) => ({ ...r })),
            },
          }
        : {}),
    });
    return record;
  });
}

/** Snapshot and audit in the host's write transaction, before any stop signal. */
export function recordDeploymentStop(
  state: CommandState,
  actor: Actor,
  record: DeploymentRecord,
  ports: CommandPorts,
) {
  const assignments = new Map(state.assignments.map((a) => [a.id, a]));
  const workItems = new Map(state.work_items.map((w) => [w.id, w]));
  return recordDeployment(
    state,
    actor,
    {
      ...record,
      status: "stopping",
      summary: "构建已完成，准备停止旧 server",
      stop_snapshot: {
        captured_at: ports.clock.now(),
        runs: state.runs
          .filter((r) => r.status === "running")
          .map((r) => {
            const a = assignments.get(r.assignment_id);
            return {
              run_id: r.id,
              assignment_id: r.assignment_id,
              card_id:
                a?.scope === "work_item"
                  ? (workItems.get(a.work_item_id)?.card_id ?? null)
                  : null,
            };
          }),
      },
    },
    ports,
  );
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
