import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { CardId, Clock, ProjectId } from "@cardigan/domain";
import { resolveDataDirectory } from "@cardigan/runtime-herdr";
import type { Store, WebSession } from "@cardigan/store";
import { serveAttachment } from "./attachments.js";
import {
  allowedHosts,
  bracket,
  requireLoopbackHost,
  type WebConfig,
} from "./config.js";
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
import {
  type ActivityQuery,
  activity,
  type CardFilter,
  cardDetail,
  cardListViews,
  executionView,
  InvalidQuery,
  needsMe,
  needsYou,
  parseCardFilter,
  projectSnapshotView,
  projectState,
  waitingOnAgent,
} from "./read.js";
import { serveStatic } from "./static.js";
import { parseAfter, type StreamCursor, serveStream } from "./stream.js";
import { serveWrite } from "./write.js";

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
  /** Attachment blobs live beside the database (§9.3). */
  readonly dataDir?: string;
  /** SSE cadence; tests shorten it, production uses the plan's 500 ms / 15 s. */
  readonly stream?: {
    readonly pollMs?: number;
    readonly heartbeatMs?: number;
  };
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
  readonly dataDir: string;
  readonly stream: WebServerOptions["stream"];
  /** Only the validated Host and explicit configuration decide cookie flags. */
  readonly secureCookie: boolean;
  readonly log: (event: Readonly<Record<string, unknown>>) => void;
}

export async function startWebServer(
  options: WebServerOptions,
): Promise<RunningWebServer> {
  // The listener, not just the config resolver, enforces §0: a config object
  // built by hand must not put the Workbench on a network interface.
  const config: WebConfig = {
    ...options.config,
    host: requireLoopbackHost(options.config.host),
  };
  const { store } = options;
  const clock = options.clock ?? systemClock;
  const limiter = options.loginLimiter ?? new LoginLimiter();
  const log = options.log ?? (() => undefined);
  const dataDir = resolveDataDirectory({
    ...process.env,
    CARDIGAN_DATA_DIR: options.dataDir ?? process.env.CARDIGAN_DATA_DIR,
  });
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
    const hostHeader = requireHost(
      req,
      allowedHosts(host, boundPort, config.publicOrigins),
    );
    requireOrigin(req, hostHeader, config.publicOrigins);

    if (url.pathname.startsWith(API_PREFIX) || url.pathname === "/api") {
      await handleApi({
        req,
        res,
        url,
        store,
        config,
        clock,
        limiter,
        dataDir,
        stream: options.stream,
        secureCookie: config.publicOrigins.includes(`https://${hostHeader}`),
        log,
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
    // §3.2: every non-GET JSON endpoint checks its Content-Type, logout included.
    await readJsonBody(req);
    const token = sessionToken(req);
    if (token !== undefined) {
      context.store.revokeWebSession(token);
    }
    sendJson(
      res,
      200,
      { ok: true },
      {
        "Set-Cookie": clearedSessionCookie(context.secureCookie),
      },
    );
    return;
  }

  if (path === "/api/projects") {
    if (req.method !== "GET") methodNotAllowed(["GET"]);
    sendJson(res, 200, {
      projects: context.store.listProjects().map((project) => ({
        id: project.id,
        name: project.name,
        created_at: project.created_at,
      })),
    });
    return;
  }

  const route = PROJECT_ROUTE.exec(path);
  if (route !== null) {
    const project_id = decodeURIComponent(route[1] ?? "") as ProjectId;
    const rest = route[2] ?? "/";
    if (context.store.getProject(project_id) === undefined) {
      throw new HttpRejection(
        404,
        "not_found",
        `project ${project_id} not found`,
      );
    }
    return await serveProjectRoute(context, project_id, rest);
  }

  throw new HttpRejection(404, "not_found", "not found");
}

/** `/api/projects/<id><rest>`; the id is URL-encoded by the client. */
const PROJECT_ROUTE = /^\/api\/projects\/([^/]+)(\/.*)$/;

/**
 * Read-only project routes (M5 plan §4 M5.1). They answer from the domain
 * queries, as the human, and never write: see `read.ts` for the mapping to
 * §8.3–§8.6.
 */
async function serveProjectRoute(
  context: RequestContext,
  project_id: ProjectId,
  rest: string,
): Promise<void> {
  const { req, res, url, clock, store } = context;
  const now = clock.now();

  if (rest === "/stream") {
    if (req.method !== "GET") methodNotAllowed(["GET"]);
    let after: StreamCursor[];
    try {
      after = parseAfter(url.searchParams.get("after"));
    } catch (error) {
      throw new HttpRejection(
        400,
        "validation_failed",
        error instanceof Error ? error.message : "malformed cursors",
      );
    }
    await serveStream({
      store,
      project_id,
      req,
      res,
      after,
      ...(context.stream?.pollMs === undefined
        ? {}
        : { pollMs: context.stream.pollMs }),
      ...(context.stream?.heartbeatMs === undefined
        ? {}
        : { heartbeatMs: context.stream.heartbeatMs }),
      log: context.log,
    });
    return;
  }

  if (
    await serveWrite(
      {
        req,
        res,
        store,
        project_id,
        clock,
        dataDir: context.dataDir,
        authorize: () => requireSession(context),
      },
      rest,
    )
  )
    return;

  if (req.method !== "GET") methodNotAllowed(["GET"]);

  const attachment = /^\/attachments\/([^/]+)$/.exec(rest);
  if (attachment !== null) {
    const served = await serveAttachment({
      store,
      project_id,
      attachment_id: decodeURIComponent(attachment[1] ?? ""),
      req,
      res,
      dataDir: context.dataDir,
    });
    if (!served) {
      throw new HttpRejection(404, "not_found", "attachment not found");
    }
    return;
  }

  const state = projectState(store, project_id);

  if (rest === "/cards") {
    let filter: CardFilter;
    try {
      filter = parseCardFilter(url.searchParams.get("filter"));
    } catch (error) {
      throw new HttpRejection(
        400,
        "validation_failed",
        error instanceof InvalidQuery ? error.message : "unknown filter",
      );
    }
    const cards = cardListViews(state);
    const selected = cards.filter((card) =>
      filter === "needs_me"
        ? needsMe(card)
        : filter === "agent"
          ? waitingOnAgent(card)
          : true,
    );
    sendJson(res, 200, {
      project_id,
      filter,
      cards: selected,
      counts: {
        total: cards.length,
        needs_me: cards.filter(needsMe).length,
        agent: cards.filter(waitingOnAgent).length,
      },
    });
    return;
  }

  const card = /^\/cards\/([^/]+)$/.exec(rest);
  if (card !== null) {
    const card_id = decodeURIComponent(card[1] ?? "") as CardId;
    const limit = numberParam(url.searchParams.get("limit"));
    const detail = cardDetail(state, card_id, {
      now,
      ...(limit === undefined ? {} : { timelineLimit: limit }),
      ...(url.searchParams.get("at")
        ? { timelineAnchor: url.searchParams.get("at") ?? "" }
        : {}),
    });
    if (detail === undefined) {
      throw new HttpRejection(404, "not_found", `card ${card_id} not found`);
    }
    sendJson(res, 200, { project_id, ...detail });
    return;
  }

  if (rest === "/needs-you") {
    sendJson(res, 200, { project_id, ...needsYou(state, now) });
    return;
  }

  if (rest === "/snapshot") {
    sendJson(res, 200, projectSnapshotView(state, now));
    return;
  }

  if (rest === "/execution") {
    const machines = store.uow.read((tx) => tx.machines.list(project_id));
    sendJson(res, 200, executionView(state, now, machines));
    return;
  }

  if (rest === "/activity") {
    sendJson(res, 200, activity(state, activityQuery(url), now));
    return;
  }

  throw new HttpRejection(404, "not_found", "not found");
}

/** §8.6 filters: card, role, type, paging. Absent parameters mean "no filter". */
function activityQuery(url: URL): ActivityQuery {
  const query: {
    card_id?: CardId;
    role?: string;
    actor?: string;
    type?: string;
    category?: string;
    range?: string;
    before?: string;
    limit?: number;
  } = {};
  const card_id = url.searchParams.get("card_id");
  if (card_id !== null && card_id.length > 0) query.card_id = card_id as CardId;
  const role = url.searchParams.get("role");
  if (role !== null && role.length > 0) query.role = role;
  const actor = url.searchParams.get("actor");
  if (actor !== null && actor.length > 0) query.actor = actor;
  const type = url.searchParams.get("type");
  if (type !== null && type.length > 0) query.type = type;
  const category = url.searchParams.get("category");
  if (category !== null && category.length > 0) query.category = category;
  const range = url.searchParams.get("range");
  if (range !== null && ["24h", "7d", "30d"].includes(range))
    query.range = range;
  const before = url.searchParams.get("before");
  if (before !== null && before.length > 0) query.before = before;
  const limit = numberParam(url.searchParams.get("limit"));
  if (limit !== undefined) query.limit = limit;
  return query;
}

function numberParam(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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
        context.secureCookie,
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
