import type { Assignment, StandingMode, ToolName } from "./entities.js";
import type { Result } from "./errors.js";
import { validationFailed } from "./errors.js";

/**
 * M4.5: the standing PM mode is data, not a guess (development plan §7.1, §10.4).
 *
 * PM Office and PM Ops share the `pm` role, so the only durable difference is
 * which context the standing Assignment runs in. M3 inferred it on every start
 * from the newest token's tool list; one path that issued a token without
 * carrying the previous scope silently promoted Ops. The mode is now a field
 * written once by `cardigan pm create --office|--ops` and never changed.
 */
export type { StandingMode };
/** The token that records human decisions; only PM Office may hold it. */
export const OFFICE_ONLY_TOOL: ToolName = "record_decision";

/** The tool scope a standing PM gets in this mode (§10.4). */
export function standingTools(
  roleTools: readonly ToolName[],
  mode: StandingMode,
): readonly ToolName[] {
  return roleTools.filter((tool) =>
    mode === "office"
      ? ![
          "issue_instruction",
          "withdraw_review",
          "release_assignment",
          "resolve_delegated_decision",
          "triage_human_action",
          "replace_verification_work_item",
        ].includes(tool)
      : tool !== OFFICE_ONLY_TOOL,
  );
}

/**
 * Infer the mode from a token scope. Only used for data written before M4.5;
 * after the backfill every read goes through `assignment.standing_mode`.
 */
export function standingModeFromTools(tools: readonly string[]): StandingMode {
  return tools.includes(OFFICE_ONLY_TOOL) ? "office" : "ops";
}

/**
 * Stamp the mode on a standing Assignment. Idempotent for the same mode;
 * changing an existing mode is rejected because the mode decides the token
 * scope and promotion must be an explicit, separate decision.
 */
export function applyStandingMode(
  assignment: Assignment,
  mode: StandingMode,
): Result<Assignment> {
  if (assignment.scope !== "standing")
    return validationFailed("Only a standing Assignment has a standing_mode");
  if (assignment.role_id !== "pm")
    return validationFailed("Only the pm role has a standing_mode");
  if (mode !== "office" && mode !== "ops")
    return validationFailed("standing_mode must be office or ops");
  if (assignment.standing_mode !== undefined)
    return assignment.standing_mode === mode
      ? { ok: true, value: assignment }
      : validationFailed("A standing Assignment cannot change its mode");
  return { ok: true, value: { ...assignment, standing_mode: mode } };
}

/** The mode of a standing Assignment; `undefined` for work items and legacy rows. */
export function standingModeOf(
  assignment: Assignment,
): StandingMode | undefined {
  return assignment.scope === "standing" ? assignment.standing_mode : undefined;
}

/** External identities pull their inbox and never own a managed terminal. */
export const EXTERNAL_ASSIGNMENT_START_ERROR =
  "这是外接 Assignment，没有可以启动的终端，用 `cardigan inbox` 查看待处理通知";

export function assignmentExternalError(
  assignment: Assignment,
  previous?: Assignment,
): string | undefined {
  if (
    assignment.external !== undefined &&
    typeof assignment.external !== "boolean"
  )
    return "external 必须是布尔值";
  if (
    assignment.external &&
    (assignment.scope !== "standing" || assignment.standing_mode !== "office")
  )
    return "外接 Assignment 仅支持 standing Office";
  if (previous && previous.external !== assignment.external)
    return "Assignment 的 external 创建后不能修改";
  return undefined;
}
