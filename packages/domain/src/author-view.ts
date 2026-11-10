import type { CommandState } from "./commands/core.js";
import type { Employee } from "./employee.js";
import type { Author, Decision } from "./entities.js";
import { activeOwner, type MemberView } from "./member.js";

export type EmployeeView = Pick<Employee, "id" | "name" | "title" | "avatar">;
export interface AuthorView {
  readonly member: MemberView | null;
  readonly employee: EmployeeView | null;
  readonly author_role: string | null;
  readonly author_display: string;
}
type AuthorState = Pick<CommandState, "assignments" | "employees" | "members">;

/** Resolve trusted stored identity; never parse a body or accept a claimed name. */
export function authorView(state: AuthorState, author: Author): AuthorView {
  const owner = author === "human" ? activeOwner(state.members) : undefined;
  const member = owner
    ? {
        id: owner.id,
        name: owner.name,
        title: owner.title,
        avatar: owner.avatar,
      }
    : null;
  const assignment = author.startsWith("assignment:")
    ? state.assignments.find((a) => a.id === author.slice(11))
    : undefined;
  const found = assignment?.employee_id
    ? state.employees?.find((e) => e.id === assignment.employee_id)
    : undefined;
  const employee = found
    ? {
        id: found.id,
        name: found.name,
        title: found.title,
        avatar: found.avatar,
      }
    : null;
  return {
    employee,
    member,
    author_role: assignment?.role_id ?? null,
    author_display:
      member?.name ??
      employee?.name ??
      (author === "human"
        ? "所有者"
        : author === "system"
          ? "系统"
          : `未命名的 ${assignment?.role_id ?? "Agent"}`),
  };
}

/** Deliveries/reviews belong to the originating Run, not today's work-item owner. */
export function runAuthorView(
  state: AuthorState & Pick<CommandState, "runs">,
  run_id: string,
) {
  const assignment_id = state.runs.find((r) => r.id === run_id)?.assignment_id;
  const author: Author = assignment_id
    ? `assignment:${assignment_id}`
    : "system";
  return { author, ...authorView(state, author) };
}

/** Preserve stored decision identifiers while exposing the people behind them. */
export function decisionAuthorView(state: AuthorState, decision: Decision) {
  return {
    ...authorView(state, decision.raised_by ?? "system"),
    decider_view:
      decision.decider === "human" ? authorView(state, "human") : null,
    ...(decision.resolution
      ? {
          resolution: {
            ...decision.resolution,
            ...authorView(state, decision.resolution.resolved_by),
          },
        }
      : {}),
  };
}
