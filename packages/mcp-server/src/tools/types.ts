import {
  holdsStandingOnlyTools,
  isStandingOnlyTool,
  type ToolName,
} from "@cardigan/domain";
import type { z } from "zod";
import type { Identity } from "../auth.js";
import type { McpBackend } from "../backend.js";

/** What a tool handler may use. */
export interface ToolContext {
  readonly store: McpBackend;
  readonly identity: Identity;
  /** Write handlers recheck revocation after asynchronous preflight. */
  readonly revalidateToken?: () => void;
  /** Fixed stage names and durations only; no request or diagnostic payloads. */
  readonly recordTiming?: (stage: string, durationMs: number) => void;
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
  return visibleTools(tools, identity.actor.allowed_tools, identity.assignment);
}

/**
 * The tools an Assignment holding `allowed` sees in `tools/list`. Split out of
 * `allowedTools` so the tool catalog fingerprint (P2a-10 A) applies the exact
 * rule the endpoint applies.
 */
export function visibleTools(
  tools: readonly ToolDefinition[],
  allowed: readonly string[],
  assignment: {
    readonly scope: string;
    readonly role_id: string;
    readonly standing_mode?: string | undefined;
  },
): readonly ToolDefinition[] {
  return tools.filter(
    (tool) =>
      allowed.includes(tool.name) &&
      (!tool.name.startsWith("host_ops_") ||
        (assignment.role_id === "host_ops" &&
          assignment.scope === "standing")) &&
      (![
        "issue_instruction",
        "release_assignment",
        "replace_verification_work_item",
      ].includes(tool.name) ||
        (assignment.scope === "standing" &&
          assignment.role_id === "pm" &&
          assignment.standing_mode === "ops")) &&
      (!isStandingOnlyTool(tool.name) || holdsStandingOnlyTools(assignment)),
  );
}
