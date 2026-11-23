import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  MCP_SESSION_FAILURE,
  MCP_SESSION_HEADER,
  MCP_SESSION_KEY_PATTERN,
  type OwnerMessagePort,
} from "@cardigan/domain";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ArtifactUploads } from "./artifact-uploads.js";
import { serveAttachmentDownload } from "./attachment-download.js";
import { fileAttachmentStore, MAX_MCP_BODY_BYTES } from "./attachments.js";
import {
  authenticate,
  bearerToken,
  type Identity,
  recordIdentity,
} from "./auth.js";
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
import { freshResourceNonce, runResourceState } from "./run-resource-state.js";
import { createMcpServer, toolCatalogFingerprint } from "./tool-server.js";
import {
  type CheckLogOptions,
  getCheckLogTool,
} from "./tools/get-check-log.js";
import { readOnlyTools } from "./tools/index.js";
import {
  type MobileSigningOptions,
  mobileAccess,
  mobileSigningTool,
} from "./tools/mobile-signing.js";
import { ownerMessageTool } from "./tools/owner-message.js";
import {
  type PublicationOptions,
  publicationTool,
} from "./tools/publish-artifact.js";
import {
  type ReservationOptions,
  reservationTool,
} from "./tools/resource-reservation.js";
import { type ProbeToolOptions, runProbeTool } from "./tools/run-probe.js";
import type { ToolDefinition } from "./tools/types.js";

export interface McpServerOptions
  extends DeliveryToolOptions,
    SupportToolOptions,
    HostOpsToolOptions,
    CheckLogOptions,
    OwnerMessagePort,
    ReservationOptions,
    MobileSigningOptions,
    PublicationOptions,
    ProbeToolOptions {
  readonly store: McpBackend;
  /** Ordinary body deadline; for admitted artifacts, maximum gap between chunks. */
  readonly bodyTimeoutMs?: number;
  /** Loopback only; M1 never binds a public interface (§9.1, §14). */
  readonly host?: string;
  /** `0` picks a free port (tests). */
  readonly port?: number;
  /** Exact reverse-proxy Host values from private host configuration, per project. */
  readonly proxyHosts?: (projectId: string) => readonly string[];
  readonly log?: Logger;
  readonly tools?: readonly ToolDefinition[];
  /** `false` disables the M2.6 acknowledge hook (tests of pure tool routing). */
  readonly acknowledgeRuns?: boolean;
  readonly auditProbeCall?: (actor: Identity["actor"], code: string) => void;
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

/** Per-request, not per-socket: a later keep-alive request never inherits an upload exemption. */
function bodyDeadline(req: IncomingMessage, res: ServerResponse, ms: number) {
  const timer = setTimeout(() => {
    if (req.complete || req.destroyed) return;
    if (res.headersSent || res.destroyed) req.destroy();
    else res.writeHead(408, { Connection: "close" }).end(() => req.destroy());
  }, ms).unref();
  const clear = () => clearTimeout(timer);
  req.once("close", clear);
  req.once("end", clear);
  return () => {
    if (!req.complete && !req.destroyed) timer.refresh();
  };
}

/** IPv6 literals need brackets in a URL and in a Host header. */
function bracket(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** The tool set the endpoint serves when the caller does not inject one. */
export function serverTools(
  options: DeliveryToolOptions &
    SupportToolOptions &
    HostOpsToolOptions &
    CheckLogOptions &
    OwnerMessagePort &
    ReservationOptions &
    MobileSigningOptions &
    PublicationOptions &
    ProbeToolOptions,
): readonly ToolDefinition[] {
  return [
    ...readOnlyTools,
    getCheckLogTool(options),
    runProbeTool(options),
    mobileSigningTool(options),
    publicationTool(options),
    reservationTool(options),
    ownerMessageTool(options),
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
  const sink = options.log ?? stdoutLogger;
  const artifactUploads = new ArtifactUploads(options.dataDir, options.clock);
  const tools =
    options.tools ?? serverTools({ ...options, artifactUploads, log: sink });

  const catalogs = new Map<string, string>();

  // Filled in once the socket is bound; the DNS rebinding check needs the port.
  let boundPort = 0;

  const http = createServer((req, res) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const log: Logger = (entry) =>
      sink({
        ...entry,
        timestamp: new Date().toISOString(),
        role: "web",
        pid: process.pid,
        request_id: requestId,
      });
    void handleRequest(req, res, startedAt, log).catch((error: unknown) => {
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
    log: Logger,
  ): Promise<void> {
    const noteProgress = bodyDeadline(
      req,
      res,
      options.bodyTimeoutMs ?? 5 * 60_000,
    );
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }

    const resource =
      req.method === "GET" && url.searchParams.has("run_resource");
    const key = url.searchParams.get("run_resource") ?? "";
    const nonce = req.headers["x-resource-nonce"];
    const id = req.headers["x-resource-registration"];
    const mac = req.headers["x-resource-proof"];
    const identity = resource
      ? recordIdentity(
          options.store,
          typeof id === "string" &&
            typeof mac === "string" &&
            typeof nonce === "string" &&
            freshResourceNonce(nonce) &&
            /^A-[1-9]\d{0,15}\.R-[1-9]\d{0,15}\.R-[1-9]\d{0,15}$/u.test(key)
            ? options.store.verifyResourceRead?.(id, key, nonce, mac)
            : undefined,
        )
      : authenticate(options.store, bearerToken(req.headers.authorization));
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

    const allowedHosts = [
      host,
      `${host}:${boundPort}`,
      bracket(host),
      `${bracket(host)}:${boundPort}`,
      "localhost",
      `localhost:${boundPort}`,
    ];
    if (!allowedHosts.includes(req.headers.host ?? ""))
      allowedHosts.push(
        ...(options.proxyHosts?.(identity.value.actor.project_id) ?? []),
      );

    if (resource) {
      res.setHeader("Cache-Control", "private, no-store");
      if (
        url.searchParams.size !== 1 ||
        !allowedHosts.includes(req.headers.host ?? "") ||
        (req.headers.origin !== undefined &&
          req.headers.origin !== url.origin) ||
        identity.value.assignment.external ||
        !options.store.runResources
      ) {
        res.writeHead(403).end();
        return;
      }
      const state = runResourceState(
        options.store,
        identity.value,
        key,
        options.clock ? Date.parse(options.clock.now()) : Date.now(),
      );
      // No inbox advance, token rotation, wake or synthetic activity.
      const payload = JSON.stringify([
        "resource-state-v1",
        id,
        nonce,
        key,
        identity.value.actor.project_id,
        identity.value.assignment.machine_id,
        state,
      ]);
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          payload,
          signature: options.store.runResources.signState(payload),
        }),
      );
      return;
    }
    if (url.searchParams.has("mobile_artifact")) {
      res.setHeader("Cache-Control", "private, no-store");
      const id = url.searchParams.get("mobile_artifact") ?? "",
        platform = url.searchParams.get("platform");
      if (
        req.method !== "GET" ||
        !options.openMobileArtifact ||
        !tools.some((t) => t.name === "request_mobile_signature") ||
        !allowedHosts.includes(req.headers.host ?? "") ||
        (req.headers.origin !== undefined &&
          req.headers.origin !== url.origin) ||
        url.searchParams.size !== 2 ||
        !/^[a-f0-9]{32}$/u.test(id) ||
        (platform !== "android" && platform !== "ios")
      ) {
        res.writeHead(404).end();
        return;
      }
      try {
        const { scope, current } = mobileAccess(
          {
            store: options.store,
            identity: identity.value,
            revalidateToken: () => {
              const fresh = authenticate(
                options.store,
                bearerToken(req.headers.authorization),
              );
              if (
                !fresh.ok ||
                fresh.value.token.id !== identity.value.token.id ||
                !fresh.value.actor.allowed_tools.includes(
                  "request_mobile_signature",
                )
              )
                throw new Error("denied");
            },
          },
          platform,
        );
        const { stream, size, sha256 } = await options.openMobileArtifact(
          scope,
          id,
          current,
        );
        try {
          current();
          if (res.destroyed) return;
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": size,
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": `attachment; filename="${id}.${platform === "android" ? "apk" : "xcarchive.zip"}"`,
            ETag: `"${sha256}"`,
          });
          await pipeline(stream, res);
        } finally {
          stream.destroy();
        }
      } catch {
        if (!res.headersSent && !res.destroyed) res.writeHead(404).end();
        else res.destroy();
      }
      return;
    }
    if (req.method === "POST" && url.searchParams.has("artifact_upload")) {
      res.setHeader("Cache-Control", "private, no-store");
      if (
        !allowedHosts.includes(req.headers.host ?? "") ||
        (req.headers.origin !== undefined && req.headers.origin !== url.origin)
      ) {
        res.writeHead(403).end();
        return;
      }
      if (
        !identity.value.actor.allowed_tools.includes("upload_attachment") ||
        !tools.some((t) => t.name === "upload_attachment")
      ) {
        res.writeHead(403).end();
        return;
      }
      try {
        if (url.searchParams.size !== 1)
          throw ToolError.validation("Expected only artifact_upload");
        const result = await artifactUploads.accept(
          url.searchParams.get("artifact_upload") ?? "",
          req,
          {
            store: options.store,
            identity: identity.value,
            revalidateToken: () => {
              const token = bearerToken(req.headers.authorization);
              const fresh = token
                ? options.store.verifyToken(token)
                : undefined;
              if (
                fresh?.id !== identity.value.token.id ||
                !fresh.allowed_tools.includes("upload_attachment")
              )
                throw new ToolError("unauthorized", "Token is no longer valid");
            },
          },
          noteProgress,
        );
        res
          .writeHead(201, { "Content-Type": "application/json" })
          .end(JSON.stringify(result));
      } catch (err) {
        if (res.headersSent || res.destroyed) return; // idle timeout or disconnect
        const safe =
          err instanceof ToolError
            ? err
            : ToolError.validation(
                "Artifact upload failed; request a new address and retry",
              );
        res
          .writeHead(
            safe.code === "not_found"
              ? 404
              : safe.code === "unauthorized"
                ? 401
                : 400,
            { "Content-Type": "application/json" },
          )
          .end(JSON.stringify({ error: safe.toDomainError() }));
      }
      return;
    }
    if (req.method === "GET" && url.searchParams.has("attachment_id")) {
      if (!tools.some((tool) => tool.name === "read_attachment")) {
        res.writeHead(404).end();
        return;
      }
      await serveAttachmentDownload(
        req,
        res,
        url,
        options.attachmentStore ?? fileAttachmentStore(options.dataDir),
        {
          store: options.store,
          identity: identity.value,
          revalidateToken: () => {
            const token = bearerToken(req.headers.authorization);
            const fresh = token ? options.store.verifyToken(token) : undefined;
            if (
              fresh?.id !== identity.value.token.id ||
              !fresh.allowed_tools.includes("read_attachment")
            )
              throw new ToolError("unauthorized", "Token is no longer valid");
          },
        },
        allowedHosts,
        options.dataDir,
      );
      log({
        event: "http",
        method: req.method,
        assignment_id: identity.value.actor.assignment_id,
        code: res.statusCode < 400 ? "ok" : "error",
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      });
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

    const authenticatedAt = Date.now();
    await serveMcp(req, res, identity.value, options, tools, log, allowedHosts);
    log({
      event: "http",
      method: req.method,
      assignment_id: identity.value.actor.assignment_id,
      code: res.statusCode < 400 ? "ok" : "error",
      phases_ms: {
        authenticate: authenticatedAt - startedAt,
        serve: Date.now() - authenticatedAt,
      },
      status: res.statusCode,
      duration_ms: Date.now() - startedAt,
    });
  }

  // The Node parser's requestTimeout is an absolute ceiling, not an idle timer.
  // Keep its separate header deadline and a hard stop even for validated uploads.
  http.requestTimeout = 24 * 60 * 60_000;
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
        assignment.external === true,
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

/** C-600: bounded retries of the handshake write before failing a listing. */
const HANDSHAKE_WRITE_RETRIES = 3;
const HANDSHAKE_RETRY_MS = 100;

/**
 * C-600: digest of the per-launch key a verified harness sends from its own
 * MCP configuration; absent or malformed headers prove nothing.
 */
function sessionKeyDigest(req: IncomingMessage): string | undefined {
  const value = req.headers[MCP_SESSION_HEADER.toLowerCase()];
  return typeof value === "string" && MCP_SESSION_KEY_PATTERN.test(value)
    ? createHash("sha256").update(value).digest("hex")
    : undefined;
}

async function serveMcp(
  req: IncomingMessage,
  res: ServerResponse,
  identity: Identity,
  options: McpServerOptions,
  tools: readonly ToolDefinition[],
  log: Logger,
  allowedHosts: string[],
): Promise<void> {
  const server = createMcpServer({
    projectSettings: options.projectSettings,
    store: options.store,
    identity,
    ...(options.auditProbeCall
      ? { auditProbeCall: options.auditProbeCall }
      : {}),
    tools,
    log,
    // The hooks belong to the tool call, not to the connection: `initialize`
    // and `tools/list` must not start the Run (§4 step 8) or make an idle Agent
    // look busy (M3 plan §3.3).
    onToolCall: () => {
      // C-600: both are bound to this request's Token, so a late call of a
      // replaced session neither starts nor keeps alive the new session.
      options.store.touchAssignmentActivity?.(
        identity.actor.project_id,
        identity.actor.assignment_id,
        undefined,
        identity.token.id,
      );
      if (options.acknowledgeRuns !== false) {
        acknowledgeDispatchedRun(options.store, identity);
      }
    },
    // C-600: a native listing must be recorded before it is answered; a
    // briefly busy database is retried, then the client gets an error.
    onToolList: async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          options.store.advanceMcpHandshake?.(
            identity.actor.project_id,
            identity.actor.assignment_id,
            "tools_listed",
            sessionKeyDigest(req),
            identity.token.id,
          );
          return;
        } catch (error) {
          if (attempt >= HANDSHAKE_WRITE_RETRIES) throw error;
          await delay(HANDSHAKE_RETRY_MS * (attempt + 1));
        }
      }
    },
    refuseToolCall: () => {
      const handshake = options.store.advanceMcpHandshake?.(
        identity.actor.project_id,
        identity.actor.assignment_id,
        "tool_called",
        sessionKeyDigest(req),
        identity.token.id,
      );
      return handshake === "missing"
        ? {
            code: "illegal_transition",
            message: `${MCP_SESSION_FAILURE}（本次启动的 Harness 未列出工具）。系统会重建会话；请停止本会话的工作，不要改用命令行或其它方式调用 Card MCP。`,
          }
        : undefined;
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
    // Loopback listeners plus exact proxy Hosts configured for this Token's project.
    allowedHosts,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}
