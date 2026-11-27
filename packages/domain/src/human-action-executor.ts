import type {
  Assignment,
  Decision,
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

/** Audit trail: why an action got its executor. */
export type HumanActionExecutorBasis =
  | "explicit"
  | "title"
  | `keyword:${string}`
  | "default";

/** Rule 1 of C-742 with its basis: the title prefix or an operator-only reason. */
export function classifyHumanActionExecutor(p: {
  readonly instructions: string;
  readonly why_human: string;
  readonly title?: string;
}): { executor: HumanActionExecutor; basis: HumanActionExecutorBasis } {
  if (
    [p.title ?? "", requestTitle(p.instructions)].some((t) =>
      OPERATOR_TITLE.test(t),
    )
  )
    return { executor: "operator", basis: "title" };
  const keyword = OPERATOR_ONLY_KEYWORDS.find((k) => mentions(p.why_human, k));
  return keyword
    ? { executor: "operator", basis: `keyword:${keyword}` }
    : { executor: "owner", basis: "default" };
}

export function inferHumanActionExecutor(
  p: Parameters<typeof classifyHumanActionExecutor>[0],
): HumanActionExecutor {
  return classifyHumanActionExecutor(p).executor;
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
 * C-822: who has to act on a human action or decision right now. Needs You
 * counts, the sidebar badge, the card's next step and its timeline all read
 * this one answer: `owner` is the project owner, `operator` is 张良, `pm` is
 * PM triage (or a PM-decided question), `host` is host operations, `system`
 * a system decision and `done` a settled item.
 */
export type PendingHandler =
  | "owner"
  | "operator"
  | "pm"
  | "host"
  | "system"
  | "done";

/** PM triage comes first: its executor applies once it reaches someone. */
export function humanActionHandler(
  action: Pick<HumanAction, "status" | "triage" | "executor">,
): PendingHandler {
  if (action.status !== "open") return "done";
  if (action.triage === "pm_ops") return "pm";
  if (isOperatorAction(action)) return "operator";
  return action.triage === "host" ? "host" : "owner";
}

export function decisionHandler(
  decision: Pick<Decision, "status" | "decider">,
): PendingHandler {
  if (!["open", "provisional", "snoozed"].includes(decision.status))
    return "done";
  return decision.decider === "human"
    ? "owner"
    : decision.decider === "system"
      ? "system"
      : "pm";
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
