import type { Actor, Event, HumanAction } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import type { AssignmentId, CardId, HumanActionId, RunId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  matchesOpenHelperAction,
  workerHelperAction,
} from "../worker-helper-action.js";
import type { CommandDraft, CommandPorts, CommandState } from "./core.js";
import { command, ensure, unwrap } from "./core.js";
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

/**
 * C-609: a host-registered managed long operation. Host-internal only: it
 * names another project's card, so it never enters the deployment project's
 * record; the record carries `DeploymentOperationCount` instead and the
 * detail goes to the source card's own timeline.
 */
export type DeploymentOperation = {
  readonly id: string;
  readonly kind: string;
  readonly project_id: string;
  readonly card_id: string | null;
  readonly label: string;
  readonly started_at: string;
};

/** C-609: how many operations of one kind; carries no project or card. */
export type DeploymentOperationCount = {
  readonly kind: string;
  readonly count: number;
};

/** Distinct kinds per record; the host registers a handful of fixed kinds. */
export const MAX_DEPLOYMENT_OPERATION_KINDS = 20;

/** Group by kind; counts are exact, never truncated. */
export function countDeploymentOperations(
  ops: readonly Pick<DeploymentOperation, "kind">[],
): DeploymentOperationCount[] {
  const counts = new Map<string, number>();
  for (const op of ops) counts.set(op.kind, (counts.get(op.kind) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, count]) => ({ kind, count }));
}

function validOperationCounts(list: unknown): boolean {
  return (
    Array.isArray(list) &&
    list.length <= MAX_DEPLOYMENT_OPERATION_KINDS &&
    new Set(list.map((c) => c?.kind)).size === list.length &&
    list.every(
      (c) =>
        !!c &&
        typeof c === "object" &&
        Object.keys(c).length === 2 &&
        typeof c.kind === "string" &&
        /^[a-z][a-z0-9_]{0,63}$/u.test(c.kind) &&
        Number.isSafeInteger(c.count) &&
        c.count > 0,
    )
  );
}

const copyCounts = (list: readonly DeploymentOperationCount[]) =>
  list.map(({ kind, count }) => ({ kind, count }));

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
    /** C-609: main moved again soon after a deployment; only the latest is deployed. */
    | "waiting_for_batch"
    /** C-609: managed long operations are still running; bounded wait. */
    | "waiting_for_operations"
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
  /** C-609: operations this deployment waited for (bounded), by kind. */
  readonly deferred_operations?: readonly DeploymentOperationCount[];
  readonly operations_wait_exceeded?: boolean;
  /** C-609: operations still running when the server was stopped anyway, by kind. */
  readonly interrupted_operations?: readonly DeploymentOperationCount[];
  /** C-609: deployments are at least this far apart; later merges are batched. */
  readonly batch_window_ms?: number;
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
    ensure(
      [record.deferred_operations, record.interrupted_operations].every(
        (list) => list === undefined || validOperationCounts(list),
      ) &&
        (record.batch_window_ms === undefined ||
          (Number.isSafeInteger(record.batch_window_ms) &&
            record.batch_window_ms > 0)),
      "validation_failed",
      "部署等待记录无效",
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
      ...(record.deferred_operations
        ? { deferred_operations: copyCounts(record.deferred_operations) }
        : {}),
      ...(record.interrupted_operations
        ? {
            interrupted_operations: copyCounts(record.interrupted_operations),
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

export function recordHelperUpgradeChecks(
  state: CommandState,
  actor: Actor,
  p: {
    human_action_id: HumanActionId;
    text: string;
    attachments?: readonly string[];
    machine_id: string | null;
    binding: string | null;
    checks: Omit<NonNullable<HumanAction["helper_checks"]>, "at">;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "request_human_action", ports, (d) => {
    const action = d.get("human_actions", p.human_action_id);
    const upgrade = workerHelperAction(state, action);
    ensure(
      actor.kind === "human" &&
        action.requested_by === "system" &&
        !!upgrade &&
        upgrade.machine_id === p.machine_id &&
        (!action.helper_upgrade ||
          action.helper_upgrade.binding === p.binding) &&
        action.status === "open",
      "illegal_transition",
      "待办或检查目标已变化",
    );
    ensure(
      (!!p.binding &&
        !!p.machine_id &&
        d
          .list("machines")
          .some((m) => m.id === p.machine_id && m.herdr_machine === m.id)) ||
        (p.checks.worker.status === "failed" &&
          p.checks.machine.status === "failed"),
      "validation_failed",
      "机器未绑定，不能记录核验通过",
    );
    const helper_checks = { ...p.checks, at: d.now };
    const updated = { ...action, helper_checks };
    d.put("human_actions", updated);
    d.emit("worker_helper_upgrade_checked", undefined, {
      human_action_id: action.id,
      worker: helper_checks.worker.status,
      machine: helper_checks.machine.status,
    });
    return [p.checks.worker, p.checks.machine].every(
      (r) => r.status === "passed" && !r.failed_steps.length,
    )
      ? completeActionDraft(d, p, true)
      : updated;
  });
}

/** Internal patrol only: the host owns both fresh, binding-scoped checks. */
export function completeVerifiedHelperAction(
  state: CommandState,
  actor: Actor,
  target: {
    human_action_id: HumanActionId;
    machine_id: string;
    binding: string;
    key: string;
    checks: Omit<NonNullable<HumanAction["helper_checks"]>, "at">;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "record_deployment", ports, (d) => {
    const action = d.get("human_actions", target.human_action_id);
    if (
      ![target.checks.worker, target.checks.machine].every(
        (r) => r.status === "passed" && !r.failed_steps.length,
      ) ||
      !matchesOpenHelperAction(state, action, target) ||
      !d
        .list("machines")
        .some((m) => m.id === target.machine_id && m.herdr_machine === m.id)
    )
      return;
    d.put("human_actions", {
      ...action,
      helper_checks: { at: d.now, ...target.checks },
    });
    d.emit("worker_helper_upgrade_checked", undefined, {
      human_action_id: action.id,
      machine_id: target.machine_id,
      release_key: target.key,
      sha256_match: true,
      worker: target.checks.worker.status,
      machine: target.checks.machine.status,
    });
    completeActionDraft(
      d,
      {
        human_action_id: action.id,
        text: `${d.now} 系统核验机器 ${target.machine_id}：三个 helper 文件的 SHA-256 均与当前部署一致；worker check 和 machine check 均通过。`,
      },
      true,
    );
  });
}
interface DeploymentActionInput {
  readonly terminal?: HumanAction["terminal"];
  readonly helper_upgrade?: HumanAction["helper_upgrade"];
  readonly key: string;
  readonly instructions: string;
  readonly reason?: "evidence_wait" | "worker_maintenance";
}

function supersedeHelperAction(
  d: CommandDraft,
  action: HumanAction,
  reason: string,
) {
  const source = "worker_helper_superseded";
  d.put("human_actions", {
    ...action,
    status: unwrap(transition("human_action", action.status, "cancel")),
    cancellation: { reason, by: d.author, at: d.now, source },
  });
  d.emit("human_action_cancelled", undefined, {
    human_action_id: action.id,
    reason,
    source,
  });
}

/** Internal system handoff, not a claim that an administrator performed the install. */
export function retireVerifiedHelperAction(
  state: CommandState,
  actor: Actor,
  target: { machine_id: string; binding: string; key: string },
  ports: CommandPorts,
) {
  return command(state, actor, "record_deployment", ports, (d) => {
    for (const action of d.list("human_actions")) {
      if (
        action.status !== "open" ||
        action.helper_upgrade?.binding !== target.binding
      )
        continue;
      const origin = workerHelperAction(state, action);
      if (origin?.machine_id === target.machine_id && origin.key === target.key)
        supersedeHelperAction(
          d,
          action,
          "该绑定和版本已通过自动升级核验，不再需要人工安装",
        );
    }
  });
}

/** C-599: one namespace of host-refreshed worker notices per machine. */
const REFRESHABLE_PREFIX = /^worker-agent-tools:[a-zA-Z0-9][a-zA-Z0-9._-]*:$/u;

/**
 * Internal system handoff: cancel the open worker maintenance notices of one
 * refreshable namespace whose command no longer matches the current binding
 * and release (`keep` is the current key, if any). Never reports them done.
 */
export function retireWorkerMaintenanceActions(
  state: CommandState,
  actor: Actor,
  target: { prefix: string; keep?: string; reason: string },
  ports: CommandPorts,
) {
  return command(state, actor, "record_deployment", ports, (d) => {
    ensure(
      REFRESHABLE_PREFIX.test(target.prefix) &&
        (target.keep === undefined || target.keep.startsWith(target.prefix)) &&
        target.reason.trim().length > 0,
      "validation_failed",
      "只能淘汰同一台机器的可刷新维护待办",
    );
    const actions = new Map(d.list("human_actions").map((h) => [h.id, h]));
    for (const e of eventsOfType(
      state.events,
      "host_deployment_action_requested",
    )) {
      const p = e.payload as {
        key?: unknown;
        reason?: unknown;
        human_action_id?: unknown;
      };
      if (
        e.actor.kind !== "system" ||
        e.actor.project_id !== state.project_id ||
        e.card_id ||
        p.reason !== "worker_maintenance" ||
        typeof p.key !== "string" ||
        !p.key.startsWith(target.prefix) ||
        p.key === target.keep
      )
        continue;
      const action = actions.get(p.human_action_id as HumanActionId);
      if (
        action?.status !== "open" ||
        action.requested_by !== "system" ||
        action.card_id ||
        action.blocked_work_items.length
      )
        continue;
      supersedeHelperAction(d, action, target.reason);
      actions.delete(action.id);
    }
  });
}

export function requestDeploymentAction(
  state: CommandState,
  actor: Actor,
  input: DeploymentActionInput,
  ports: CommandPorts,
) {
  return command(state, actor, "record_deployment", ports, (d) => {
    if (input.helper_upgrade) {
      for (const previous of d.list("human_actions")) {
        if (previous.status !== "open") continue;
        const old = workerHelperAction(state, previous);
        if (
          !old ||
          old.machine_id !== input.helper_upgrade.machine_id ||
          old.key === input.key
        )
          continue;
        const reason = "已由当前发行版的 worker 升级待办取代";
        supersedeHelperAction(d, previous, reason);
      }
    }
    const prior = state.events.findLast(
      (e) =>
        e.type === "host_deployment_action_requested" &&
        !e.card_id &&
        e.actor.kind === "system" &&
        e.actor.project_id === state.project_id &&
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
    if (
      existing &&
      (input.reason !== "worker_maintenance" || existing.status === "open")
    ) {
      if (
        input.helper_upgrade &&
        (existing.terminal?.command !== input.terminal?.command ||
          existing.instructions !== input.instructions ||
          existing.helper_upgrade?.binding !== input.helper_upgrade.binding)
      ) {
        const { terminal: _old, helper_checks: _checks, ...rest } = existing;
        const updated = {
          ...rest,
          instructions: input.instructions,
          helper_upgrade: input.helper_upgrade,
          ...(input.terminal ? { terminal: input.terminal } : {}),
        };
        d.put("human_actions", updated);
        d.emit("worker_helper_upgrade_updated", undefined, {
          human_action_id: updated.id,
        });
        return updated;
      }
      return existing;
    }
    return createDeploymentAction(d, input);
  });
}

function createDeploymentAction(d: CommandDraft, input: DeploymentActionInput) {
  const id = d.ids.next(d.state.project_id, "human_action");
  const action: HumanAction = {
    id,
    key: id,
    requested_by: "system",
    ...(input.terminal ? { terminal: input.terminal } : {}),
    ...(input.helper_upgrade ? { helper_upgrade: input.helper_upgrade } : {}),
    status: "open",
    ...(input.reason ? { category: "general" as const } : {}),
    triage:
      input.reason === "worker_maintenance"
        ? "host"
        : input.reason === "evidence_wait"
          ? "pm_ops"
          : "human",
    ...(input.reason === "worker_maintenance"
      ? { host_operator: "host_ops" as const }
      : {}),
    instructions: input.instructions,
    why_human:
      input.reason === "worker_maintenance"
        ? "请主机运维核对远程 worker；需要 root 安装时请管理员处理"
        : input.reason === "evidence_wait"
          ? "中心 main 持续缺少合并门禁证据，请后台分拣核对"
          : "部署或角色权限变更需要主机管理员处理，Agent 没有执行权限",
    expected_return: "记录核对及处理结果后标记完成",
    blocked_work_items: [],
  };
  d.put("human_actions", action);
  d.emit("host_deployment_action_requested", undefined, {
    key: input.key,
    ...(input.reason === "worker_maintenance" ? { reason: input.reason } : {}),
    human_action_id: id,
  });
  d.emit("human_action_requested", undefined, {
    ...(input.reason === "worker_maintenance"
      ? { disposition: "host" as const }
      : {}),
    human_action_id: id,
    blocked_work_items: [],
  });
  return action;
}

/** Only the watch process supplies a verified tree comparison. A notice is never deployment authority. */
export function reconcileSupervisorNotice(
  state: CommandState,
  actor: Actor,
  input: { supervisor: string; main: string; affected: readonly string[] },
  ports: CommandPorts,
) {
  return command(state, actor, "record_deployment", ports, (d) => {
    const { supervisor, main, affected } = input;
    ensure(
      [supervisor, main].every((sha) => /^[a-f0-9]{40}$/u.test(sha)),
      "validation_failed",
      "需要完整提交 SHA",
    );
    const key = `supervisor-outdated:${supervisor}`;
    let current: HumanAction | undefined;
    for (const e of eventsOfType(
      state.events,
      "host_deployment_action_requested",
    )) {
      if (
        e.actor.kind !== "system" ||
        e.actor.project_id !== state.project_id ||
        e.card_id
      )
        continue;
      const request = e.payload as { key: string; human_action_id: string };
      if (!/^supervisor-outdated:[a-f0-9]{40}$/u.test(request.key)) continue;
      const action = d
        .list("human_actions")
        .find((h) => h.id === request.human_action_id);
      if (
        action?.requested_by !== "system" ||
        action.card_id ||
        action.blocked_work_items.length
      )
        continue;
      if (request.key === key) current = action;
      if (action.status !== "open" || (request.key === key && affected.length))
        continue;
      const reason =
        request.key === key
          ? `监督器 ${supervisor} 与中心 main ${main} 没有监督器运行差异，无需升级`
          : `该提醒所指的监督器版本已不在运行，当前为 ${supervisor}，旧提醒无需处理`;
      d.put("human_actions", {
        ...action,
        status: unwrap(transition("human_action", action.status, "cancel")),
        cancellation: {
          reason,
          by: d.author,
          at: d.now,
          source: "supervisor_rechecked",
        },
      });
      d.emit("human_action_cancelled", undefined, {
        human_action_id: action.id,
        reason,
        source: "supervisor_rechecked",
      });
    }
    // Legacy false alarms do not consume the one verified reminder per running SHA.
    if (
      !affected.length ||
      eventsOfType(state.events, "host_deployment_supervisor_change").some(
        (e) =>
          e.actor.kind === "system" &&
          e.actor.project_id === state.project_id &&
          !e.card_id &&
          (e.payload as { supervisor?: string }).supervisor === supervisor,
      )
    )
      return;
    if (
      current &&
      current.status !== "open" &&
      current.cancellation?.source !== "supervisor_rechecked"
    )
      return;
    const instructions = `部署监督器仍运行 ${supervisor}。到中心 main ${main} 的差异涉及：${affected.join("、")}。请按 cardigan-deploy README「升级监督器本身」在维护窗口更新；系统不会自我升级。`;
    const action =
      current?.status === "open"
        ? { ...current, instructions }
        : createDeploymentAction(d, { key, instructions });
    if (current?.status === "open") d.put("human_actions", action);
    d.emit("host_deployment_supervisor_change", undefined, {
      supervisor,
      main,
      affected: [...affected],
      human_action_id: action.id,
    });
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
