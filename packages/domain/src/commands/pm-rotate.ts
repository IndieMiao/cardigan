import type { Actor, Assignment, StandingMode, ToolName } from "../entities.js";
import type { Result } from "../errors.js";
import type { DecisionId, HumanActionId, RunId } from "../ids.js";
import { isRoleActive } from "../role.js";
import { transition } from "../transitions.js";
import {
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { resolveEmployee } from "./employee-assignment.js";

export interface RotateStandingPmResult {
  /** True when the role version and explicitly requested identity already match. */
  readonly unchanged: boolean;
  readonly previous: Assignment;
  /** The new standing Assignment; equals `previous` when unchanged. */
  readonly assignment: Assignment;
  readonly from_version: number;
  readonly to_version: number;
  /** PM Ops items that now belong to the new Assignment (never the human). */
  readonly decisions: readonly DecisionId[];
  readonly human_actions: readonly HumanActionId[];
  readonly cancelled_run_ids: readonly RunId[];
}

const LABEL = { ops: "PM Ops", office: "PM Office" } as const;

/**
 * `cardigan pm rotate`: move one standing PM to the newest pm role version.
 *
 * Assignments pin their role version for life, so the only way to give a
 * standing PM new tools is a new Assignment. The new one is written before the
 * old one is released, all in one effect, so `hasActivePmOps` never sees a gap
 * and nothing that belongs to the PM is handed back to the human. Tokens and
 * the router inbox live in the host store; the host applies them in the same
 * transaction that persists this effect.
 */
export function rotateStandingPm(
  state: CommandState,
  actor: Actor,
  p: {
    readonly standing_mode: StandingMode;
    readonly external?: boolean;
    readonly employee_id?: string;
  },
  ports: CommandPorts,
): Result<CommandEffect<RotateStandingPmResult>> {
  return command(state, actor, "rotate_standing_pm", ports, (d) => {
    ensure(
      d.actor.kind === "human",
      "unauthorized",
      "只有人可以给常驻 PM 换版本",
    );
    ensure(
      p.standing_mode === "ops" || p.standing_mode === "office",
      "validation_failed",
      "standing_mode 必须是 ops 或 office",
    );
    ensure(
      p.external === undefined || typeof p.external === "boolean",
      "validation_failed",
      "external 必须是布尔值",
    );
    ensure(
      !p.external || p.standing_mode === "office",
      "validation_failed",
      "外接 Assignment 仅支持 standing Office",
    );
    const label = LABEL[p.standing_mode];
    const standing = d
      .list("assignments")
      .filter(
        (a) =>
          a.scope === "standing" &&
          a.role_id === "pm" &&
          a.standing_mode === p.standing_mode,
      );
    const active = standing.filter((a) => a.status === "active");
    ensure(
      active.length > 0,
      "not_found",
      standing.some((a) => a.status === "suspended")
        ? `${label} 已暂停，先用 cardigan pm start 恢复后再换版本`
        : `没有在岗的 ${label}，先运行 cardigan pm create`,
    );
    ensure(
      active.length === 1,
      "invariant_violation",
      `有多个在岗的 ${label}，无法确定要换哪一个`,
    );
    const previous = active[0] as Assignment;
    const latest = d.state.roles
      .filter((r) => r.role_id === "pm")
      .sort((a, b) => b.role_version - a.role_version)[0];
    ensure(latest, "not_found", "项目里没有 pm 角色");
    const employee =
      p.employee_id === undefined
        ? undefined
        : resolveEmployee(d, p.employee_id);
    if (employee) {
      ensure(
        employee.status === "active",
        "invariant_violation",
        "员工已停用，不能指派新工作",
      );
      ensure(
        employee.role_id === "pm",
        "validation_failed",
        "员工角色必须与 pm 一致",
      );
    }
    const employee_id = employee?.id ?? previous.employee_id;
    const result = {
      previous,
      from_version: previous.role_version,
      to_version: latest.role_version,
    };
    if (
      latest.role_version === previous.role_version &&
      employee_id === previous.employee_id &&
      (p.external === undefined || p.external === (previous.external ?? false))
    )
      return {
        ...result,
        unchanged: true,
        assignment: previous,
        decisions: [],
        human_actions: [],
        cancelled_run_ids: [],
      };
    ensure(
      latest.role_version >= previous.role_version,
      "invariant_violation",
      "pm 最新版本低于在岗版本",
    );
    ensure(
      isRoleActive(d.state.roles, "pm"),
      "validation_failed",
      "pm 角色已停用，不能换到新版本",
    );

    ensure(
      !p.external ||
        !d
          .list("runs")
          .some(
            (r) =>
              r.assignment_id === previous.id &&
              !["completed", "failed", "cancelled"].includes(r.status),
          ),
      "illegal_transition",
      "原 PM 仍有未结束的 Run，请先收尾再切换外接身份",
    );

    // PM-owned items stay with the role; the new Assignment is who serves it.
    const decisions =
      p.standing_mode === "ops"
        ? d
            .list("decisions")
            .filter(
              (q) =>
                q.decider === "role:pm" &&
                ["open", "provisional", "snoozed"].includes(q.status),
            )
            .map((q) => q.id)
        : [];
    const human_actions =
      p.standing_mode === "ops"
        ? d
            .list("human_actions")
            .filter((h) => h.status === "open" && h.triage === "pm_ops")
            .map((h) => h.id)
        : [];
    // The new version must be able to serve every item it inherits; otherwise
    // rotating would silently hand them to the human. Refuse before any write.
    const missing = new Set<ToolName>();
    for (const q of d.list("decisions"))
      if (decisions.includes(q.id))
        missing.add(
          q.trigger === "review_limit"
            ? "update_work_item"
            : "resolve_delegated_decision",
        );
    if (human_actions.length) missing.add("triage_human_action");
    const lacking = [...missing].filter(
      (tool) => !latest.allowed_tools.includes(tool),
    );
    ensure(
      lacking.length === 0,
      "validation_failed",
      `pm v${latest.role_version} 缺少 ${lacking.join("、")}，接不住 ${label} 现有的待处理事项（拍板 ${decisions.length} 项，待你执行 ${human_actions.length} 项）；没有做任何改动。先用 cardigan role upgrade pm --from-default 补齐工具再换版本`,
    );

    // 1. The replacement goes on duty first: there is never a moment without
    //    an active standing PM of this mode.
    const next: Assignment = {
      id: d.ids.next(d.state.project_id, "assignment"),
      scope: "standing",
      standing_mode: p.standing_mode,
      role_id: "pm",
      role_version: latest.role_version,
      status: "active",
      runtime_state: "not_provisioned",
      machine_id: previous.machine_id,
      runtime_ref: null,
      // The host issues external tokens on rotation; others on assignment start.
      mcp_token_id: p.standing_mode === "office" ? "pm-office" : "pm-ops",
      created_at: d.now,
      ...(employee_id === undefined ? {} : { employee_id }),
      ...(p.external === undefined ? {} : { external: p.external }),
    };
    d.put("assignments", next);

    // 2. The new session continues from the old ACK cursors.
    for (const cursor of d.list("cursors"))
      if (cursor.assignment_id === previous.id)
        d.put("cursors", { ...cursor, assignment_id: next.id });

    // 3. Unfinished Runs of the old session end; it can no longer report.
    const runs = d
      .list("runs")
      .filter(
        (r) =>
          r.assignment_id === previous.id &&
          !["completed", "failed", "cancelled"].includes(r.status),
      );
    for (const r of runs)
      d.put("runs", {
        ...r,
        status: unwrap(transition("run", r.status, "cancel")),
        outcome: "failed",
        summary: "Standing PM rotated to a new role version",
        finished_at: d.now,
      });

    // 4. Release the old Assignment.
    const released: Assignment = {
      ...previous,
      status: unwrap(transition("assignment", previous.status, "release")),
      runtime_state: unwrap(
        transition("runtime", previous.runtime_state, "release"),
      ),
      released_at: d.now,
    };
    d.put("assignments", released);

    d.emit("assignment_released", undefined, {
      assignment_id: previous.id,
      worktree_path: previous.worktree_path ?? null,
      branch: previous.branch ?? null,
      token_id: previous.mcp_token_id,
      runtime_ref: previous.runtime_ref ? { ...previous.runtime_ref } : null,
      replaced_by: next.id,
    });
    d.emit("standing_pm_rotated", undefined, {
      standing_mode: p.standing_mode,
      previous_assignment_id: previous.id,
      assignment_id: next.id,
      from_version: previous.role_version,
      to_version: next.role_version,
      ...(p.external === undefined ? {} : { external: p.external }),
      ...(employee_id === undefined ? {} : { employee_id }),
      decisions: [...decisions],
      human_actions: [...human_actions],
      cancelled_run_ids: runs.map((r) => r.id),
    });
    // No handoff: the new Ops is on duty and was checked to hold every tool
    // its inherited items need, so nothing is rewritten or returned to the human.
    ensure(
      !d.changes.some(
        (c) => c.collection === "decisions" || c.collection === "human_actions",
      ),
      "invariant_violation",
      "换版本不能改写拍板或待你执行",
    );
    return {
      ...result,
      unchanged: false,
      assignment: next,
      decisions,
      human_actions,
      cancelled_run_ids: runs.map((r) => r.id),
    };
  });
}
