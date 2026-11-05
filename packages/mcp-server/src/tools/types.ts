import type { ToolName } from "@cardigan/domain";
import type { z } from "zod";
import type { Identity } from "../auth.js";
import type { McpBackend } from "../backend.js";

/** What a tool handler may use. */
export interface ToolContext {
  readonly store: McpBackend;
  readonly identity: Identity;
  /** Write handlers recheck revocation after asynchronous preflight. */
  readonly revalidateToken?: () => void;
}

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly input: z.ZodObject<z.ZodRawShape>;
  readonly handler: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => unknown | Promise<unknown>;
}

/**
 * Define a tool with a zod input schema. The schema drives both parameter
 * validation and the JSON Schema advertised in `tools/list`.
 */
export function defineTool<S extends z.ZodRawShape>(definition: {
  readonly name: ToolName;
  readonly description: string;
  readonly input: z.ZodObject<S>;
  readonly handler: (
    args: z.infer<z.ZodObject<S>>,
    context: ToolContext,
  ) => unknown | Promise<unknown>;
}): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    input: definition.input,
    handler: (args, context) =>
      definition.handler(args as z.infer<z.ZodObject<S>>, context),
  };
}

/** Tools whose registration requires the caller's `allowed_tools` entry. */
export function allowedTools(
  tools: readonly ToolDefinition[],
  identity: Identity,
): readonly ToolDefinition[] {
  const allowed = identity.actor.allowed_tools;
  return tools.filter(
    (tool) =>
      allowed.includes(tool.name) &&
      (tool.name !== "issue_instruction" ||
        (identity.assignment.scope === "standing" &&
          identity.assignment.role_id === "pm" &&
          identity.assignment.standing_mode === "ops")),
  );
}
