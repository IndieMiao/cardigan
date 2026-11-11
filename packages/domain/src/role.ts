import {
  type Actor,
  type RoleReference,
  type ToolName,
  toolNames,
} from "./entities.js";
import { HOST_OPS_TOOLS } from "./host-ops.js";
import type { ProjectId } from "./ids.js";

export type RoleKind = "produce" | "verify" | "standing";

/** Versioned launch policy; runtime ownership remains on Assignment. */
export interface Role extends Omit<RoleReference, "role_version"> {
  readonly version: number;
  readonly display_name: string;
  /** `work` is accepted for legacy role files. New saves use an explicit kind. */
  readonly kind: RoleKind | "work";
  readonly core_prompt: string;
  readonly instructions?: string;
  readonly harness: "claude-code" | "codex" | "pi";
  readonly launch_profile_ref: string;
  readonly abilities: readonly string[];
  readonly worktree: "none" | "write" | "readonly";
  readonly required_machine_tags: readonly string[];
}

export function roleReference(role: Role): RoleReference {
  return {
    role_id: role.role_id,
    role_version: role.version,
    allowed_tools: role.allowed_tools,
    capabilities: role.capabilities,
    ...(role.status === undefined ? {} : { status: role.status }),
  };
}

/** The existing PM role's maximum scope, including work-item acceptance. */
export const STANDING_ROLE_TOOLS = [
  "whoami",
  "get_card",
  "get_updates",
  "ack_events",
  "post_comment",
  "issue_instruction",
  "report_blocker",
  "request_human_action",
  "request_decision",
  "upload_attachment",
  "heartbeat",
  "finish_run",
  "submit_delivery",
  "submit_review",
  "create_card",
  "update_card",
  "create_work_item",
  "update_work_item",
  "replace_verification_work_item",
  "assign",
  "release_assignment",
  "project_snapshot",
  "list_needs_you",
  "record_decision",
  "resolve_delegated_decision",
  "triage_human_action",
] as const satisfies readonly ToolName[];

export const ROLE_TOOL_ALLOWLISTS: Readonly<
  Record<RoleKind, readonly ToolName[]>
> = {
  produce: toolNames.filter(
    (tool) =>
      tool !== "submit_review" &&
      tool !== "replace_verification_work_item" &&
      !tool.startsWith("host_ops_"),
  ),
  verify: toolNames.filter(
    (tool) =>
      tool !== "submit_delivery" &&
      tool !== "replace_verification_work_item" &&
      !tool.startsWith("host_ops_"),
  ),
  standing: [...STANDING_ROLE_TOOLS, ...HOST_OPS_TOOLS],
};

export function roleKind(
  role: Pick<Role, "kind" | "allowed_tools" | "capabilities">,
): RoleKind {
  if (role.kind !== "work") return role.kind;
  return role.allowed_tools.includes("submit_review") ||
    role.capabilities.some((value) =>
      ["verify", "review", "test", "reviewer", "tester", "designer"].includes(
        value,
      ),
    )
    ? "verify"
    : "produce";
}

/** Separate policy boundary for Phase 3; callers cannot opt into PM access. */
export function canManageRoles(actor: Actor, project_id: ProjectId): boolean {
  return actor.kind === "human" && actor.project_id === project_id;
}

export function isRoleActive(
  roles: readonly RoleReference[],
  role_id: string,
): boolean {
  const latest = roles
    .filter((role) => role.role_id === role_id)
    .sort((a, b) => b.role_version - a.role_version)[0];
  return latest !== undefined && latest.status !== "inactive";
}
