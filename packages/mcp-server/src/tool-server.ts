import type { Store } from "@cardigan/store";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Identity } from "./auth.js";
import { ToolError, toDomainError } from "./errors.js";
import type { Logger } from "./log.js";
import {
  allowedTools,
  type ToolContext,
  type ToolDefinition,
} from "./tools/types.js";

export interface ToolServerOptions {
  readonly store: Store;
  readonly identity: Identity;
  readonly tools: readonly ToolDefinition[];
  readonly log: Logger;
}

/**
 * One MCP server instance per HTTP request (stateless Streamable HTTP). The
 * instance is bound to a single identity, so it can only ever see and call that
 * identity's tools.
 */
export function createMcpServer(options: ToolServerOptions): Server {
  const { store, identity, tools, log } = options;
  const visible = allowedTools(tools, identity);
  const context: ToolContext = { store, identity };

  const server = new Server(
    { name: "cardigan", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visible.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toJsonSchemaCompat(tool.input),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const startedAt = Date.now();
    const definition = tools.find((tool) => tool.name === toolName);

    const finish = (code: string, result: CallToolResult): CallToolResult => {
      log({
        event: "tool",
        method: "tools/call",
        tool: toolName,
        assignment_id: identity.actor.assignment_id,
        code,
        duration_ms: Date.now() - startedAt,
      });
      return result;
    };

    if (definition === undefined) {
      return finish(
        "not_found",
        errorResult({
          code: "not_found",
          message: `unknown tool ${toolName}`,
        }),
      );
    }

    // Hidden and forbidden are the same thing: a tool outside the token's
    // allowed_tools never runs, even if the caller guesses its name.
    if (!visible.some((tool) => tool.name === toolName)) {
      const error = ToolError.forbiddenTool(toolName).toDomainError();
      return finish(error.code, errorResult(error));
    }

    const parsed = definition.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const error = {
        code: "validation_failed" as const,
        message: `invalid arguments for ${toolName}`,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      };
      return finish(error.code, errorResult(error));
    }

    try {
      const value = await definition.handler(
        parsed.data as Record<string, unknown>,
        context,
      );
      return finish("ok", {
        structuredContent: asStructured(value),
        content: [{ type: "text", text: JSON.stringify(value) }],
      });
    } catch (error) {
      const domainError = toDomainError(error);
      return finish(domainError.code, errorResult(domainError));
    }
  });

  return server;
}

function errorResult(error: {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}): CallToolResult {
  const payload =
    error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  return {
    isError: true,
    structuredContent: { error: payload },
    content: [{ type: "text", text: JSON.stringify({ error: payload }) }],
  };
}

function asStructured(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}
