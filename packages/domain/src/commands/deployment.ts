import type { Actor, Event, HumanAction } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import type { AssignmentId, CardId, HumanActionId, RunId } from "../ids.js";
import type { CommandPorts, CommandState } from "./core.js";
import { command, ensure } from "./core.js";
import {
  completeActionDraft,
  humanOnlyAction,
} from "./human-action-completion.js";

export type DeploymentControl =
  | {
      readonly action: "adopt";
      readonly from: string;
      readonly to: string;
      readonly tree: string;
      readonly reason: string;
    }
  | {
      readonly action: "pin";
      readonly sha: string;
      readonly tree: string;
      readonly reason: string;
    }
  | { readonly action: "unpin"; readonly reason: string };

/** Host CLI verifies immutable Git objects before this human-only audit command. */
export function controlDeployment(
  state: CommandState,
  actor: Actor,
  input: DeploymentControl,
  ports: CommandPorts,
) {
  return command(state, actor, "control_deployment", ports, (d) => {
    ensure(
      ["adopt", "pin", "unpin"].includes(input.action),
      "validation_failed",
      "部署操作无效",
    );
    ensure(
      typeof input.reason === "string" &&
        input.reason.trim().length > 0 &&
        input.reason.length <= 1000,
      "validation_failed",
      "需要简短的人工核对说明",
    );
    const shas =
      input.action === "adopt"
        ? [input.from, input.to, input.tree]
        : input.action === "pin"
          ? [input.sha, input.tree]
          : [];
    ensure(
      shas.every(
        (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/u.test(sha),
      ),
      "validation_failed",
      "部署操作需要完整提交和树 SHA",
    );
    ensure(
      input.action !== "adopt" || input.from !== input.to,
      "validation_failed",
      "认领区间不能为空",
    );
    const previous = currentDeploymentPin(state.events);
    if (input.action === "unpin" && !previous) return null;
    d.emit("host_deployment_controlled", undefined, { ...input });
    return input;
  });
}

/** Only same-project human audit events supplied by the Store authorize a pin. */
export function currentDeploymentPin(events: readonly Event[]) {
  const event = events.findLast(
    (e) =>
      e.type === "host_deployment_controlled" &&
      e.actor.kind === "human" &&
      ["pin", "unpin"].includes((e.payload as DeploymentControl).action),
  );
  const input = event?.payload as DeploymentControl | undefined;
  return event && input?.action === "pin"
    ? { ...input, event_id: event.id }
    : undefined;
}

/** Host-supplied, already redacted deployment evidence; never an execution request. */
export interface DeploymentRecord {
  readonly control_event_id?: string;
  readonly attempt: string;
  readonly from: string;
  readonly to: string;
  readonly status:
    | "started"
    | "waiting_for_evidence"
    | "waiting_for_capacity"
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
  readonly backup_file?: string;
  readonly waiting_since?: string;
  readonly evidence_wait_exceeded?: boolean;
  readonly capacity_wait_exceeded?: boolean;
  readonly blocking_checks?: readonly { project: string; attempt: string }[];
  readonly failure_stage?: "build" | "start" | "ready" | "host";
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
    ensure(
      record.backup_file === undefined ||
        /^database-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.bak$/u.test(
          record.backup_file,
        ),
      "validation_failed",
      "部署备份标识必须是主机生成的文件名",
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
  input: {
    readonly key: string;
    readonly instructions: string;
    readonly reason?: "evidence_wait";
  },
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
      ...(input.reason === "evidence_wait"
        ? { category: "general" as const }
        : {}),
      triage: input.reason === "evidence_wait" ? "pm_ops" : "human",
      instructions: input.instructions,
      why_human:
        input.reason === "evidence_wait"
          ? "中心 main 持续缺少合并门禁证据，请后台分拣核对"
          : "部署或角色权限变更需要主机管理员处理，Agent 没有执行权限",
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

/** Old installations already recorded the role and action in a system request key. */
export function pendingRoleConflictActions(state: CommandState) {
  const open = new Map(
    state.human_actions
      .filter(
        (a) => a.status === "open" && !a.card_id && a.requested_by === "system",
      )
      .map((a) => [a.id, a]),
  );
  if (!open.size) return [];
  return eventsOfType(state.events, "host_deployment_action_requested").flatMap(
    (e) => {
      if (
        e.actor.kind !== "system" ||
        e.actor.project_id !== state.project_id ||
        e.card_id
      )
        return [];
      const p = e.payload as { key?: string; human_action_id?: HumanActionId };
      const role =
        /^deployment-role-manual:([^:]+):[1-9]\d*:[a-f0-9]{64}$/u.exec(
          p.key ?? "",
        )?.[1];
      const action = p.human_action_id && open.get(p.human_action_id);
      return role && action ? [{ role, action }] : [];
    },
  );
}

/** The host compares the installed role policies inside this same write transaction. */
export function resolveMatchedRoleActions(
  state: CommandState,
  actor: Actor,
  matched: ReadonlySet<string>,
  ports: CommandPorts,
) {
  return command(state, actor, "record_deployment", ports, (d) => {
    for (const { role, action } of pendingRoleConflictActions(state)) {
      if (matched.has(role) && !humanOnlyAction(d, action))
        completeActionDraft(d, {
          human_action_id: action.id,
          text: `角色 ${role} 当前规则已与默认包一致，升级冲突已解除。`,
        });
    }
  });
}
