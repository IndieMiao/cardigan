import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticate, bearerToken, type Identity } from "./auth.js";
import type { McpBackend } from "./backend.js";
import { type Logger, stdoutLogger } from "./log.js";
import { createMcpServer } from "./tool-server.js";
import { readOnlyTools } from "./tools/index.js";
import type { ToolDefinition } from "./tools/types.js";

export interface McpServerOptions {
  readonly store: McpBackend;
  /** Loopback only; M1 never binds a public interface (§9.1, §14). */
  readonly host?: string;
  /** `0` picks a free port (tests). */
  readonly port?: number;
  readonly log?: Logger;
  readonly tools?: readonly ToolDefinition[];
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

const MCP_PATH = "/mcp";

/** IPv6 literals need brackets in a URL and in a Host header. */
function bracket(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
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
  const tools = options.tools ?? readOnlyTools;

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
  });

  const transport = new StreamableHTTPServerTransport({
    // No sessionIdGenerator: stateless, one transport per request.
    enableJsonResponse: true,
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
