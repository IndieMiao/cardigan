import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock } from "@cardigan/domain";
import type { Store, WebSession } from "@cardigan/store";
import { allowedHosts, bracket, type WebConfig } from "./config.js";
import {
  applySecurityHeaders,
  clearedSessionCookie,
  HttpRejection,
  methodNotAllowed,
  parseCookies,
  readJsonBody,
  requireHost,
  requireOrigin,
  SESSION_COOKIE,
  sendError,
  sendJson,
  sessionCookie,
  unauthorized,
} from "./http.js";
import { LoginLimiter } from "./login-limiter.js";
import { serveStatic } from "./static.js";

/**
 * The Workbench listener (M5 plan §3.1).
 *
 * A second, independent HTTP server beside the MCP endpoint: it serves the SPA,
 * the read/写 Workbench API and the SSE stream, and it accepts only a logged-in
 * human session. An MCP Bearer token is never consulted here, and a session
 * cookie is never consulted by the MCP endpoint (§3.2 credential separation).
 */

export interface WebServerOptions {
  readonly store: Store;
  readonly config: WebConfig;
  /** Structured log line per request, like the MCP endpoint's log. */
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
  readonly clock?: Clock;
  readonly loginLimiter?: LoginLimiter;
}

export interface RunningWebServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const systemClock: Clock = { now: () => new Date().toISOString() };
const API_PREFIX = "/api/";

interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly config: WebConfig;
  readonly clock: Clock;
  readonly limiter: LoginLimiter;
  /** The validated `Host` header, i.e. the origin this listener answers on. */
  readonly host: string;
}

export async function startWebServer(
  options: WebServerOptions,
): Promise<RunningWebServer> {
  const { config, store } = options;
  const clock = options.clock ?? systemClock;
  const limiter = options.loginLimiter ?? new LoginLimiter();
  const log = options.log ?? (() => undefined);
  const host = config.host;
  // Filled in once the socket is bound: the Host allow-list needs the port.
  let boundPort = 0;

  const http = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!(error instanceof HttpRejection)) {
        log({
          event: "web_http",
          method: req.method,
          path: req.url,
          code: "internal_error",
        });
        if (!res.headersSent) {
          sendError(res, 500, "internal_error", "internal error");
        } else {
          res.end();
        }
        return;
      }
      if (!res.headersSent) {
        sendError(res, error.status, error.code, error.message, {
          ...(error.details === undefined ? {} : { details: error.details }),
          headers: error.headers,
        });
        log({
          event: "web_http",
          method: req.method,
          path: req.url,
          code: error.code,
          status: error.status,
        });
      } else {
        res.end();
      }
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    applySecurityHeaders(res);
    // Parsing against a fixed base keeps the URL independent of the Host header;
    // requireHost decides separately whether that header may be trusted.
    const url = new URL(req.url ?? "/", "http://workbench.invalid");
    const hostHeader = requireHost(req, allowedHosts(host, boundPort));
    requireOrigin(req, hostHeader);

    if (url.pathname.startsWith(API_PREFIX) || url.pathname === "/api") {
      await handleApi({
        req,
        res,
        url,
        store,
        config,
        clock,
        limiter,
        host: hostHeader,
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      methodNotAllowed(["GET", "HEAD"]);
    }
    const served = await serveStatic(req, res, config.staticDir, url.pathname);
    if (!served.served) {
      throw new HttpRejection(404, "not_found", "not found");
    }
  }

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, host, () => resolve());
  });
  const address = http.address() as AddressInfo;
  boundPort = address.port;

  return {
    host,
    port: address.port,
    url: `http://${bracket(host)}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      }),
  };
}

async function handleApi(context: RequestContext): Promise<void> {
  const { req, res, url } = context;
  const path = url.pathname;

  if (path === "/api/login") {
    if (req.method !== "POST") methodNotAllowed(["POST"]);
    return login(context);
  }
  if (path === "/api/session") {
    if (req.method !== "GET") methodNotAllowed(["GET"]);
    return sessionStatus(context);
  }

  // Everything below needs a session; an MCP Bearer token does not count.
  const session = requireSession(context);

  if (path === "/api/me") {
    if (req.method !== "GET") methodNotAllowed(["GET"]);
    sendJson(res, 200, {
      authenticated: true,
      created_at: session.created_at,
      expires_at: session.expires_at,
    });
    return;
  }
  if (path === "/api/logout") {
    if (req.method !== "POST") methodNotAllowed(["POST"]);
    const token = sessionToken(req);
    if (token !== undefined) {
      context.store.revokeWebSession(token);
    }
    sendJson(res, 200, { ok: true }, { "Set-Cookie": clearedSessionCookie() });
    return;
  }

  throw new HttpRejection(404, "not_found", "not found");
}

/** Public: tells the login page whether a password exists and who you are. */
function sessionStatus(context: RequestContext): void {
  const token = sessionToken(context.req);
  const live =
    token === undefined ? undefined : context.store.webSession(token);
  sendJson(context.res, 200, {
    authenticated: live !== undefined,
    password_configured: context.store.webPasswordConfigured(),
  });
}

async function login(context: RequestContext): Promise<void> {
  const { req, res, store, config, limiter } = context;
  const key = loginKey(req);
  const waiting = limiter.retryAfterSeconds(key);
  if (waiting !== undefined) {
    throw new HttpRejection(
      429,
      "too_many_attempts",
      "too many failed logins, wait before trying again",
      { retry_after_seconds: waiting },
      { "Retry-After": String(waiting) },
    );
  }

  const body = await readJsonBody(req);
  const password = body.password;
  if (typeof password !== "string" || password.length === 0) {
    throw new HttpRejection(400, "validation_failed", "password is required");
  }

  if (!store.verifyWebLogin(password)) {
    limiter.recordFailure(key);
    // A fixed latency on failure: guessing over the loopback interface costs
    // time even before the lockout window starts.
    await delay(config.loginFailureDelayMs);
    throw new HttpRejection(401, "invalid_credentials", "invalid credentials");
  }

  limiter.recordSuccess(key);
  const issued = store.createWebSession({ ttlMs: config.sessionTtlMs });
  sendJson(
    res,
    200,
    { ok: true, expires_at: issued.session.expires_at },
    {
      "Set-Cookie": sessionCookie(
        issued.token,
        Math.floor(config.sessionTtlMs / 1000),
      ),
    },
  );
}

function loginKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function delay(ms: number): Promise<void> {
  return ms <= 0
    ? Promise.resolve()
    : new Promise((done) => setTimeout(done, ms));
}

function sessionToken(req: IncomingMessage): string | undefined {
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  return token === undefined || token.length === 0 ? undefined : token;
}

/**
 * Resolve the cookie to a live session or reject with 401.
 *
 * An `Authorization: Bearer` header is deliberately ignored: MCP tokens must
 * not open the Workbench API (§3.2).
 */
function requireSession(context: RequestContext): WebSession {
  const token = sessionToken(context.req);
  if (token === undefined) {
    unauthorized();
  }
  const session = context.store.webSession(token);
  if (session === undefined) {
    unauthorized("session expired or revoked");
  }
  return session;
}
