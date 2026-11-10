import type { Actor, Assignment, Card, WorkItem } from "../entities.js";
import type { WorkItemId } from "../ids.js";
import { builtinCardTemplates, latestCardTemplate } from "../templates.js";
import { DEFAULT_MAX_REVIEW_ROUNDS, transition } from "../transitions.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import {
  checkEmployeeSeparation,
  resolveEmployee,
  selectEmployee,
} from "./employee-assignment.js";
import { canResume, queueResumedRun, resumeWork } from "./resumption.js";
import { resolveCardTemplate, validateCardTemplate } from "./templates.js";

export type CreateCardParams = Pick<
  Card,
  "title" | "goal" | "source" | "repo" | "base_branch"
> &
  Partial<
    Pick<
      Card,
      | "out_of_scope"
      | "related_cards"
      | "priority"
      | "deadline"
      | "template"
      | "acceptance_criteria"
    >
  > & { readonly template_id?: string };
export function createCard(
  state: CommandState,
  actor: Actor,
  p: CreateCardParams,
  ports: CommandPorts,
) {
  return command(state, actor, "create_card", ports, (d) => {
    d.pm();
    d.projectAccess();
    const acceptance = p.acceptance_criteria ?? [];
    text(p.title, "title");
    text(p.goal, "goal");
    ensure(
      !p.template || !p.template_id || p.template === p.template_id,
      "validation_failed",
      "template 与 template_id 不一致",
    );
    const templateId = p.template_id ?? p.template ?? "dev";
    const template =
      latestCardTemplate(ports.templates ?? [], templateId) ??
      latestCardTemplate(d.list("card_templates"), templateId) ??
      latestCardTemplate(builtinCardTemplates, templateId);
    ensure(template, "not_found", "模板不存在");
    ensure(
      template.status === "active",
      "validation_failed",
      "停用模板不能建卡",
    );
    validateCardTemplate(template, state.roles);
    if (template.requires_repo || p.repo !== undefined) text(p.repo, "repo");
    if (
      template.requires_repo ||
      p.repo !== undefined ||
      p.base_branch !== undefined
    )
      text(p.base_branch, "base_branch");
    ensure(
      p.base_branch === undefined || p.repo !== undefined,
      "validation_failed",
      "基线分支需要仓库",
    );
    ensure(
      Array.isArray(acceptance) &&
        (!template.require_acceptance_criteria || acceptance.length > 0) &&
        acceptance.every((s) => typeof s === "string" && s.trim()),
      "validation_failed",
      "Acceptance criteria are required",
    );
    ensure(
      p.source &&
        ((p.source.kind === "quote" &&
          typeof p.source.text === "string" &&
          p.source.text.trim()) ||
          (p.source.kind === "decision" &&
            d.get("decisions", p.source.decision_id))),
      "validation_failed",
      "Card source is required",
    );
    ensure(
      p.priority === undefined || Number.isFinite(p.priority),
      "validation_failed",
      "Invalid priority",
    );
    for (const id of p.related_cards ?? []) d.card(id);
    const id = d.ids.next(state.project_id, "card");
    const card: Card = {
      id,
      project_id: state.project_id,
      title: p.title,
      goal: p.goal,
      acceptance_criteria: [...acceptance],
      source: p.source,
      ...(p.repo === undefined ? {} : { repo: p.repo }),
      ...(p.base_branch === undefined ? {} : { base_branch: p.base_branch }),
      priority: p.priority ?? 0,
      status: "todo",
      template: template.id,
      template_version: template.version,
      merge_policy: template.merge,
      out_of_scope: p.out_of_scope ?? [],
      related_cards: p.related_cards ?? [],
      created_by: d.author,
      created_at: d.now,
      ...(p.deadline ? { deadline: p.deadline } : {}),
    };
    d.put("cards", card);
    const ids = new Map(
      template.work_items.map((w) => [
        w.key,
        d.ids.next(state.project_id, "work_item"),
      ]),
    );
    for (const w of template.work_items) {
      const itemId = ids.get(w.key);
      ensure(itemId, "invariant_violation", "Missing template item");
      const common = {
        id: itemId,
        card_id: id,
        title: w.title,
        role_id: w.role_id,
        required: w.required,
        depends_on: [],
        completion_criteria: [...acceptance],
        template_key: w.key,
        status: "todo" as const,
      };
      if (w.kind === "produce")
        d.put("work_items", { ...common, kind: "produce" });
      else
        d.put("work_items", {
          ...common,
          kind: "verify",
          max_review_rounds: DEFAULT_MAX_REVIEW_ROUNDS,
          ...(w.target_work_item_key !== undefined
            ? {
                target_work_item_id: ids.get(
                  w.target_work_item_key,
                ) as WorkItemId,
              }
            : {}),
        });
    }
    d.emit(
      "card_created",
      id,
      {
        card_id: id,
        template: template.id,
        template_version: template.version,
      },
      { type: "system", body: p.title },
    );
    return card;
  });
}
export function updateCard(
  state: CommandState,
  actor: Actor,
  p: {
    card_id: Card["id"];
    title?: string;
    goal?: string;
    acceptance_criteria?: readonly string[];
    priority?: number;
    status?: Card["status"];
  },
  ports: CommandPorts,
) {
  return command(state, actor, "update_card", ports, (d) => {
    d.pm();
    const card = d.card(p.card_id);
    if (p.title !== undefined) text(p.title, "title");
    if (p.goal !== undefined) text(p.goal, "goal");
    if (p.acceptance_criteria !== undefined)
      ensure(
        (!resolveCardTemplate(d, card).require_acceptance_criteria ||
          p.acceptance_criteria.length > 0) &&
          p.acceptance_criteria.every((s) => s.trim()),
        "validation_failed",
        "Acceptance criteria are required",
      );
    if (p.priority !== undefined)
      ensure(
        Number.isFinite(p.priority),
        "validation_failed",
        "Invalid priority",
      );
    let status = card.status;
    if (p.status !== undefined) {
      ensure(
        ["backlog", "todo", "cancelled"].includes(p.status),
        "illegal_transition",
        "Card progress and completion are not manually writable",
      );
      if (p.status !== status)
        status = unwrap(
          transition(
            "card",
            status,
            p.status === "cancelled" ? "cancel" : `set_${p.status}`,
          ),
        );
    }
    if (status === "cancelled" && card.status !== "cancelled") {
      for (const item of d
        .list("work_items")
        .filter((w) => w.card_id === card.id))
        if (
          item.status !== "cancelled" &&
          !(item.kind === "verify" && item.status === "passed")
        )
          d.put("work_items", d.move(item, "cancel"));
    }
    const result: Card = {
      ...card,
      status,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.goal !== undefined ? { goal: p.goal } : {}),
      ...(p.priority !== undefined ? { priority: p.priority } : {}),
      ...(p.acceptance_criteria !== undefined
        ? { acceptance_criteria: p.acceptance_criteria }
        : {}),
    };
    d.put("cards", result);
    d.emit(
      "card_updated",
      card.id,
      { card_id: card.id, status },
      { type: "status_change", body: result.title },
    );
    return result;
  });
}
/** Human-only bookkeeping for closed cards; never reopens or cancels work. */
export function supersedeCard(
  state: CommandState,
  actor: Actor,
  p: { card_id: Card["id"]; superseded_by: Card["id"] },
  ports: CommandPorts,
) {
  return command(state, actor, "supersede_card", ports, (d) => {
    const card = d.card(p.card_id);
    ensure(
      card.status === "done" || card.status === "cancelled",
      "illegal_transition",
      "Only done or cancelled cards can be superseded",
    );
    ensure(
      p.superseded_by !== card.id,
      "validation_failed",
      "A card cannot supersede itself",
    );
    const replacement = d.card(p.superseded_by);
    if (
      card.resolution === "superseded" &&
      card.superseded_by === replacement.id
    )
      return card;
    const result: Card = {
      ...card,
      resolution: "superseded",
      superseded_by: replacement.id,
      related_cards: [...new Set([...card.related_cards, replacement.id])],
    };
    d.put("cards", result);
    d.emit(
      "card_superseded",
      card.id,
      { card_id: card.id, superseded_by: replacement.id },
      {
        type: "status_change",
        body: `已被 ${replacement.id} 取代`,
        refs: [{ kind: "card", id: replacement.id }],
      },
    );
    return result;
  });
}

export type CreateWorkItemParams = Pick<
  WorkItem,
  "card_id" | "title" | "kind" | "role_id" | "required" | "completion_criteria"
> & {
  depends_on?: readonly WorkItemId[];
  target_work_item_id?: WorkItemId;
  max_review_rounds?: number;
};
export function createWorkItem(
  state: CommandState,
  actor: Actor,
  p: CreateWorkItemParams,
  ports: CommandPorts,
) {
  return command(state, actor, "create_work_item", ports, (d) => {
    d.pm();
    const card = d.card(p.card_id);
    text(p.title, "title");
    ensure(
      card.status !== "done" && card.status !== "cancelled",
      "illegal_transition",
      "Card is closed",
    );
    ensure(
      state.roles.some((r) => r.role_id === p.role_id),
      "not_found",
      "Role is unknown",
    );
    ensure(
      p.kind === "produce" || p.kind === "verify",
      "validation_failed",
      "Unknown work item kind",
    );
    for (const id of p.depends_on ?? [])
      ensure(
        d.work(id).card_id === card.id,
        "validation_failed",
        "Dependency must belong to the same card",
      );
    if (p.target_work_item_id) {
      const target = d.work(p.target_work_item_id);
      ensure(
        p.kind === "verify" &&
          target.kind === "produce" &&
          target.card_id === card.id,
        "validation_failed",
        "Verification target must be a producing work item on this card",
      );
    }
    const max = p.max_review_rounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
    ensure(
      Number.isSafeInteger(max) && max > 0,
      "validation_failed",
      "Invalid review limit",
    );
    if (max > DEFAULT_MAX_REVIEW_ROUNDS)
      ensure(
        actor.kind === "human" ||
          (d.assignment?.scope === "standing" &&
            actor.kind === "assignment" &&
            !actor.allowed_tools.includes("record_decision")),
        "forbidden_tool",
        "Only PM Ops or the human may raise review limits",
      );
    const common = {
      id: d.ids.next(state.project_id, "work_item"),
      card_id: card.id,
      title: p.title,
      role_id: p.role_id,
      required: p.required,
      completion_criteria: p.completion_criteria,
      depends_on: [...new Set(p.depends_on ?? [])],
      status: "todo" as const,
    };
    const item: WorkItem =
      p.kind === "produce"
        ? { ...common, kind: "produce" }
        : {
            ...common,
            kind: "verify",
            max_review_rounds: max,
            ...(p.target_work_item_id
              ? { target_work_item_id: p.target_work_item_id }
              : {}),
          };
    d.put("work_items", item);
    d.emit(
      "work_item_created",
      card.id,
      { work_item_id: item.id },
      { type: "system", body: item.title, work_item_id: item.id },
    );
    return item;
  });
}
export function updateWorkItem(
  state: CommandState,
  actor: Actor,
  p: {
    work_item_id: WorkItemId;
    status?: WorkItem["status"];
    title?: string;
    completion_criteria?: readonly string[];
    required?: boolean;
    max_review_rounds?: number;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "update_work_item", ports, (d) => {
    d.pm();
    const item = d.work(p.work_item_id);
    const resume = item.status === "blocked" && p.status === "in_progress";
    const confirmReported =
      p.status === "in_progress" &&
      item.reported_blocker !== undefined &&
      ["blocked", "waiting_decision"].includes(item.status);
    ensure(
      p.status === undefined ||
        p.status === item.status ||
        resume ||
        confirmReported,
      "illegal_transition",
      "Work item progress must follow its workflow events",
    );
    if (p.title !== undefined) text(p.title, "title");
    const card = d.card(item.card_id);
    ensure(
      card.status !== "done" && card.status !== "cancelled",
      "illegal_transition",
      "Card is closed",
    );
    ensure(
      !(item.template_key && p.required === false),
      "invariant_violation",
      "The development template's required items cannot be disabled",
    );
    if (p.max_review_rounds !== undefined) {
      ensure(
        item.kind === "verify" &&
          Number.isSafeInteger(p.max_review_rounds) &&
          p.max_review_rounds > 0,
        "validation_failed",
        "Only a verifier has a positive review limit",
      );
      ensure(
        actor.kind === "human" ||
          (d.assignment?.scope === "standing" &&
            actor.kind === "assignment" &&
            !actor.allowed_tools.includes("record_decision")),
        "forbidden_tool",
        "Only PM Ops or the human may change review limits",
      );
      ensure(
        p.max_review_rounds >= item.max_review_rounds,
        "validation_failed",
        "Review limits may only be relaxed",
      );
    }
    let result: WorkItem = {
      ...item,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.completion_criteria
        ? { completion_criteria: p.completion_criteria }
        : {}),
      ...(p.required !== undefined ? { required: p.required } : {}),
      ...(item.kind === "verify" && p.max_review_rounds !== undefined
        ? { max_review_rounds: p.max_review_rounds }
        : {}),
    };
    if (confirmReported) {
      const { reported_blocker: _confirmed, ...remaining } = result;
      result = remaining;
    }
    if (resume && !confirmReported)
      ensure(
        canResume(d, result),
        "illegal_transition",
        "Work item still has unresolved blockers or an exhausted review limit",
      );
    d.put("work_items", result);
    const resumed =
      resume ||
      confirmReported ||
      (item.status === "waiting_decision" &&
        item.kind === "verify" &&
        p.max_review_rounds !== undefined &&
        p.max_review_rounds > item.max_review_rounds)
        ? resumeWork(d, result)
        : undefined;
    if (resumed) result = resumed;
    const event = d.emit(
      "work_item_updated",
      item.card_id,
      {
        work_item_id: item.id,
        resume_work_items: resumed ? [item.id] : [],
        ...(confirmReported ? { reported_blocker_cleared: true } : {}),
        ...(p.max_review_rounds !== undefined
          ? { max_review_rounds: p.max_review_rounds }
          : {}),
      },
      { type: "status_change", body: result.title, work_item_id: item.id },
    );
    if (p.max_review_rounds !== undefined && item.assignment_id) {
      const run = d
        .list("runs")
        .filter((r) => r.assignment_id === item.assignment_id)
        .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
      if (run)
        d.put("runs", {
          ...run,
          review_limit_changes: [
            ...(run.review_limit_changes ?? []),
            {
              event_id: event.id,
              max_review_rounds: p.max_review_rounds,
              actor: d.author,
              at: event.created_at,
            },
          ],
        });
    }
    if (resumed) queueResumedRun(d, item, event);
    return result;
  });
}
export function assign(
  state: CommandState,
  actor: Actor,
  p: {
    work_item_id: WorkItemId;
    role_id: string;
    role_version?: number;
    employee_id?: string;
    machine_id?: string;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "assign", ports, (d) => {
    d.pm();
    const item = d.work(p.work_item_id);
    ensure(
      p.machine_id === undefined || p.machine_id === "local",
      "validation_failed",
      "M1 assignments run on local only",
    );
    ensure(
      item.role_id === p.role_id,
      "validation_failed",
      "Assignment role must match the work item",
    );
    const role = state.roles
      .filter(
        (r) =>
          r.role_id === p.role_id &&
          (p.role_version === undefined || r.role_version === p.role_version),
      )
      .sort((a, b) => b.role_version - a.role_version)[0];
    ensure(role, "not_found", "Role version was not found");
    const existing = d
      .list("assignments")
      .filter((a) => a.scope === "work_item" && a.work_item_id === item.id);
    if (existing.length || item.assignment_id) {
      const current = existing[0];
      ensure(
        existing.length === 1 &&
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
        p.employee_id === undefined ||
          resolveEmployee(d, p.employee_id).id === current.employee_id,
        "invariant_violation",
        "Assignment 的员工创建后不能修改",
      );
      checkEmployeeSeparation(d, item, current.employee_id);
      return current;
    }
    const card = d.card(item.card_id);
    ensure(
      card.status !== "done" && card.status !== "cancelled",
      "illegal_transition",
      "Card is closed",
    );
    const employee = selectEmployee(d, item, p.employee_id);
    const id = d.ids.next(state.project_id, "assignment");
    const token_id = `assignment:${JSON.stringify([state.project_id, id])}`;
    const assignment: Assignment = {
      id,
      scope: "work_item" as const,
      work_item_id: item.id,
      ...(employee ? { employee_id: employee.id } : {}),
      role_id: role.role_id,
      role_version: role.role_version,
      status: "active" as const,
      runtime_state: "not_provisioned" as const,
      machine_id: "local",
      runtime_ref: null,
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
        ...(employee ? { employee_id: employee.id } : {}),
      },
      {
        type: "status_change",
        body: `Assigned ${item.id} to ${role.role_id}`,
        work_item_id: item.id,
      },
    );
    return assignment;
  });
}
