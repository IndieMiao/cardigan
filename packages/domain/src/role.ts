import type { RoleReference } from "./entities.js";

/** Versioned launch policy; runtime ownership remains on Assignment. */
export interface Role extends Omit<RoleReference, "role_version"> {
  readonly version: number;
  readonly display_name: string;
  readonly kind: "standing" | "work";
  readonly core_prompt: string;
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
  };
}
