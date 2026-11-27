import type { Actor, Assignment, Run } from "../entities.js";
import type { Result } from "../errors.js";
import { eventsOfType } from "../event-index.js";
import { hostOpsPending } from "../host-ops.js";
import type { RunId } from "../ids.js";
import {
  effectiveWorkItemRequirements,
  mergeMachineRequirements,
  type WorkItemRequirements,
} from "../machine-requirements.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { neverDispatchedQueue } from "./failed-placement.js";
import { cancelRunDispatch } from "./launch.js";
import { selectMachine } from "./machines.js";
import { stoppedByHuman } from "./stop-state.js";

/** C-826: how long a Run waits for slots before another machine is considered. */
export const DEFAULT_QUEUED_MIGRATE_AFTER_MS = 5 * 60_000;
/** C-826: no further migration of the same work item within this interval. */
export const DEFAULT_QUEUED_MIGRATION_COOLDOWN_MS = 30 * 60_000;

export interface MigrateQueuedRunParams {
  readonly run_id: RunId;
  /** Machines on which the host found this Run could start right now. */
  readonly admissible: readonly string[];
  /** Why the Run cannot start on its own machine, as the host diagnosed it. */
  readonly reason: string;
  /** Start of the current queue episode. */
  readonly queued_at: string;
  readonly cooldown_ms?: number;
}

/** Fields an Assignment gains once it is provisioned or has launched once. */
export function startedAssignment(a: Assignment) {
  return (
    a.runtime_state !== "not_provisioned" ||
    !!a.runtime_ref ||
    !!a.session_ref ||
    !!a.worktree_path ||
    !!a.branch ||
    !!a.base_sha
  );
}

type Migration = {
  readonly work_item_id?: string;
  readonly at?: string;
};

/** C-826: the caller's extra requirements recorded by the automatic selection. */
function requestedRequirements(
  d: CommandDraft,
  a: Assignment,
): WorkItemRequirements | undefined {
  const selected = eventsOfType(d.state.events, "machine_selected").findLast(
    (e) =>
      e.actor.project_id === d.state.project_id &&
      (e.payload as { assignment_id?: string } | null)?.assignment_id === a.id,
  );
  const requested = (selected?.payload as { requested?: unknown } | undefined)
    ?.requested;
  return typeof requested === "object" &&
    requested !== null &&
    !Array.isArray(requested)
    ? (requested as WorkItemRequirements)
    : undefined;
}

function refusal(
  d: CommandDraft,
  a: Assignment,
  run: Run,
  cooldown: number,
): string | undefined {
  if (run.status !== "queued" || run.queue_reason !== "concurrency_limit")
    return `${run.id} 不是因名额排队的 Run`;
  if (a.scope !== "work_item" || a.external || a.status !== "active")
    return `${a.id} 不是在岗的工作项指派`;
  const item = d.work(a.work_item_id);
  const card = d.card(item.card_id);
  if (item.assignment_id !== a.id || item.replaced_by_work_item_id)
    return `${item.id} 的当前指派已变化`;
  if (card.hold || card.story || ["done", "cancelled"].includes(card.status))
    return `${card.id} 已暂停或已结束`;
  // Only a never-started identity moves; started work stays with its worktree.
  if (startedAssignment(a) || !neverDispatchedQueue(d, run, card.id))
    return `${a.id} 已开过工（有会话、工作区或派发记录），留在 ${a.machine_id} 继续等`;
  if (a.role_upgrade || hostOpsPending(d.state.events, a.id))
    return `${a.id} 有待处理的主机操作`;
  if (stoppedByHuman(d.state.events, a.id)) return `${a.id} 已被人停止`;
  if (d.ports?.unreservedAssignment?.(d.state.project_id, a.id) !== true)
    return `${a.id} 正在启动`;
  if (!requestedRequirements(d, a))
    return `${a.id} 的机器不是系统按规则选的，不自动迁移`;
  const last = migrations(d, item.id).at(-1);
  if (last?.at && Date.parse(d.now) - Date.parse(last.at) < cooldown)
    return `${item.id} 刚迁移过，冷却中`;
  return undefined;
}

function migrations(d: CommandDraft, work_item_id: string): Migration[] {
  return eventsOfType(d.state.events, "queued_run_migrated")
    .filter(
      (e) =>
        e.actor.kind === "system" &&
        e.actor.project_id === d.state.project_id &&
        (e.payload as Migration | null)?.work_item_id === work_item_id,
    )
    .map((e) => ({ ...(e.payload as Migration), at: e.created_at }));
}

function duration(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours
    ? `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`
    : `${minutes} 分钟`;
}

/**
 * C-826: move a never-started work-item Assignment whose Run has waited for
 * slots on its machine to a machine where it can start now. In one
 * transaction: cancel the queued Run, release the old identity (the same
 * prelaunch release a human uses, C-716) and create its successor on the
 * target, which inherits the employee, role version and recovery source.
 * The successor's own assignment event starts it; the old owner's pending
 * bells are handed over by the dispatcher (C-527).
 *
 * The target is chosen by the same `selectMachine` as an assignment, with
 * the original machine and machines the host did not find admissible
 * excluded; it must have room now. After a migration the work item cools
 * down before it may move again, to any machine including the one it left.
 */
export function migrateQueuedRun(
  state: CommandState,
  actor: Actor,
  p: MigrateQueuedRunParams,
  ports: CommandPorts,
): Result<CommandEffect<Assignment>> {
  return command(state, actor, "migrate_queued_run", ports, (d) => {
    const run = d.get("runs", p.run_id);
    const a = d.get("assignments", run.assignment_id);
    const cooldown = p.cooldown_ms ?? DEFAULT_QUEUED_MIGRATION_COOLDOWN_MS;
    ensure(
      Number.isSafeInteger(cooldown) && cooldown >= 0,
      "validation_failed",
      "Invalid migration cooldown",
    );
    const refused = refusal(d, a, run, cooldown);
    ensure(
      !refused && a.scope === "work_item",
      "illegal_transition",
      refused ?? "",
    );
    const item = d.work(a.work_item_id);
    const role = d.state.roles.find(
      (r) => r.role_id === a.role_id && r.role_version === a.role_version,
    );
    ensure(role, "not_found", "Role version was not found");
    const employee = a.employee_id
      ? d.state.employees?.find((e) => e.id === a.employee_id)
      : undefined;
    const required = unwrap(
      mergeMachineRequirements(
        unwrap(effectiveWorkItemRequirements(item.requirements, role)),
        requestedRequirements(d, a),
      ),
    );
    const admissible = new Set(p.admissible);
    const exclude = new Map<string, string>();
    for (const m of d.list("machines"))
      if (!admissible.has(m.id)) exclude.set(m.id, "主机核对：现在不能开工");
    exclude.set(a.machine_id, "当前排队所在机器");
    const { machine_id, audit } = selectMachine(
      d,
      item,
      required,
      role.worktree,
      {
        profile: employee?.launch_profile_ref ?? role.launch_profile_ref,
        exclude,
      },
    );
    const chosen = audit?.candidates[0];
    ensure(
      chosen &&
        machine_id !== a.machine_id &&
        (chosen.remaining_ratio ?? 0) > 0 &&
        !audit.queued_on,
      "illegal_transition",
      "没有现在就能开工的机器",
    );
    const queuedAt = Date.parse(p.queued_at);
    const waited = Number.isFinite(queuedAt) ? Date.parse(d.now) - queuedAt : 0;
    cancelRunDispatch(
      d,
      run,
      `排队 ${duration(waited)} 后改到 ${machine_id}，取消原机器上的排队`,
    );
    d.put("assignments", {
      ...a,
      status: unwrap(transition("assignment", a.status, "release")),
      runtime_state: unwrap(transition("runtime", a.runtime_state, "release")),
      released_at: d.now,
    });
    const migration = {
      run_id: run.id,
      from_assignment_id: a.id,
      from_machine: a.machine_id,
      to_machine: machine_id,
    };
    d.emit("assignment_released", item.card_id, {
      assignment_id: a.id,
      cancelled_queued_run_id: run.id,
      worktree_path: null,
      branch: null,
      token_id: a.mcp_token_id,
      runtime_ref: null,
      queue_migration: migration,
    });
    const id = d.ids.next(d.state.project_id, "assignment");
    const token_id = `assignment:${JSON.stringify([d.state.project_id, id])}`;
    const source = a.recovery?.source ?? "main";
    const recovery = {
      previous_assignment_id: a.id,
      source,
      ...(source === "backup" && a.recovery?.backup
        ? { backup: a.recovery.backup }
        : {}),
    };
    const successor: Assignment = {
      id,
      scope: "work_item",
      work_item_id: item.id,
      ...(a.employee_id ? { employee_id: a.employee_id } : {}),
      role_id: a.role_id,
      role_version: a.role_version,
      status: "active",
      runtime_state: "not_provisioned",
      machine_id,
      runtime_ref: null,
      recovery,
      mcp_token_id: token_id,
      created_at: d.now,
    };
    d.put("assignments", successor);
    d.put("work_items", { ...item, assignment_id: id });
    d.token_requests.push({
      token_id,
      assignment_id: id,
      role_version: role.role_version,
      allowed_tools: role.allowed_tools,
    });
    d.emit("work_item_assigned", item.card_id, {
      work_item_id: item.id,
      assignment_id: id,
      machine_id,
      recovery: { ...recovery },
      queue_migration: migration,
      ...(a.employee_id ? { employee_id: a.employee_id } : {}),
    });
    d.emit("machine_selected", item.card_id, {
      work_item_id: item.id,
      assignment_id: id,
      machine_id,
      requested: { ...requestedRequirements(d, a) },
      ...audit,
    });
    d.emit(
      "queued_run_migrated",
      item.card_id,
      {
        ...migration,
        work_item_id: item.id,
        to_assignment_id: id,
        reason: p.reason,
        queued_at: p.queued_at,
        waited_ms: waited,
      },
      {
        type: "status_change",
        work_item_id: item.id,
        body: `${run.id} 在 ${a.machine_id} 排队 ${duration(waited)}（${p.reason}），已自动改到 ${machine_id}：${a.id} → ${id}`,
      },
    );
    return successor;
  });
}
