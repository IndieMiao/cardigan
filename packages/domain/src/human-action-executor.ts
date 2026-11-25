import type {
  Assignment,
  HumanAction,
  HumanActionExecutor,
  RoleReference,
} from "./entities.js";
import { isRoleActive } from "./role.js";

/**
 * C-742: the host operator's display name. Human actions addressed to the
 * operator start their title with `张良：`, and the Workbench lists them as
 * “交给张良”.
 */
export const HUMAN_ACTION_OPERATOR_NAME = "张良";

/**
 * C-742: default keywords that mark a `why_human` as work only the host
 * operator can do (host shell, credential files, OSS upload, signing
 * approval, cloud assistant). An explicit `executor` always wins.
 */
export const OPERATOR_ONLY_KEYWORDS: readonly string[] = [
  HUMAN_ACTION_OPERATOR_NAME,
  "主机",
  "凭据文件",
  "OSS",
  "送签",
  "云助手",
];

const OPERATOR_TITLE = new RegExp(
  `^\\s*${HUMAN_ACTION_OPERATOR_NAME}\\s*[：:]`,
  "u",
);

/** The first line of the instructions doubles as the request title. */
function requestTitle(instructions: string) {
  return instructions.split(/\r?\n/u).find((line) => line.trim()) ?? "";
}

/** Latin keywords (OSS) must stand alone: “loss” or “across” are not OSS. */
function mentions(text: string, keyword: string) {
  if (!/^[A-Za-z]+$/u.test(keyword)) return text.includes(keyword);
  return new RegExp(`(?<![A-Za-z])${keyword}(?![A-Za-z])`, "iu").test(text);
}

/** Rule 1 of C-742: the title prefix or an operator-only reason. */
export function inferHumanActionExecutor(p: {
  readonly instructions: string;
  readonly why_human: string;
  readonly title?: string;
}): HumanActionExecutor {
  if (
    [p.title ?? "", requestTitle(p.instructions)].some((t) =>
      OPERATOR_TITLE.test(t),
    )
  )
    return "operator";
  return OPERATOR_ONLY_KEYWORDS.some((k) => mentions(p.why_human, k))
    ? "operator"
    : "owner";
}

export function humanActionExecutor(
  action: Pick<HumanAction, "executor">,
): HumanActionExecutor {
  return action.executor ?? "owner";
}

export function isOperatorAction(action: Pick<HumanAction, "executor">) {
  return humanActionExecutor(action) === "operator";
}

/**
 * The operator's Token identity is the project's active external standing PM
 * Office that may complete host actions (C-212). Rotation does not inherit a
 * specific action; any such identity is the operator.
 */
export function isOperatorIdentity(
  state: { readonly roles: readonly RoleReference[] },
  assignment: Assignment | undefined,
) {
  return !!(
    assignment &&
    assignment.status === "active" &&
    assignment.scope === "standing" &&
    assignment.role_id === "pm" &&
    assignment.standing_mode === "office" &&
    assignment.external === true &&
    isRoleActive(state.roles, assignment.role_id) &&
    state.roles.some(
      (r) =>
        r.role_id === assignment.role_id &&
        r.role_version === assignment.role_version &&
        r.allowed_tools.includes("complete_host_action"),
    )
  );
}
