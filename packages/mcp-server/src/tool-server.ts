import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Identity } from "./auth.js";
import type { McpBackend } from "./backend.js";
import { ToolError, toDomainError } from "./errors.js";
import type { Logger } from "./log.js";
import {
  allowedTools,
  type ToolContext,
  type ToolDefinition,
  visibleTools,
} from "./tools/types.js";

export interface ToolServerOptions {
  readonly store: McpBackend;
  readonly identity: Identity;
  readonly tools: readonly ToolDefinition[];
  readonly log: Logger;
  readonly revalidateToken?: () => void;
  /**
   * M2 plan §4 step 8: runs on `tools/call`, never on `initialize` or
   * `tools/list`. A client that connects but has not acted must not make the
   * Run look started.
   */
  readonly onToolCall?: () => void;
}

/** The `tools/list` entries for an already filtered tool set. */
function listedTools(visible: readonly ToolDefinition[]) {
  return visible.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchemaCompat(tool.input),
  }));
}

/**
 * P2a-10 A: a stable hash of exactly what `tools/list` returns to an
 * Assignment holding `allowed`. Harnesses such as Claude Code list tools once
 * per session and this stateless endpoint cannot send `list_changed`, so a
 * session started under another deploy keeps the old list. Comparing this
 * fingerprint with the one recorded when the session started tells the
 * Dispatcher whether that list actually changed. Order-insensitive.
 */
export function toolCatalogFingerprint(
  tools: readonly ToolDefinition[],
  allowed: readonly string[],
  assignment: Parameters<typeof visibleTools>[2],
): string {
  const listed = listedTools(visibleTools(tools, allowed, assignment)).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return createHash("sha256").update(canonicalJson(listed)).digest("hex");
}

/** JSON with object keys sorted, so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/**
 * One MCP server instance per HTTP request (stateless Streamable HTTP). The
 * instance is bound to a single identity, so it can only ever see and call that
 * identity's tools.
 */
export function createMcpServer(options: ToolServerOptions): Server {
  const { store, identity, tools, log } = options;
  const visible = allowedTools(tools, identity);
  const context: ToolContext = {
    store,
    identity,
    ...(options.revalidateToken
      ? { revalidateToken: options.revalidateToken }
      : {}),
  };

  const server = new Server(
    { name: "cardigan", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listedTools(visible),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const startedAt = performance.now();
    const phases: Record<string, number> = {};
    let stageAt = startedAt;
    const stage = (name: string) => {
      const now = performance.now();
      phases[name] = now - stageAt;
      stageAt = now;
    };
    // Any tool call counts as the Agent having started (even a forbidden one):
    // this is the first moment the Assignment proves it is awake.
    if (options.onToolCall !== undefined) {
      try {
        options.onToolCall();
      } catch (error) {
        log({
          event: "tool",
          method: "tools/call",
          tool: toolName,
          assignment_id: identity.actor.assignment_id,
          code:
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code: unknown }).code)
              : "acknowledge_failed",
        });
      }
    }
    stage("acknowledge");
    const definition = tools.find((tool) => tool.name === toolName);

    const finish = (code: string, result: CallToolResult): CallToolResult => {
      log({
        event: "tool",
        method: "tools/call",
        tool: toolName,
        assignment_id: identity.actor.assignment_id,
        code,
        duration_ms: performance.now() - startedAt,
        phases_ms: phases,
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

    stage("validate");
    try {
      const value = await definition.handler(
        parsed.data as Record<string, unknown>,
        {
          ...context,
          recordTiming: (name, ms) => {
            phases[name] = ms;
          },
        },
      );
      stage("handler");
      const result = {
        structuredContent: asStructured(value),
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
      };
      stage("serialize");
      return finish("ok", result);
    } catch (error) {
      if (!Object.hasOwn(phases, "handler")) stage("handler");
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
