import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Identity } from "./auth.js";
import type { McpBackend } from "./backend.js";
import { captureBellReceipt } from "./commands/bell-receipt.js";
import { ToolError, toDomainError } from "./errors.js";
import type { Logger } from "./log.js";
import { resolveQualifiedToolArgs } from "./qualified-args.js";
import {
  allowedTools,
  type ToolContext,
  type ToolDefinition,
  visibleTools,
} from "./tools/types.js";

export interface ToolServerOptions {
  readonly projectSettings?: ToolContext["projectSettings"];
  readonly store: McpBackend;
  readonly identity: Identity;
  readonly tools: readonly ToolDefinition[];
  readonly log: Logger;
  readonly revalidateToken?: () => void;
  readonly auditProbeCall?: (actor: Identity["actor"], code: string) => void;
  /**
   * M2 plan §4 step 8: runs on `tools/call`, never on `initialize` or
   * `tools/list`. A client that connects but has not acted must not make the
   * Run look started. C-635: may return the number of write transactions it
   * attempted on the call's path, logged as `ack_writes`.
   */
  readonly onToolCall?: () => number | undefined;
  /**
   * C-600: runs on `tools/list`; a native harness lists tools at startup. A
   * failure answers the listing with a retryable error, never a list whose
   * handshake was not recorded.
   */
  readonly onToolList?: () => void | Promise<void>;
  /**
   * C-600: refuses every tool call of a session that has no native Card
   * tools, before it can acknowledge its Run or act on the project.
   */
  readonly refuseToolCall?: () =>
    | { readonly code: string; readonly message: string }
    | undefined;
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
 * C-786: bump when a change the fingerprint ignores (a tool or parameter
 * description, a title) must still reach live sessions at their next wake,
 * e.g. a safety rule written into a tool description. Every live session
 * whose catalog this revision covers is then replaced once.
 */
export const TOOL_CATALOG_REVISION = 1;

/** JSON Schema keywords that only annotate; changing them changes no call. */
const SCHEMA_ANNOTATIONS = new Set([
  "description",
  "title",
  "examples",
  "$comment",
]);
/** Keywords whose value maps names (e.g. parameter names) to schemas. */
const SCHEMA_NAME_MAPS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
]);
/** Keywords whose value is data, never a schema: kept verbatim. */
const SCHEMA_DATA = new Set(["enum", "const", "default", "required"]);

/**
 * C-786: a JSON Schema with its annotations removed. Names, types, required
 * lists, enums, bounds, defaults and every other validating keyword stay, so
 * two schemas are equal exactly when they accept the same calls. A parameter
 * that happens to be called `description` is a name, not an annotation.
 */
export function structuralSchema(schema: unknown): unknown {
  const walk = (node: unknown, names: boolean): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, false));
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (names) out[key] = walk(value, false);
      else if (SCHEMA_ANNOTATIONS.has(key)) continue;
      else if (SCHEMA_DATA.has(key)) out[key] = value;
      else out[key] = walk(value, SCHEMA_NAME_MAPS.has(key));
    }
    return out;
  };
  return walk(schema, false);
}

/**
 * P2a-10 A: a stable fingerprint of the `tools/list` an Assignment holding
 * `allowed` receives. Harnesses such as Claude Code list tools once per
 * session and this stateless endpoint cannot send `list_changed`, so a session
 * started under another deploy keeps the old list. The Dispatcher compares the
 * fingerprint recorded when the session started with this deploy's using
 * `toolCatalogCompatible`. Order-insensitive.
 *
 * C-786: only incompatible changes replace a session. Compatible (the session
 * keeps its list): a changed tool or parameter description or title, and a new
 * optional parameter at any depth; every call the old list allows is still
 * valid and means the same. Incompatible: a tool added or removed, a parameter
 * removed, a new required parameter, an optional parameter that became
 * required or the reverse, and any other change to a parameter's schema
 * (type, enum, bounds, pattern, default, strictness). `TOOL_CATALOG_REVISION`
 * forces a replacement when wording alone must apply at once.
 */
export function toolCatalogFingerprint(
  tools: readonly ToolDefinition[],
  allowed: readonly string[],
  assignment: Parameters<typeof visibleTools>[2],
): string {
  return catalogHash(listedTools(visibleTools(tools, allowed, assignment)));
}

const CATALOG_FORMAT = "c2";
const sha256 = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/**
 * C-786: the schema without its optional properties, at any depth. Each
 * removed property is recorded in `optional` as a short hash of its location
 * and its own schema without its optional properties (those are recorded the
 * same way), so a later catalog can show it kept every one unchanged.
 */
function splitOptional(
  node: unknown,
  at: readonly (string | number)[],
  optional: Set<string>,
): unknown {
  if (Array.isArray(node))
    return node.map((item, i) => splitOptional(item, [...at, i], optional));
  if (node === null || typeof node !== "object") return node;
  const schema = node as Record<string, unknown>;
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as unknown[]) : [],
  );
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_DATA.has(key)) out[key] = value;
    else if (
      key === "properties" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const kept: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) {
        const path = [...at, "properties", name];
        const core = splitOptional(child, path, optional);
        if (required.has(name)) kept[name] = core;
        else optional.add(sha256([path, core]).slice(0, 8));
      }
      out[key] = kept;
    } else out[key] = splitOptional(value, [...at, key], optional);
  }
  return out;
}

/**
 * The C-786 fingerprint of tools as `tools/list` serves them:
 * `c2.<core>.<optional,...>`. `core` hashes the revision, the tool names and
 * every schema without its optional properties; each optional property is one
 * 32-bit hash of its tool, location and schema (about 2 KB for the largest
 * role; a collision could only hide a removed optional parameter).
 */
export function catalogHash(
  listed: readonly { readonly name: string; readonly inputSchema: unknown }[],
  revision: number = TOOL_CATALOG_REVISION,
): string {
  const optional = new Set<string>();
  const core = [...listed]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, inputSchema }) => ({
      name,
      inputSchema: splitOptional(
        structuralSchema(inputSchema),
        [name],
        optional,
      ),
    }));
  return `${CATALOG_FORMAT}.${sha256({ revision, tools: core })}.${[...optional].sort().join(",")}`;
}

const CATALOG_PATTERN =
  /^c2\.([0-9a-f]{64})\.((?:[0-9a-f]{8}(?:,[0-9a-f]{8})*)?)$/u;

/**
 * C-786: whether a session that listed `recorded` can keep working with the
 * tools this deploy serves as `current`. Both may carry the host's `+`
 * launch suffixes (session environment revisions); those must match exactly.
 * A fingerprint in an older format compares only by equality.
 */
export function toolCatalogCompatible(
  recorded: string,
  current: string,
): boolean {
  if (recorded === current) return true;
  const [recordedCatalog, ...recordedSuffix] = recorded.split("+");
  const [currentCatalog, ...currentSuffix] = current.split("+");
  if (recordedSuffix.join("+") !== currentSuffix.join("+")) return false;
  const before = CATALOG_PATTERN.exec(recordedCatalog ?? "");
  const after = CATALOG_PATTERN.exec(currentCatalog ?? "");
  if (!before || !after || before[1] !== after[1]) return false;
  const kept = new Set(after[2] ? after[2].split(",") : []);
  return (before[2] ? before[2].split(",") : []).every((h) => kept.has(h));
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
    projectSettings: options.projectSettings,
    ...(options.revalidateToken
      ? { revalidateToken: options.revalidateToken }
      : {}),
  };

  const server = new Server(
    { name: "cardigan", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      await options.onToolList?.();
    } catch {
      log({
        event: "tool",
        method: "tools/list",
        assignment_id: identity.actor.assignment_id,
        code: "handshake_unrecorded",
      });
      throw new McpError(
        ErrorCode.InternalError,
        "Card MCP is busy; retry tools/list",
      );
    }
    return { tools: listedTools(visible) };
  });

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
    const refused = options.refuseToolCall?.();
    if (refused !== undefined) {
      log({
        event: "tool",
        method: "tools/call",
        tool: toolName,
        assignment_id: identity.actor.assignment_id,
        code: "mcp_session_unavailable",
        duration_ms: performance.now() - startedAt,
      });
      return errorResult(refused);
    }
    // Any tool call counts as the Agent having started (even a forbidden one):
    // this is the first moment the Assignment proves it is awake.
    let ackWrites: number | undefined;
    if (options.onToolCall !== undefined) {
      try {
        ackWrites = options.onToolCall();
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
      if (toolName === "run_probe")
        options.auditProbeCall?.(identity.actor, code);
      log({
        event: "tool",
        method: "tools/call",
        tool: toolName,
        assignment_id: identity.actor.assignment_id,
        code,
        duration_ms: performance.now() - startedAt,
        phases_ms: phases,
        ...(ackWrites === undefined ? {} : { ack_writes: ackWrites }),
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

    // C-675: full numbers of the token's project (`CDG-C-34`) work like short ones.
    const qualified = resolveQualifiedToolArgs(request.params.arguments ?? {}, {
      id: identity.actor.project_id,
      code: () => store.getProject?.(identity.actor.project_id)?.code,
    });
    if (!qualified.ok)
      return finish(qualified.error.code, errorResult(qualified.error));
    const parsed = definition.input.safeParse(qualified.value);
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
      const receive = captureBellReceipt(context, toolName, parsed.data);
      const value = await definition.handler(
        parsed.data as Record<string, unknown>,
        {
          ...context,
          recordTiming: (name, ms) => {
            phases[name] = ms;
          },
        },
      );
      receive?.();
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
