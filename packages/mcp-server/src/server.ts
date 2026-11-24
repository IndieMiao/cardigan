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
import {
  fileAttachmentStore,
  MAX_MCP_BODY_BYTES,
  mcpBodyTooLargeMessage,
} from "./attachments.js";
import {
  authenticate,
  bearerToken,
  type Identity,
  recordIdentity,
} from "./auth.js";
import type { McpBackend } from "./backend.js";
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
import { ToolCallBookkeeping } from "./tool-call-bookkeeping.js";
import { createMcpServer, toolCatalogFingerprint } from "./tool-server.js";
import {
  type CapabilityGuideToolOptions,
  capabilityGuideTool,
} from "./tools/capability-guide.js";
import {
  type CheckLogOptions,
  getCheckLogTool,
} from "./tools/get-check-log.js";
import { readOnlyTools } from "./tools/index.js";
import {
  type MacosCheckToolOptions,
  macosCheckTool,
} from "./tools/macos-check.js";
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
import {
  type SharedFileToolOptions,
  sharedFileTools,
} from "./tools/shared-files.js";
import type { ToolDefinition } from "./tools/types.js";
import { VideoUploads } from "./video-uploads.js";

export interface McpServerOptions
  extends DeliveryToolOptions,
    SupportToolOptions,
    HostOpsToolOptions,
    CheckLogOptions,
    OwnerMessagePort,
    ReservationOptions,
    MobileSigningOptions,
    PublicationOptions,
    ProbeToolOptions,
    MacosCheckToolOptions,
    SharedFileToolOptions,
    CapabilityGuideToolOptions {
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
  /** C-635: minimum spacing of one session's activity writes (default 30 s). */
  readonly activityWriteIntervalMs?: number;
  readonly auditProbeCall?: (actor: Identity["actor"], code: string) => void;
  /**
   * C-638: called when a request arrives; the request is handled inside
   * `run` and `end` is called once its response closes. Timing only.
   */
  readonly beginRequest?: () => RequestActivity;
}

/** C-638: a request as seen by the host's stall and lock timing. */
export interface RequestActivity {
  run<T>(fn: () => T): T;
  end(): void;
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
    ProbeToolOptions &
    MacosCheckToolOptions &
    SharedFileToolOptions &
    CapabilityGuideToolOptions,
): readonly ToolDefinition[] {
  return [
    ...readOnlyTools,
    getCheckLogTool(options),
    runProbeTool(options),
    macosCheckTool(options),
    ...sharedFileTools(options),
    capabilityGuideTool(options),
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
  const videoUploads = new VideoUploads(
    options.dataDir ?? process.env.CARDIGAN_DATA_DIR ?? ".data",
    options.clock,
  );
  const tools =
    options.tools ??
    serverTools({ ...options, artifactUploads, videoUploads, log: sink });

  /**
   * C-683: one chunk (`PUT ?attachment_upload=<id>&offset=<n>`) or the
   * status (`GET ?attachment_upload=<id>`) of an Agent's video upload.
   */
  async function serveVideoUpload(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    identity: Identity,
    allowedHosts: readonly string[],
    noteProgress: () => void,
  ) {
    res.setHeader("Cache-Control", "private, no-store");
    const send = (status: number, body: unknown) =>
      res
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(body));
    if (
      !allowedHosts.includes(req.headers.host ?? "") ||
      (req.headers.origin !== undefined && req.headers.origin !== url.origin)
    ) {
      res.writeHead(403).end();
      return;
    }
    if (
      !identity.actor.allowed_tools.includes("upload_attachment") ||
      !tools.some((t) => t.name === "upload_attachment")
    ) {
      res.writeHead(403).end();
      return;
    }
    const context = {
      store: options.store,
      identity,
      revalidateToken: () => {
        const token = bearerToken(req.headers.authorization);
        const fresh = token ? options.store.verifyToken(token) : undefined;
        if (
          fresh?.id !== identity.token.id ||
          !fresh.allowed_tools.includes("upload_attachment")
        )
          throw new ToolError("unauthorized", "Token is no longer valid");
      },
    };
    try {
      const id = url.searchParams.get("attachment_upload") ?? "";
      const keys = [...url.searchParams.keys()];
      if (req.method === "GET") {
        if (keys.length !== 1)
          throw ToolError.validation("Expected only attachment_upload");
        send(200, await videoUploads.status(id, context));
        return;
      }
      const offsetText = url.searchParams.get("offset") ?? "";
      if (
        keys.length !== 2 ||
        !keys.includes("offset") ||
        !/^\d{1,12}$/u.test(offsetText)
      )
        throw ToolError.validation("Expected attachment_upload and offset");
      const result = await videoUploads.accept(
        id,
        Number(offsetText),
        req,
        context,
        noteProgress,
      );
      if (result.complete) send(201, result.attachment);
      else send(200, result.status);
    } catch (err) {
      if (res.headersSent || res.destroyed) return;
      const safe =
        err instanceof ToolError
          ? err
          : ToolError.validation("Video upload failed; retry the chunk");
      send(
        safe.code === "not_found"
          ? 404
          : safe.code === "unauthorized"
            ? 401
            : safe.code === "stale_target" ||
                safe.code === "idempotency_conflict"
              ? 409
              : 400,
        { error: safe.toDomainError() },
      );
    }
  }

  const catalogs = new Map<string, string>();
  const bookkeeping = new ToolCallBookkeeping({
    store: options.store,
    acknowledgeRuns: options.acknowledgeRuns !== false,
    ...(options.activityWriteIntervalMs === undefined
      ? {}
      : { activityWriteIntervalMs: options.activityWriteIntervalMs }),
    log: (entry) =>
      sink({
        ...entry,
        timestamp: new Date().toISOString(),
        role: "web",
        pid: process.pid,
      }),
  });

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
    const activity = options.beginRequest?.();
    if (activity) {
      res.once("finish", activity.end);
      res.once("close", activity.end);
    }
    const handled = () => handleRequest(req, res, startedAt, log);
    void (activity ? activity.run(handled) : handled()).catch(
      (error: unknown) => {
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
      },
    );
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
    if (
      (req.method === "PUT" || req.method === "GET") &&
      url.searchParams.has("attachment_upload")
    ) {
      await serveVideoUpload(
        req,
        res,
        url,
        identity.value,
        allowedHosts,
        noteProgress,
      );
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
    await serveMcp(
      req,
      res,
      identity.value,
      options,
      tools,
      log,
      allowedHosts,
      bookkeeping,
    );
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
        http.close((error) => {
          // C-635: one last attempt at deferred writes once requests stopped.
          bookkeeping.close();
          if (error) reject(error);
          else resolve();
        });
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

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res
    .writeHead(status, {
      "Content-Type": "application/json",
      Connection: "close",
    })
    .end(
      JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    );
}

const mcpBodyTooLarge = (res: ServerResponse) =>
  jsonRpcError(res, 413, -32000, mcpBodyTooLargeMessage());

/**
 * C-616: reads a body of unknown length as UTF-8, or `undefined` as soon as it
 * passes `limit`; the rest is left unread and the 413 closes the connection.
 */
function readBodyWithin(
  req: IncomingMessage,
  limit: number,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("error", fail);
      req.off("close", closed);
    };
    const data = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        done();
        req.pause();
        resolve(undefined);
      } else chunks.push(chunk);
    };
    const end = () => {
      done();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const fail = (error: Error) => {
      done();
      reject(error);
    };
    const closed = () =>
      fail(new Error("Request closed before its body ended"));
    req.on("data", data);
    req.once("end", end);
    req.once("error", fail);
    req.once("close", closed);
  });
}

async function serveMcp(
  req: IncomingMessage,
  res: ServerResponse,
  identity: Identity,
  options: McpServerOptions,
  tools: readonly ToolDefinition[],
  log: Logger,
  allowedHosts: string[],
  bookkeeping: ToolCallBookkeeping,
): Promise<void> {
  // C-616: the MCP transport's own 413 names only the body bound. Refuse an
  // oversized body here instead, so both a declared length and a chunked body
  // name the attachment limit too. A chunked JSON body is read here within the
  // same bound and handed over parsed; everything else stays with the SDK.
  let parsedBody: unknown;
  if (req.method === "POST" && allowedHosts.includes(req.headers.host ?? "")) {
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) > MAX_MCP_BODY_BYTES) {
      mcpBodyTooLarge(res);
      return;
    }
    const type = req.headers["content-type"] ?? "";
    if (
      declared === undefined &&
      type.split(";")[0]?.trim().toLowerCase() === "application/json"
    ) {
      const body = await readBodyWithin(req, MAX_MCP_BODY_BYTES);
      if (body === undefined) {
        mcpBodyTooLarge(res);
        return;
      }
      try {
        parsedBody = JSON.parse(body);
      } catch {
        jsonRpcError(res, 400, -32700, "Parse error: Invalid JSON");
        return;
      }
    }
  }
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
    // C-600: both are bound to this request's Token, so a late call of a
    // replaced session neither starts nor keeps alive the new session.
    // C-635: neither waits for another process's write lock.
    onToolCall: () => bookkeeping.toolCalled(identity),
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
      const handshake = bookkeeping.handshake(identity, sessionKeyDigest(req));
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
  await transport.handleRequest(req, res, parsedBody);
}
