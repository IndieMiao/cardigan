import { createHash, type Hash } from "node:crypto";
import type { RoleDefinition } from "@cardigan/domain";

type PolicyFields = Pick<
  RoleDefinition,
  | "instructions"
  | "core_prompt"
  | "allowed_tools"
  | "capabilities"
  | "kind"
  | "worktree"
  | "required_capabilities"
>;

/**
 * The JSON after the instructions, exactly as `deploymentRolePolicyHash`
 * serialises it, so a fixed text prefix can be hashed once and reused.
 */
function policyTail(
  role: Omit<PolicyFields, "instructions" | "core_prompt">,
  withRequirements: boolean,
): string {
  const tail = {
    allowed_tools: [...role.allowed_tools].sort(),
    capabilities: [...role.capabilities].sort(),
    kind: role.kind,
    worktree: role.worktree,
    // Keep historical hashes for roles with no machine capability constraints.
    ...(withRequirements && role.required_capabilities?.length
      ? { required_capabilities: [...role.required_capabilities].sort() }
      : {}),
  };
  return JSON.stringify(tail).slice(1);
}
const policyHead = (instructions: string) =>
  `{"instructions":${JSON.stringify(instructions)},`;

/** Only fields replaced by --from-default participate; project launch settings stay local. */
export function deploymentRolePolicyHash(role: PolicyFields): string {
  return createHash("sha256")
    .update(policyHead(role.instructions ?? role.core_prompt ?? ""))
    .update(policyTail(role, true))
    .digest("hex");
}

/**
 * The fingerprint an older deployment supervisor computes: it omits machine
 * requirements (see C-603). Only usable where the requirements are known to
 * equal the default's.
 */
export function weakRolePolicyHash(role: PolicyFields): string {
  return createHash("sha256")
    .update(policyHead(role.instructions ?? role.core_prompt ?? ""))
    .update(policyTail(role, false))
    .digest("hex");
}

/** Hash many tool variants of one instruction text without rehashing it. */
export function policyHasher(instructions: string) {
  const head: Hash = createHash("sha256").update(policyHead(instructions));
  return (
    role: Omit<PolicyFields, "instructions" | "core_prompt">,
    withRequirements: boolean,
  ) => head.copy().update(policyTail(role, withRequirements)).digest("hex");
}
