import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { CardId, Clock, ProjectId } from "@cardigan/domain";
import {
  decisionCategories,
  decisionDelegation,
  decisionHistory,
  pmMergeConfirmation,
  projectPreferences,
} from "@cardigan/domain";
import type { MergeGateConfiguration } from "@cardigan/host";
import { readRunQueue } from "@cardigan/host";
import { resolveDataDirectory } from "@cardigan/runtime-herdr";
import { listRoleVersions, type Store, type WebSession } from "@cardigan/store";
import { DEFAULT_SHUTDOWN_GRACE_MS } from "../config.js";
import { type ShutdownTimer, systemShutdownTimer } from "../lifecycle.js";
import { serveAttachment } from "./attachments.js";
import { serveAvatar } from "./avatars.js";
import { readCardDetail, readCardList } from "./card-state.js";
import {
  allowedHosts,
  bracket,
  requireLoopbackHost,
  type WebConfig,
} from "./config.js";
import { executionCapacity } from "./execution-capacity.js";
import {
  applySecurityHeaders,
  clearedSessionCookie,
  HttpRejection,
  methodNotAllowed,
  parseCookies,
  readJsonBody,
  requestRoute,
  requireHost,
  requireOrigin,
  SESSION_COOKIE,
  sendError,
  sendJson,
  sessionCookie,
  unauthorized,
} from "./http.js";
import { LoginLimiter } from "./login-limiter.js";
import { serveMergeCheckLog } from "./merge-check-log.js";
import {
  type ActivityQuery,
  activity,
  type CardFilter,
  executionRunPage,
  executionView,
  InvalidQuery,
  needsMe,
  needsYou,
  noticePage,
  parseCardFilter,
  projectSnapshotView,
  projectState,
  roleDetail,
  roleHistory,
  roleList,
  templateHistory,
  templateList,
  waitingOnAgent,
  webDecisionView,
  webMemberView,
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
  readonly runLimit?: (machine: string) => number;
  /** 按 q(228) 定为 30 分钟；修改配置后重启 Web 服务生效。 */
  readonly queueWarningMinutes?: number;
  readonly store: Store;
  readonly config: WebConfig;
  /** Structured log line per request, like the MCP endpoint's log. */
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
  readonly clock?: Clock;
  readonly loginLimiter?: LoginLimiter;
  /** Attachment blobs live beside the database (§9.3). */
  readonly dataDir?: string;
  readonly mergeGate?: MergeGateConfiguration;
  /** C-153: the host_ops patrol cadence Needs You quotes to the human. */
  readonly hostOpsPatrolIntervalMs?: number;
  /** C-153: the hc session registered in runtime.json, for operator commands. */
  readonly hcSession?: string;
  /** SSE cadence; tests shorten it, production uses the plan's 500 ms / 15 s. */
  readonly stream?: {
    readonly pollMs?: number;
    readonly heartbeatMs?: number;
  };
  /**
   * How long in-flight requests may run after `close()` before their
   * connections are cut. SSE streams never get it: they end at once.
   */
  readonly shutdownGraceMs?: number;
  /** Grace-period timer; tests drive it by hand. */
  readonly shutdownTimer?: ShutdownTimer;
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
  readonly runLimit: WebServerOptions["runLimit"];
  readonly queueWarningMinutes: number;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly config: WebConfig;
  readonly clock: Clock;
  readonly limiter: LoginLimiter;
  readonly dataDir: string;
  readonly mergeGate: MergeGateConfiguration | undefined;
  readonly hostOpsPatrolIntervalMs: number | undefined;
  readonly hcSession: string | undefined;
  readonly stream: WebServerOptions["stream"];
  readonly shutdown: AbortSignal;
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
  const queueWarningMinutes =
    options.queueWarningMinutes ??
    Number(process.env.CARDIGAN_QUEUE_WARNING_MINUTES ?? 30);
  if (!Number.isSafeInteger(queueWarningMinutes) || queueWarningMinutes < 1)
    throw new Error(
      "CARDIGAN_QUEUE_WARNING_MINUTES 必须是正整数（按 q(228) 定为 30 分钟）",
    );
  const clock = options.clock ?? systemClock;
  const limiter = options.loginLimiter ?? new LoginLimiter();
  const log =
    options.log ??
    ((event) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    });
  const dataDir = resolveDataDirectory({
    ...process.env,
    CARDIGAN_DATA_DIR: options.dataDir ?? process.env.CARDIGAN_DATA_DIR,
  });
  const host = config.host;
  // Filled in once the socket is bound: the Host allow-list needs the port.
  let boundPort = 0;
  // Aborted by close(): SSE streams end, and responses stop keeping sockets.
  const shutdown = new AbortController();

  const http = createServer((req, res) => {
    if (shutdown.signal.aborted) res.setHeader("Connection", "close");
    // While closing, a finished keep-alive socket is idle; close it so
    // `http.close()` does not wait for the browser to hang up.
    res.once("close", () => {
      if (shutdown.signal.aborted)
        setImmediate(() => http.closeIdleConnections());
    });
    const startedAt = performance.now();
    let code = "ok";
    let route = "unmatched";
    try {
      route = requestRoute(
        new URL(req.url ?? "/", "http://workbench.invalid").pathname,
      );
    } catch {
      /* Invalid URLs are handled below. */
    }
    let logged = false;
    const completed = () => {
      if (logged) return;
      logged = true;
      log({
        event: "web_http",
        method: req.method,
        route,
        code: res.writableFinished ? code : "aborted",
        status: res.statusCode,
        duration_ms: performance.now() - startedAt,
      });
    };
    res.once("finish", completed);
    res.once("close", completed);
    void handle(req, res).catch((error: unknown) => {
      code = error instanceof HttpRejection ? error.code : "internal_error";
      if (!(error instanceof HttpRejection)) {
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
        mergeGate: options.mergeGate,
        hostOpsPatrolIntervalMs: options.hostOpsPatrolIntervalMs,
        hcSession: options.hcSession,
        runLimit: options.runLimit,
        stream: options.stream,
        queueWarningMinutes,
        shutdown: shutdown.signal,
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
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const timer = options.shutdownTimer ?? systemShutdownTimer;
  let closing: Promise<void> | undefined;

  return {
    host,
    port: address.port,
    url: `http://${bracket(host)}:${address.port}`,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        let cancel = (): void => {};
        // Stop listening first, then end the streams; `close` also drops the
        // connections that are already idle.
        http.close((error) => {
          cancel();
          if (error) reject(error);
          else resolve();
        });
        shutdown.abort();
        http.closeIdleConnections();
        cancel = timer(graceMs, () => http.closeAllConnections());
      })),
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

  if (path.startsWith("/api/avatars/")) {
    return serveAvatar(
      req,
      res,
      context.dataDir,
      path.slice("/api/avatars/".length),
    );
  }

  if (path === "/api/me") {
    if (req.method !== "GET") methodNotAllowed(["GET"]);
    sendJson(res, 200, {
      authenticated: true,
      member: context.store.uow.read((tx) =>
        webMemberView(
          session.member_id
            ? (tx.members.get(session.member_id) ?? null)
            : null,
        ),
      ),
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
      signal: context.shutdown,
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
        mergeGate: context.mergeGate?.forProject(project_id),
        runLimit: context.runLimit,
        authorize: () => requireSession(context),
      },
      rest,
    )
  )
    return;

  if (req.method !== "GET") methodNotAllowed(["GET"]);

  if (rest === "/execution/capacity") {
    sendJson(
      res,
      200,
      executionCapacity(store, context.runLimit, context.mergeGate),
    );
    return;
  }

  if (rest.startsWith("/merge-checks/")) {
    return serveMergeCheckLog({
      res,
      dataDir: context.dataDir,
      projectId: project_id,
      attempt: rest.slice("/merge-checks/".length),
      hasAttempt: (attempt) =>
        projectState(store, project_id).events.some((event) => {
          const payload = event.payload;
          return (
            event.card_id &&
            event.actor.project_id === project_id &&
            [
              "merge_check_queued",
              "merge_check_started",
              "merge_check_finished",
              "merge_check_requeued",
            ].includes(event.type) &&
            payload !== null &&
            typeof payload === "object" &&
            "attempt_id" in payload &&
            payload.attempt_id === attempt
          );
        }),
      authorize: () => requireSession(context),
    });
  }

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
    const cards = readCardList(store, project_id);
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
    const detail = readCardDetail(store, project_id, card_id, {
      mergeGateStatus:
        context.mergeGate?.forProject(project_id).status ?? "disabled",
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

  if (rest === "/roles" || rest.startsWith("/roles/")) {
    serveRoleRead(context, project_id, rest);
    return;
  }

  const state = projectState(store, project_id);
  if (rest === "/card-templates") {
    sendJson(res, 200, { templates: templateList(state) });
    return;
  }
  const template = /^\/card-templates\/([a-z0-9-]+)(\/history)?$/.exec(rest);
  if (template) {
    const history = templateHistory(state, template[1] ?? "");
    if (!history.length)
      throw new HttpRejection(404, "not_found", "模板不存在");
    sendJson(
      res,
      200,
      template[2]
        ? { versions: history }
        : { template: history[0], previous: history[1] ?? null },
    );
    return;
  }
  if (rest === "/preferences") {
    // This baseline has no merge-gate executor/configuration yet.
    sendJson(res, 200, {
      ...projectPreferences(state),
      decision_delegation: decisionDelegation(projectPreferences(state)),
      pm_merge_confirmation: pmMergeConfirmation(projectPreferences(state)),
      merge_gate_enabled: false,
    });
    return;
  }
  if (rest === "/decision-history") {
    const decider = url.searchParams.get("decider") || undefined;
    const category = url.searchParams.get("category") || undefined;
    const card_id = url.searchParams.get("card_id") || undefined;
    const from = url.searchParams.get("from") || undefined;
    const to = url.searchParams.get("to") || undefined;
    if (
      (decider && !["human", "pm", "system"].includes(decider)) ||
      (category && !decisionCategories.includes(category as never)) ||
      [from, to].some((v) => v && !Number.isFinite(Date.parse(v)))
    )
      throw new HttpRejection(400, "validation_failed", "拍板记录筛选条件无效");
    sendJson(res, 200, {
      decisions: decisionHistory(state, {
        ...(decider ? { decider: decider as "human" | "pm" | "system" } : {}),
        ...(category ? { category } : {}),
        ...(card_id ? { card_id } : {}),
        ...(from ? { from: new Date(from).toISOString() } : {}),
        ...(to ? { to: new Date(to).toISOString() } : {}),
      }).map((decision) => ({
        ...decision,
        ...webDecisionView(state, decision),
      })),
    });
    return;
  }
  if (rest === "/needs-you") {
    sendJson(res, 200, {
      project_id,
      ...needsYou(
        state,
        now,
        context.mergeGate?.forProject(project_id).status,
        context.hostOpsPatrolIntervalMs,
        context.hcSession,
      ),
    });
    return;
  }

  if (rest === "/notices") {
    try {
      sendJson(
        res,
        200,
        noticePage(state, url.searchParams.get("before") ?? undefined),
      );
    } catch (error) {
      if (error instanceof InvalidQuery)
        throw new HttpRejection(400, "validation_failed", error.message);
      throw error;
    }
    return;
  }

  if (rest === "/snapshot") {
    sendJson(res, 200, projectSnapshotView(state, now));
    return;
  }

  if (rest === "/execution") {
    const machines = store.uow.read((tx) => tx.machines.list(project_id));
    sendJson(
      res,
      200,
      executionView(
        state,
        now,
        machines,
        readRunQueue(store),
        context.queueWarningMinutes,
      ),
    );
    return;
  }

  const runPage = /^\/execution\/assignments\/([^/]+)\/runs$/u.exec(rest);
  if (runPage) {
    let assignment_id: string;
    try {
      assignment_id = decodeURIComponent(runPage[1] ?? "");
    } catch {
      throw new HttpRejection(404, "not_found", "Assignment 不存在");
    }
    let page: ReturnType<typeof executionRunPage>;
    try {
      page = executionRunPage(
        state,
        assignment_id,
        url.searchParams.get("before") ?? undefined,
        readRunQueue(store),
      );
    } catch (error) {
      if (error instanceof InvalidQuery)
        throw new HttpRejection(400, "validation_failed", error.message);
      throw error;
    }
    if (page === undefined)
      throw new HttpRejection(404, "not_found", "Assignment 不存在");
    sendJson(res, 200, { project_id, ...page });
    return;
  }

  if (rest === "/activity") {
    sendJson(res, 200, activity(state, activityQuery(url), now));
    return;
  }

  throw new HttpRejection(404, "not_found", "not found");
}

/** V9b 角色管理: list, one role's current definition, and its version history. */
function serveRoleRead(
  context: RequestContext,
  project_id: ProjectId,
  rest: string,
): void {
  const versions = context.store.uow.read((tx) =>
    listRoleVersions(tx, project_id),
  );
  if (rest === "/roles") {
    sendJson(context.res, 200, roleList(project_id, versions));
    return;
  }
  const match = /^\/roles\/([^/]+)(\/history)?$/u.exec(rest);
  let role_id: string | undefined;
  try {
    role_id = match ? decodeURIComponent(match[1] ?? "") : undefined;
  } catch {
    role_id = undefined;
  }
  const body =
    role_id === undefined
      ? undefined
      : match?.[2]
        ? roleHistory(
            projectState(context.store, project_id),
            versions,
            role_id,
          )
        : roleDetail(versions, role_id);
  if (body === undefined)
    throw new HttpRejection(404, "not_found", "角色不存在，请核对角色编号。");
  sendJson(context.res, 200, { project_id, ...body });
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
