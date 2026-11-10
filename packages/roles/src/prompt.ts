import {
  AGENT_PROTOCOL,
  roleInstructionsError,
  SHARED_BOUNDARIES,
} from "@cardigan/domain";

export { AGENT_PROTOCOL, SHARED_BOUNDARIES } from "@cardigan/domain";

/** The system owns these sections; new roles store only their instructions. */
export function composeRolePrompt(instructions: string): string {
  const error = roleInstructionsError(instructions);
  if (error !== undefined) throw new Error(error);
  return [
    instructions,
    "",
    "## 协作规则",
    "",
    ...SHARED_BOUNDARIES.map((line) => `- ${line}`),
    "",
    "## 协议（每个 Run 都要遵守）",
    "",
    ...AGENT_PROTOCOL.map((line) => `- ${line}`),
    "",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export interface ConvertedRoleInstructions {
  readonly instructions: string;
  readonly warnings: readonly string[];
}

/** Explicit conversion only: old prompts are never rewritten during reads or launches. */
export function convertLegacyRole(role: {
  readonly core_prompt: string;
  readonly instructions?: string;
}): ConvertedRoleInstructions {
  if (role.instructions !== undefined)
    return { instructions: role.instructions, warnings: [] };
  // Recognize the pack's structure, including older versions of its bullet text.
  const match =
    /\n## 协作规则\n\n(?:- [^\n]+\n)+\n## 协议（每个 Run 都要遵守）\n\n(?:- [^\n]+(?:\n|$))+\s*$/u.exec(
      role.core_prompt,
    );
  if (match !== null)
    return {
      instructions: role.core_prompt.slice(0, match.index).trimEnd(),
      warnings: [],
    };
  return {
    instructions: role.core_prompt,
    warnings: [
      "无法按默认角色包结构拆出角色说明；已保留整段 core_prompt，可能与系统协作规则和协议重复。",
    ],
  };
}
