import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MAX_MCP_BODY_BYTES } from "./attachments.js";
import { authenticate, bearerToken, type Identity } from "./auth.js";
import type { McpBackend } from "./backend.js";
import { acknowledgeDispatchedRun } from "./commands/acknowledge.js";
import {
  type DeliveryToolOptions,
  deliveryTools,
} from "./commands/delivery-tools.js";
import {
  type HostOpsToolOptions,
  hostOpsTools,
} from "./commands/host-ops-tools.js";
import { managementTools } from "./commands/management-tools.js";
import {
  type SupportToolOptions,
  supportTools,
} from "./commands/support-tools.js";
import { ToolError } from "./errors.js";
import { type Logger, stdoutLogger } from "./log.js";
import { createMcpServer, toolCatalogFingerprint } from "./tool-server.js";
import { readOnlyTools } from "./tools/index.js";
import type { ToolDefinition } from "./tools/types.js";

export interface McpServerOptions
  extends DeliveryToolOptions,
    SupportToolOptions,
    HostOpsToolOptions {
  readonly store: McpBackend;
  /** Loopback only; M1 never binds a public interface (§9.1, §14). */
  readonly host?: string;
  /** `0` picks a free port (tests). */
  readonly port?: number;
  readonly log?: Logger;
  readonly tools?: readonly ToolDefinition[];
  /** `false` disables the M2.6 acknowledge hook (tests of pure tool routing). */
  readonly acknowledgeRuns?: boolean;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  /** P2a-10 A: fingerprint of the `tools/list` this endpoint serves to `allowed`. */
  toolCatalog(
    allowed: readonly string[],
    assignment: Parameters<typeof toolCatalogFingerprint>[2],
  ): string;
  close(): Promise<void>;
}

const MCP_PATH = "/mcp";

/** IPv6 literals need brackets in a URL and in a Host header. */
function bracket(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** The tool set the endpoint serves when the caller does not inject one. */
export function serverTools(
  options: DeliveryToolOptions & SupportToolOptions & HostOpsToolOptions,
): readonly ToolDefinition[] {
  return [
    ...readOnlyTools,
    ...deliveryTools(options),
    ...managementTools(options.clock),
    ...supportTools(options),
    ...hostOpsTools(options),
  ];
}

let defaultCatalogTools: readonly ToolDefinition[] | undefined;

/**
 * P2a-10 A: the fingerprint of the default endpoint's `tools/list` for
 * `allowed`, computed without a running server. Host launch paths (CLI and
 * Dispatcher alike) record it for a new session. Descriptions and schemas do
 * not depend on the options, and no handler ever runs here.
 */
export function defaultToolCatalog(
  allowed: readonly string[],
  assignment: Parameters<typeof toolCatalogFingerprint>[2],
): string {
  defaultCatalogTools ??= serverTools({
    deliveryVerifier: () => {
      throw new Error("catalog tools never run");
    },
  });
  return toolCatalogFingerprint(defaultCatalogTools, allowed, assignment);
}

/**
 * Stateless Streamable HTTP MCP endpoint with Bearer Token auth (§9.1).
 *
 * Every request authenticates on its own and gets its own server instance bound
 * to that identity, so no state (and no tool scope) leaks between callers.
 */
export async function startMcpServer(
  options: McpServerOptions,
): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const log = options.log ?? stdoutLogger;
  const tools = options.tools ?? serverTools({ ...options, log });

  const catalogs = new Map<string, string>();

  // Filled in once the socket is bound; the DNS rebinding check needs the port.
  let boundPort = 0;

  const http = createServer((req, res) => {
    const startedAt = Date.now();
    void handleRequest(req, res, startedAt).catch((error: unknown) => {
      log({
        event: "http",
        method: req.method,
        code: "internal_error",
        duration_ms: Date.now() - startedAt,
      });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "internal_error" } }));
        return;
      }
      res.end();
      void error;
    });
  });

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    startedAt: number,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }

    const identity = authenticate(
      options.store,
      bearerToken(req.headers.authorization),
    );
    if (!identity.ok) {
      // Unknown, revoked and orphaned tokens all look like this on purpose.
      log({
        event: "auth",
        method: req.method,
        code: "unauthorized",
        status: 401,
        duration_ms: Date.now() - startedAt,
      });
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer",
      });
      res.end(
        JSON.stringify({
          error: { code: "unauthorized", message: "unauthorized" },
        }),
      );
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode: no server-initiated streams, no session teardown.
      log({
        event: "http",
        method: req.method,
        code: "method_not_allowed",
        status: 405,
        duration_ms: Date.now() - startedAt,
      });
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    await serveMcp(
      req,
      res,
      identity.value,
      options,
      tools,
      log,
      host,
      boundPort,
    );
    log({
      event: "http",
      method: req.method,
      assignment_id: identity.value.actor.assignment_id,
      code: res.statusCode < 400 ? "ok" : "error",
      status: res.statusCode,
      duration_ms: Date.now() - startedAt,
    });
  }

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, host, () => resolve());
  });
  const address = http.address() as AddressInfo;
  boundPort = address.port;

  return {
    host,
    port: address.port,
    url: `http://${bracket(host)}:${address.port}${MCP_PATH}`,
    toolCatalog: (allowed, assignment) => {
      // `tools` is fixed for the process, so the fingerprint is too.
      const key = JSON.stringify([
        [...allowed].sort(),
        assignment.scope,
        assignment.role_id,
        assignment.standing_mode ?? null,
      ]);
      let fingerprint = catalogs.get(key);
      if (fingerprint === undefined) {
        fingerprint = toolCatalogFingerprint(tools, allowed, assignment);
        catalogs.set(key, fingerprint);
      }
      return fingerprint;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      }),
  };
}

async function serveMcp(
  req: IncomingMessage,
  res: ServerResponse,
  identity: Identity,
  options: McpServerOptions,
  tools: readonly ToolDefinition[],
  log: Logger,
  host: string,
  port: number,
): Promise<void> {
  const server = createMcpServer({
    store: options.store,
    identity,
    tools,
    log,
    // The hooks belong to the tool call, not to the connection: `initialize`
    // and `tools/list` must not start the Run (§4 step 8) or make an idle Agent
    // look busy (M3 plan §3.3).
    onToolCall: () => {
      options.store.touchAssignmentActivity?.(
        identity.actor.project_id,
        identity.actor.assignment_id,
      );
      if (options.acknowledgeRuns !== false) {
        acknowledgeDispatchedRun(options.store, identity);
      }
    },
    revalidateToken: () => {
      const token = bearerToken(req.headers.authorization);
      if (!token || options.store.verifyToken(token)?.id !== identity.token.id)
        throw new ToolError("unauthorized", "Token is no longer valid");
    },
  });

  const transport = new StreamableHTTPServerTransport({
    // No sessionIdGenerator: stateless, one transport per request.
    enableJsonResponse: true,
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    enableDnsRebindingProtection: true,
    // The Host header must name the loopback address we listen on.
    // Include the bracketed IPv6 form (`[::1]:3004`) as well.
    allowedHosts: [
      host,
      `${host}:${port}`,
      bracket(host),
      `${bracket(host)}:${port}`,
      "localhost",
      `localhost:${port}`,
    ],
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}
