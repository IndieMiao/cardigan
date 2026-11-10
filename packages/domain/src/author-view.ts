import type { CommandState } from "./commands/core.js";
import type { Employee } from "./employee.js";
import type { Author } from "./entities.js";

export type EmployeeView = Pick<Employee, "id" | "name" | "title" | "avatar">;
export interface AuthorView {
  readonly employee: EmployeeView | null;
  readonly author_role: string | null;
  readonly author_display: string;
}
type AuthorState = Pick<CommandState, "assignments" | "employees">;

/** Resolve trusted stored identity; never parse a body or accept a claimed name. */
export function authorView(state: AuthorState, author: Author): AuthorView {
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
    author_role: assignment?.role_id ?? null,
    author_display:
      employee?.name ??
      (author === "human"
        ? "你"
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
