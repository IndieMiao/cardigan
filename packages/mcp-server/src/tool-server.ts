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
 * P2a-10 A: a stable hash of the `tools/list` an Assignment holding `allowed`
 * receives. Harnesses such as Claude Code list tools once per session and this
 * stateless endpoint cannot send `list_changed`, so a session started under
 * another deploy keeps the old list. The Dispatcher replaces a live session
 * whose recorded fingerprint differs from this deploy's. Order-insensitive.
 *
 * C-786: only incompatible changes change it, and every structural change is
 * incompatible: a tool added or removed (including through `allowed_tools`),
 * and any change to a tool's input schema other than its annotations
 * (parameters added or removed, required or optional, types, enums, bounds,
 * patterns, defaults, strictness). Tool and parameter descriptions and titles
 * are left out, so wording alone never replaces a session;
 * `TOOL_CATALOG_REVISION` forces a replacement when wording must apply at once.
 */
export function toolCatalogFingerprint(
  tools: readonly ToolDefinition[],
  allowed: readonly string[],
  assignment: Parameters<typeof visibleTools>[2],
): string {
  return catalogHash(listedTools(visibleTools(tools, allowed, assignment)));
}

/**
 * C-797: the fingerprint together with the structure it hashes (canonical
 * JSON), so the host can keep the structure and later tell a compatible
 * change (only new optional parameters) from an incompatible one.
 */
export function toolCatalogSnapshot(
  tools: readonly ToolDefinition[],
  allowed: readonly string[],
  assignment: Parameters<typeof visibleTools>[2],
): ToolCatalogSnapshot {
  return catalogSnapshot(listedTools(visibleTools(tools, allowed, assignment)));
}

export interface ToolCatalogSnapshot {
  /** The C-786 fingerprint: sha256 of `structure`. */
  readonly fingerprint: string;
  /** Canonical JSON of `{ revision, tools: [{ name, inputSchema }] }`. */
  readonly structure: string;
}

/** The C-786 fingerprint of tools as `tools/list` serves them. */
export function catalogHash(
  listed: readonly { readonly name: string; readonly inputSchema: unknown }[],
  revision: number = TOOL_CATALOG_REVISION,
): string {
  return catalogSnapshot(listed, revision).fingerprint;
}

/** `catalogHash` with the structure it hashes. */
export function catalogSnapshot(
  listed: readonly { readonly name: string; readonly inputSchema: unknown }[],
  revision: number = TOOL_CATALOG_REVISION,
): ToolCatalogSnapshot {
  const tools = listed
    .map(({ name, inputSchema }) => ({
      name,
      inputSchema: structuralSchema(inputSchema),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const structure = canonicalJson({ revision, tools });
  return {
    fingerprint: createHash("sha256").update(structure).digest("hex"),
    structure,
  };
}

/**
 * C-797: optional parameters that carry a safety or permission meaning (for
 * example a new guard switch). A live session whose catalog lacks one is
 * replaced at its next wake instead of continuing without it, the same rule
 * as C-786's `ROLE_SECURITY_REVISIONS`: add the entry in the same change that
 * adds the parameter. Keyed by tool name; nested parameters use dotted paths
 * (`filter.limit`), fields of array items `[]` (`issues[].basis`). Marking a
 * parameter also covers its nested fields, and marking a nested field also
 * covers a newly added parent.
 */
export const IMMEDIATE_TOOL_PARAMETERS: Readonly<
  Record<string, readonly string[]>
> = {};

export type ToolCatalogChange =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly reason: string };

/**
 * C-797: whether a session that listed `previous` may keep running under a
 * deploy that serves `current` (both `ToolCatalogSnapshot.structure`). The
 * only compatible difference is a tool gaining optional parameters (also
 * inside object parameters and array items) that are not marked immediate. Everything
 * else is incompatible: a tool added or removed (including through
 * `allowed_tools`), a parameter removed or renamed, optional made required or
 * the reverse, a changed type, enum, bound, pattern, default or strictness,
 * another catalog revision, and any structure that cannot be read.
 *
 * Compatibility only spares the session a restart; the endpoint still
 * validates every call against the current tools and the caller's token.
 */
export function compareToolCatalogs(
  previous: string,
  current: string,
  immediate: Readonly<
    Record<string, readonly string[]>
  > = IMMEDIATE_TOOL_PARAMETERS,
): ToolCatalogChange {
  const before = parseStructure(previous);
  const after = parseStructure(current);
  if (!before || !after) return incompatible("unreadable");
  if (before.revision !== after.revision) return incompatible("revision");
  const names = new Set(after.tools.map((t) => t.name));
  if (before.tools.length !== after.tools.length)
    return incompatible("tool_set");
  for (const tool of before.tools) {
    if (!names.has(tool.name)) return incompatible("tool_set");
    const next = after.tools.find((t) => t.name === tool.name);
    const reason = extendsSchema(
      tool.inputSchema,
      next?.inputSchema,
      "",
      immediate[tool.name] ?? [],
    );
    if (reason) return incompatible(`${tool.name}:${reason}`);
  }
  return { compatible: true };
}

function incompatible(reason: string): ToolCatalogChange {
  return { compatible: false, reason };
}

interface CatalogStructure {
  readonly revision: unknown;
  readonly tools: readonly { readonly name: string; inputSchema: unknown }[];
}

function parseStructure(text: string): CatalogStructure | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.tools)) return undefined;
  const tools: { name: string; inputSchema: unknown }[] = [];
  const seen = new Set<string>();
  for (const tool of value.tools) {
    if (!isRecord(tool) || typeof tool.name !== "string") return undefined;
    if (seen.has(tool.name)) return undefined;
    seen.add(tool.name);
    tools.push({ name: tool.name, inputSchema: tool.inputSchema });
  }
  return { revision: value.revision, tools };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Undefined when `after` accepts every call `before` accepts with the same
 * meaning and differs only by new optional properties; otherwise the first
 * difference found. Only object `properties` and a single-schema array
 * `items` are entered (path `list[].field`); combinators such as `oneOf` are
 * compared whole, since widening one branch can change which branch matches.
 */
function extendsSchema(
  before: unknown,
  after: unknown,
  path: string,
  immediate: readonly string[],
): string | undefined {
  if (canonicalJson(before) === canonicalJson(after)) return undefined;
  const at = path || "<root>";
  if (!isRecord(before) || !isRecord(after)) return `changed ${at}`;
  const objects = isRecord(before.properties) && isRecord(after.properties);
  const arrays = isRecord(before.items) && isRecord(after.items);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (objects && (key === "properties" || key === "required")) continue;
    if (arrays && key === "items") continue;
    if (canonicalJson(before[key]) !== canonicalJson(after[key]))
      return `changed ${at}`;
  }
  if (arrays) {
    const reason = extendsSchema(
      before.items,
      after.items,
      `${path}[]`,
      immediate,
    );
    if (reason) return reason;
  }
  if (!objects) return undefined;
  const properties = before.properties as Record<string, unknown>;
  const nextProperties = after.properties as Record<string, unknown>;
  const required = requiredNames(before.required);
  const nextRequired = requiredNames(after.required);
  if (
    !required ||
    !nextRequired ||
    required.size !== nextRequired.size ||
    [...required].some((name) => !nextRequired.has(name))
  )
    return `required ${at}`;
  const child = (name: string) => (path ? `${path}.${name}` : name);
  for (const [name, schema] of Object.entries(properties)) {
    if (!Object.hasOwn(nextProperties, name)) return `removed ${child(name)}`;
    const reason = extendsSchema(
      schema,
      nextProperties[name],
      child(name),
      immediate,
    );
    if (reason) return reason;
  }
  for (const name of Object.keys(nextProperties)) {
    if (Object.hasOwn(properties, name)) continue;
    const added = child(name);
    if (nextRequired.has(name)) return `added required ${added}`;
    if (
      immediate.some((marked) => within(marked, added) || within(added, marked))
    )
      return `immediate ${added}`;
  }
  return undefined;
}

/** Whether parameter path `inner` is `outer` or lies inside it. */
function within(inner: string, outer: string): boolean {
  return (
    inner === outer ||
    inner.startsWith(`${outer}.`) ||
    inner.startsWith(`${outer}[]`)
  );
}

function requiredNames(value: unknown): Set<string> | undefined {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    return undefined;
  return new Set(value as string[]);
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
