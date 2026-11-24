import {
  type Actor,
  type RoleReference,
  type RoleWorktree,
  type ToolName,
  toolNames,
} from "./entities.js";
import type { Harness } from "./harness.js";
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
  readonly harness: Harness;
  readonly launch_profile_ref: string;
  readonly abilities: readonly string[];
  readonly worktree: RoleWorktree;
  readonly required_machine_tags: readonly string[];
  /** C-613: this version is a default-pack role plus project rules. */
  readonly default_overlay?: RoleOverlay;
}

/** The project's own rules on top of a default-pack role. */
export type RoleOverlayRules = {
  /** Default-pack role the version is composed from; usually the role itself. */
  readonly base_role_id: string;
  /** Appended after the default instructions; empty means none. */
  readonly append_instructions: string;
  /**
   * `replace`: a role of its own (e.g. release_ops) keeps `append_instructions`
   * as its whole text and follows the base only for tools and policy fields.
   */
  readonly instructions_mode?: "append" | "replace";
  readonly extra_tools: readonly ToolName[];
  /** Explicit removals win over the default pack, including tools it adds later. */
  readonly removed_tools: readonly ToolName[];
};
/**
 * Hashes are computed by the host with its deployment policy hash. A version
 * whose policy no longer matches `composed_hash` was edited outside the
 * overlay and is never recomposed silently.
 */
export type RoleOverlay = RoleOverlayRules & {
  readonly base_hash: string;
  readonly composed_hash: string;
};

export function roleReference(role: Role): RoleReference {
  return {
    role_id: role.role_id,
    role_version: role.version,
    launch_profile_ref: role.launch_profile_ref,
    worktree: role.worktree,
    allowed_tools: role.allowed_tools,
    capabilities: role.capabilities,
    required_machine_tags: role.required_machine_tags,
    ...(role.required_capabilities === undefined
      ? {}
      : { required_capabilities: role.required_capabilities }),
    ...(role.status === undefined ? {} : { status: role.status }),
  };
}

/** The existing PM role's maximum scope, including work-item acceptance. */
export const STANDING_ROLE_TOOLS = [
  "whoami",
  "get_card",
  "get_check_log",
  "get_updates",
  "ack_events",
  "post_comment",
  "issue_instruction",
  "report_blocker",
  "request_human_action",
  "request_decision",
  "upload_attachment",
  "read_attachment",
  "heartbeat",
  "finish_run",
  "submit_delivery",
  "submit_review",
  "withdraw_review",
  "create_card",
  "update_card",
  "send_owner_message",
  "set_merge_solo",
  "set_merge_window",
  "reserve_machine_resource",
  "create_work_item",
  "update_work_item",
  "replace_verification_work_item",
  "request_delivery_rework",
  "assign",
  "release_assignment",
  "project_snapshot",
  "list_needs_you",
  "list_templates",
  "list_roles",
  "record_decision",
  "resolve_delegated_decision",
  "triage_human_action",
  "complete_host_action",
  "publish_artifact",
  "write_release_note",
  "list_release_notes",
] as const satisfies readonly ToolName[];

/** Standing PM tools; rework additionally requires Ops at issuance and execution. */
export const STANDING_ONLY_TOOLS = [
  "send_owner_message",
  "set_merge_solo",
  "set_merge_window",
  "reserve_machine_resource",
  "complete_host_action",
  "request_delivery_rework",
  "list_templates",
  "list_roles",
  // C-712: release notes are written by the standing PM (or the human).
  "write_release_note",
  "list_release_notes",
] as const satisfies readonly ToolName[];
/**
 * Who may hold a standing-only tool: the project's standing PM (Office or
 * Ops). Work-item PMs reuse the `pm` role and host_ops is also standing, so
 * token issuance, authentication and tools/list all apply this check too.
 */
export function holdsStandingOnlyTools(assignment: {
  readonly scope: string;
  readonly role_id: string;
}): boolean {
  return assignment.scope === "standing" && assignment.role_id === "pm";
}
export function isStandingOnlyTool(tool: string): boolean {
  return (STANDING_ONLY_TOOLS as readonly string[]).includes(tool);
}
const workItemTool = (tool: ToolName): boolean =>
  !tool.startsWith("host_ops_") &&
  !(STANDING_ONLY_TOOLS as readonly ToolName[]).includes(tool);

export const ROLE_TOOL_ALLOWLISTS: Readonly<
  Record<RoleKind, readonly ToolName[]>
> = {
  produce: toolNames.filter(
    (tool) =>
      tool !== "submit_review" &&
      tool !== "replace_verification_work_item" &&
      tool !== "request_delivery_rework" &&
      tool !== "withdraw_review" &&
      workItemTool(tool),
  ),
  verify: toolNames.filter(
    (tool) =>
      tool !== "submit_delivery" &&
      tool !== "request_recheck" &&
      tool !== "request_check" &&
      tool !== "run_probe" &&
      tool !== "request_mobile_signature" &&
      tool !== "publish_artifact" &&
      tool !== "replace_verification_work_item" &&
      tool !== "request_delivery_rework" &&
      workItemTool(tool),
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
