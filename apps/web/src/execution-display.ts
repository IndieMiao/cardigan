import type { ExecutionAssignment } from "./api.js";
import { groupRows } from "./group-rows.js";

export interface ExecutionDisplay {
  readonly mode: "table" | "cards";
  readonly grouped: boolean;
}
export const executionDisplayKey = (projectId: string) =>
  `cardigan.execution.display.${projectId}`;
const defaults: ExecutionDisplay = { mode: "table", grouped: false };

/** Same browser-user and project scope as the existing execution sort. */
export function readExecutionDisplay(projectId: string): ExecutionDisplay {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(executionDisplayKey(projectId)) ?? "null",
    );
    return {
      mode: value?.mode === "cards" ? "cards" : "table",
      grouped: value?.grouped === true,
    };
  } catch {
    return defaults;
  }
}
export function writeExecutionDisplay(
  projectId: string,
  value: ExecutionDisplay,
): void {
  try {
    window.localStorage.setItem(
      executionDisplayKey(projectId),
      JSON.stringify(value),
    );
  } catch {
    // Optional preferences must not prevent interaction.
  }
}

export interface ExecutionGroup {
  readonly id: string;
  readonly employee: ExecutionAssignment["employee"];
  readonly rows: ExecutionAssignment[];
}
export function groupExecution(
  rows: readonly ExecutionAssignment[],
): ExecutionGroup[] {
  return groupRows(rows, (row) => row.employee?.id ?? "unassigned").map(
    (group) => ({ ...group, employee: group.rows[0]?.employee }),
  );
}
