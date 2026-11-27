import type { Assignment } from "../entities.js";
import { hostOpsPending } from "../host-ops.js";
import type { DeliveryId, WorkItemId } from "../ids.js";
import {
  effectiveWorkItemRequirements,
  mergeMachineRequirements,
} from "../machine-requirements.js";
import {
  remoteWorkerLosses,
  remoteWorkerLossReleased,
} from "../remote-worker-loss.js";
import { isRoleActive } from "../role.js";
import { requireCardDependencyStart } from "./card-dependencies.js";
import { type CommandDraft, ensure, unwrap } from "./core.js";
import {
  checkEmployeeNotExternal,
  checkEmployeeSeparation,
  employeeAssignmentLoad,
  resolveEmployee,
  selectEmployee,
} from "./employee-assignment.js";
import {
  continuesConfirmedTakeover,
  firstLaunchFailed,
  releasedBeforeFirstLaunch,
} from "./failed-placement.js";
import { hostOpsExitConfirmation } from "./host-ops-actions.js";
import { type MachineRequirements, selectMachine } from "./machines.js";
import { canStartWork } from "./workflow.js";

export interface AssignWorkItemParams extends MachineRequirements {
  work_item_id: WorkItemId;
  role_id: string;
  role_version?: number;
  employee_id?: string;
  machine_id?: string;
  recovery_source?: "main" | "backup";
  confirm_same_machine?: boolean;
}

/** Shared invariant checks; callers establish PM or system authority first. */
export function assignWorkItem(
  d: CommandDraft,
  p: AssignWorkItemParams,
  automaticTarget?: DeliveryId | "first_producer",
) {
  ensure(
    p.role_id !== "host_ops",
    "validation_failed",
    "host_ops 只能创建常驻 Assignment，不能指派工作项",
  );
  const item = d.work(p.work_item_id);
  ensure(
    !d.card(item.card_id).story,
    "illegal_transition",
    "需求卡由常驻 Office 处理，不另派工作会话",
  );
  requireCardDependencyStart(d, d.card(item.card_id));
  ensure(
    !d.card(item.card_id).hold,
    "illegal_transition",
    "卡片已暂停，请先解除暂停",
  );
  ensure(
    item.role_id === p.role_id,
    "validation_failed",
    "Assignment role must match the work item",
  );
  const existing = d
    .list("assignments")
    .filter((a) => a.scope === "work_item" && a.work_item_id === item.id);
  ensure(
    !item.replaced_by_work_item_id,
    "illegal_transition",
    "已被替换的验证项不能再指派",
  );
  const previous = existing.find((a) => a.id === item.assignment_id);
  const retry =
    previous && releasedBeforeFirstLaunch(d, previous, item.card_id)
      ? previous
      : undefined;
  const version = p.role_version ?? retry?.role_version;
  const role = d.state.roles
    .filter(
      (r) =>
        r.role_id === p.role_id &&
        (version === undefined || r.role_version === version),
    )
    .sort((a, b) => b.role_version - a.role_version)[0];
  ensure(role, "not_found", "Role version was not found");
  const confirmedLoss = (a: Assignment | undefined) =>
    a?.status === "released"
      ? remoteWorkerLosses(d.state.events).find(
          (loss) =>
            loss.assignment_id === a.id &&
            loss.work_item_id === item.id &&
            remoteWorkerLossReleased(d.state.events, loss.action_id) &&
            hostOpsExitConfirmation(d.state, loss.action_id).status ===
              "confirmed",
        )
      : undefined;
  const recovery = confirmedLoss(previous);
  const confirmSameMachine = p.confirm_same_machine === true;
  // C-716: a confirmed same-machine retry of a first launch, or its repeat.
  const prior = previous?.recovery
    ? existing.find((a) => a.id === previous.recovery?.previous_assignment_id)
    : undefined;
  const sameMachineRetry =
    confirmSameMachine &&
    (!!retry ||
      (previous?.status === "active" &&
        !!previous.recovery?.same_machine_confirmed_by &&
        !!prior &&
        releasedBeforeFirstLaunch(d, prior, item.card_id)));
  if (confirmSameMachine) {
    // A repeat may return the already-created successor, but cannot turn an ordinary assign into a recovery.
    ensure(
      recovery ||
        retry ||
        (previous?.status === "active" &&
          previous.recovery?.same_machine_confirmed_by &&
          !hostOpsPending(d.state.events, previous.id)),
      "validation_failed",
      "同机恢复需要已确认旧进程退出并已释放的失联指派",
    );
    ensure(
      p.machine_id !== undefined && p.machine_id === previous?.machine_id,
      "validation_failed",
      "确认同机恢复时必须显式指定原机器",
    );
  }
  if (recovery || (confirmSameMachine && !sameMachineRetry))
    ensure(
      !automaticTarget &&
        (p.recovery_source === "main" || p.recovery_source === "backup"),
      "validation_failed",
      "失联恢复必须显式选择 main 或 backup 作为恢复来源",
    );
  if (recovery || retry) {
    ensure(
      !existing.some((a) => hostOpsPending(d.state.events, a.id)),
      "illegal_transition",
      "工作项仍有待处理的退出确认或主机运维操作",
    );
    ensure(
      existing.every((a) => a.status === "released"),
      "invariant_violation",
      "工作项仍有未释放的指派，不能恢复",
    );
    if (retry) {
      ensure(
        !automaticTarget &&
          p.recovery_source === undefined &&
          p.role_id === retry.role_id &&
          version === retry.role_version,
        "validation_failed",
        "首发失败恢复须保留原工作项和角色",
      );
      // C-716: a human or PM may name any eligible machine. Only the machine
      // where the first launch really failed needs an explicit confirmation;
      // a released queue that never started is not a failure.
      ensure(
        p.machine_id !== retry.machine_id ||
          confirmSameMachine ||
          !firstLaunchFailed(d, retry),
        "validation_failed",
        `首发在 ${retry.machine_id} 上失败；请指定另一台机器，或确认同机重试（CLI：--confirm-same-machine；MCP：confirm_same_machine=true）`,
      );
      ensure(
        canStartWork({ item, work_items: d.list("work_items") }) ||
          // A confirmed takeover continues the same in-progress work; it cannot start it again.
          (item.status === "in_progress" &&
            !item.reported_blocker &&
            continuesConfirmedTakeover(
              d,
              retry,
              item.card_id,
              existing,
              (a) => !!confirmedLoss(a),
            )),
        "illegal_transition",
        "工作项尚不可启动，不能重新选机",
      );
    } else if (recovery) {
      ensure(
        p.machine_id !== undefined,
        "validation_failed",
        "失联恢复必须显式指定机器",
      );
      ensure(
        p.machine_id !== previous?.machine_id || confirmSameMachine,
        "validation_failed",
        "请指定另一台机器，或显式确认同机恢复（CLI：--confirm-same-machine；MCP：confirm_same_machine=true）",
      );
    }
  } else if (existing.length || item.assignment_id) {
    const current = previous;
    ensure(
      existing.every(
        (a) =>
          a.id === current?.id ||
          releasedBeforeFirstLaunch(d, a, item.card_id) ||
          (a.status === "released" &&
            remoteWorkerLosses(d.state.events).some(
              (loss) =>
                loss.assignment_id === a.id &&
                remoteWorkerLossReleased(d.state.events, loss.action_id),
            )),
      ) &&
        current &&
        current.id === item.assignment_id &&
        current.status === "active" &&
        current.role_id === p.role_id &&
        (p.role_version === undefined ||
          current.role_version === p.role_version),
      "invariant_violation",
      "A work item has one persistent assignment",
    );
    ensure(
      !p.recovery_source || current.recovery?.source === p.recovery_source,
      "stale_target",
      "当前指派的恢复来源已固定，不能更改",
    );
    ensure(
      p.machine_id === undefined || p.machine_id === current.machine_id,
      "invariant_violation",
      "Assignment 的机器创建后不能修改",
    );
    const employee_id =
      p.employee_id === undefined
        ? current.employee_id
        : resolveEmployee(d, p.employee_id).id;
    checkEmployeeNotExternal(d, employee_id);
    ensure(
      p.employee_id === undefined || employee_id === current.employee_id,
      "invariant_violation",
      "Assignment 的员工创建后不能修改",
    );
    checkEmployeeSeparation(d, item, current.employee_id);
    return current;
  }
  ensure(
    isRoleActive(d.state.roles, p.role_id),
    "validation_failed",
    "停用的角色不能被新指派",
  );
  const card = d.card(item.card_id);
  ensure(
    card.status !== "done" && card.status !== "cancelled",
    "illegal_transition",
    "Card is closed",
  );
  ensure(
    !p.recovery_source || recovery,
    "validation_failed",
    "失联恢复需要已确认旧进程退出并已释放的失联指派",
  );
  // A pre-launch retry changes the machine, not an already confirmed recovery source.
  const source = retry?.recovery?.source ?? p.recovery_source ?? "main";
  const backup = retry ? retry.recovery?.backup : recovery?.backup;
  ensure(
    source !== "backup" || backup,
    "validation_failed",
    "没有可用的成功备份，不能从 backup 恢复",
  );
  const employee = selectEmployee(
    d,
    item,
    p.employee_id ?? (recovery || retry ? previous?.employee_id : undefined),
  );
  ensure(
    !retry || retry.employee_id === employee?.id,
    "validation_failed",
    "首发失败恢复须保留原员工",
  );
  const selection =
    automaticTarget && employee
      ? employeeAssignmentLoad(d, employee)
      : undefined;
  const requested = {
    ...(p.os === undefined ? {} : { os: p.os }),
    ...(p.arch === undefined ? {} : { arch: p.arch }),
    ...(p.required_tags === undefined ? {} : { tags: [...p.required_tags] }),
  };
  const required = unwrap(
    mergeMachineRequirements(
      unwrap(effectiveWorkItemRequirements(item.requirements, role)),
      requested,
    ),
  );
  const { machine_id, audit } = selectMachine(
    d,
    item,
    required,
    role.worktree,
    {
      failedMachine: retry?.machine_id,
      explicit: p.machine_id,
      profile: employee?.launch_profile_ref ?? role.launch_profile_ref,
    },
  );
  const queued_on = audit?.queued_on;
  const id = d.ids.next(d.state.project_id, "assignment");
  const token_id = `assignment:${JSON.stringify([d.state.project_id, id])}`;
  const assignment: Assignment = {
    id,
    scope: "work_item" as const,
    work_item_id: item.id,
    ...(employee ? { employee_id: employee.id } : {}),
    role_id: role.role_id,
    role_version: role.role_version,
    status: "active" as const,
    runtime_state: "not_provisioned" as const,
    machine_id,
    runtime_ref: null,
    ...(previous && (retry || recovery)
      ? {
          recovery: {
            previous_assignment_id: previous.id,
            source,
            ...(confirmSameMachine
              ? { same_machine_confirmed_by: d.author }
              : {}),
            ...(source === "backup" && backup ? { backup } : {}),
          },
        }
      : {}),
    mcp_token_id: token_id,
    created_at: d.now,
  };
  d.put("assignments", assignment);
  d.put("work_items", { ...item, assignment_id: id });
  d.token_requests.push({
    token_id,
    assignment_id: id,
    role_version: role.role_version,
    allowed_tools: role.allowed_tools,
  });
  d.emit(
    "work_item_assigned",
    card.id,
    {
      work_item_id: item.id,
      assignment_id: id,
      machine_id,
      ...(assignment.recovery ? { recovery: { ...assignment.recovery } } : {}),
      ...(automaticTarget
        ? {
            rule: "C-225/auto-assign",
            ...(automaticTarget === "first_producer"
              ? { first_producer: true }
              : { delivery_id: automaticTarget }),
            assigned_by: "system",
            selection_order: [
              "active_assignments_ascending",
              "employee_number_ascending",
            ],
            selection: {
              active_assignments: selection ?? 0,
              employee_number: Number(employee?.id.slice(2)),
            },
          }
        : {}),
      ...(employee ? { employee_id: employee.id } : {}),
    },
    {
      type: "status_change",
      body: `${
        automaticTarget
          ? `系统按角色 ${role.role_id} 自动指派 ${item.id} 给 ${employee?.id}（${automaticTarget === "first_producer" ? "首个产出项" : `交付 ${automaticTarget}`}；活跃 Assignment 数 ${selection ?? 0}，负载最少、员工编号依次优先）`
          : confirmSameMachine && retry
            ? `${d.author} 确认 ${item.id} 在首发失败的原机器 ${machine_id} 重试：${previous?.id} → ${id}`
            : confirmSameMachine
              ? `${d.author} 确认 ${item.id} 在原机器 ${machine_id} 从 ${source} 恢复：${previous?.id} → ${id}`
              : `Assigned ${item.id} to ${role.role_id}`
      }${queued_on ? `；合格机器均已满，在 ${machine_id} 排队（${queued_on.join("，")}）` : ""}`,
      work_item_id: item.id,
    },
  );
  if (audit)
    d.emit("machine_selected", card.id, {
      work_item_id: item.id,
      assignment_id: id,
      machine_id,
      // C-826: what the caller asked for beyond the work item and role, so a
      // queue migration can repeat this selection.
      requested,
      ...audit,
    });
  return assignment;
}
