import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type {
  CardId,
  Clock,
  NeedsYouSection,
  ProjectId,
} from "@cardigan/domain";
import {
  decisionDelegation,
  highRiskPaths,
  INDEPENDENT_REVIEW_DELEGATION_MAX,
  independentReviewMaxRounds,
  mergeBatches,
  mergeConfirmSnoozeDefaultMinutes,
  mergeConfirmSnoozeMaxMinutes,
  mergeConfirmStallAfterMinutes,
  pmConfirmHumanDecidedMerges,
  pmConfirmRoleRuleImplementations,
  pmMergeConfirmation,
  projectPreferences,
  REVIEW_MAX_ROUNDS_CEILING,
  reviewMaxRounds,
} from "@cardigan/domain";
import type {
  HostOpsService,
  MergeGateConfiguration,
  ReadResourceLimits,
} from "@cardigan/host";
import { resolveDataDirectory } from "@cardigan/runtime-herdr";
import { listRoleVersions, type Store, type WebSession } from "@cardigan/store";
import { type BuildInfo, readBuildInfo } from "../build-info.js";
import { DEFAULT_SHUTDOWN_GRACE_MS } from "../config.js";
import { type ShutdownTimer, systemShutdownTimer } from "../lifecycle.js";
import { mergeProjectSettings } from "../merge-push-loop.js";
import { readActivity } from "./activity-state.js";
import { serveAttachment } from "./attachments.js";
import { serveAvatar } from "./avatars.js";
import { cardSectionPayload } from "./card-sections.js";
import {
  type CardsCacheOptions,
  readCachedCardsPage,
  readCardsVersion,
} from "./cards-cache.js";
import {
  allowedHosts,
  bracket,
  requireLoopbackHost,
  type WebConfig,
} from "./config.js";
import { readDecisionHistory } from "./decision-history-state.js";
import {
  executionCapacity,
  executionCapacityRevision,
} from "./execution-capacity.js";
import {
  declaredCapabilities,
  readExecution,
  readExecutionRuns,
} from "./execution-state.js";
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
import { MachineChecks } from "./machine-checks.js";
import type { MachineHost } from "./machine-host.js";
import { serveMachines } from "./machines.js";
import { serveMergeCheckLog } from "./merge-check-log.js";
import { readNeedsState } from "./needs-state.js";
import { readNeedsVersion } from "./needs-version.js";
import {
  contextUsageRevision,
  type ExecutionContexts,
  InvalidQuery,
  needsYou,
  needsYouCounts,
  noticePage,
  projectSnapshotView,
  projectState,
  roleDetail,
  roleHistory,
  roleList,
  templateHistory,
  templateList,
  webMemberView,
} from "./read.js";
import { emptyState } from "./sql-state.js";
import { serveStatic } from "./static.js";
import { parseAfter, type StreamCursor, serveStream } from "./stream.js";
import { readPagedCard } from "./timeline-state.js";
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
  readonly machineHost?: MachineHost;
  readonly roleLaunchConfig?: () =>
    | import("@cardigan/roles").LaunchConfig
    | undefined;
  readonly launchProfiles?: () => readonly string[];
  readonly executionDiagnostics?: HostOpsService["executionDiagnostics"];
  readonly cardsCache?: CardsCacheOptions;
  readonly runLimit?: (machine: string) => number;
  readonly runLimitMaximum?: (machine: string) => number;
  readonly machineDisplayName?: (machine: string) => string | undefined;
  /** MC-4 trusted per-machine resource limits, for the capacity read only. */
  readonly resourceLimits?: ReadResourceLimits;
  /**
   * MC-5 host capability catalog (built-in + private custom keys), read per
   * execution request so catalog edits show without a restart. Keys only.
   */
  readonly capabilityCatalog?: () => readonly {
    readonly key: string;
    readonly os: readonly string[];
  }[];
  /** 按 q(228) 定为 30 分钟；修改配置后重启 Web 服务生效。 */
  readonly queueWarningMinutes?: number;
  /**
   * C-232: the host patrol's latest fresh context samples per Assignment
   * (memory only). Absent without a dispatcher; the column then shows "—".
   */
  readonly contextUsage?: (project: ProjectId) => ExecutionContexts;
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
  /** C-228 / Q-387: failures-only unknown grace before Needs You; 60 s default. */
  readonly runtimeUnknownGraceMs?: number;
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
  readonly checks: MachineChecks;
  readonly host: MachineHost | undefined;
  readonly recordTiming: (stage: string, ms: number) => void;
  readonly roleLaunchConfig: WebServerOptions["roleLaunchConfig"];
  readonly launchProfiles: WebServerOptions["launchProfiles"];
  readonly executionDiagnostics: WebServerOptions["executionDiagnostics"];
  readonly buildInfo: BuildInfo;
  readonly cardsCache: CardsCacheOptions | undefined;
  readonly needsReadEpoch: string;
  readonly runLimit: WebServerOptions["runLimit"];
  readonly runLimitMaximum: WebServerOptions["runLimitMaximum"];
  readonly machineDisplayName: WebServerOptions["machineDisplayName"];
  readonly resourceLimits: WebServerOptions["resourceLimits"];
  readonly capabilityCatalog: WebServerOptions["capabilityCatalog"];
  readonly queueWarningMinutes: number;
  readonly contextUsage: WebServerOptions["contextUsage"];
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
  readonly runtimeUnknownGraceMs: number | undefined;
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
  const buildInfo = readBuildInfo();
  const queueWarningMinutes =
    options.queueWarningMinutes ??
    Number(process.env.CARDIGAN_QUEUE_WARNING_MINUTES ?? 30);
  if (!Number.isSafeInteger(queueWarningMinutes) || queueWarningMinutes < 1)
    throw new Error(
      "CARDIGAN_QUEUE_WARNING_MINUTES 必须是正整数（按 q(228) 定为 30 分钟）",
    );
  const clock = options.clock ?? systemClock;
  const needsReadEpoch = randomUUID();
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
  const checks = new MachineChecks(
    store,
    clock,
    shutdown.signal,
    options.machineHost,
  );

  const http = createServer((req, res) => {
    if (shutdown.signal.aborted) res.setHeader("Connection", "close");
    // While closing, a finished keep-alive socket is idle; close it so
    // `http.close()` does not wait for the browser to hang up.
    res.once("close", () => {
      if (shutdown.signal.aborted)
        setImmediate(() => http.closeIdleConnections());
    });
    const startedAt = performance.now();
    const requestId = randomUUID();
    let headersAt: number | undefined;
    const writeHead = res.writeHead;
    res.writeHead = function (
      this: ServerResponse,
      ...args: Parameters<typeof res.writeHead>
    ) {
      headersAt ??= performance.now();
      return writeHead.apply(this, args);
    } as typeof res.writeHead;
    let code = "ok";
    let route = "unmatched";
    try {
      route = requestRoute(
        new URL(req.url ?? "/", "http://workbench.invalid").pathname,
      );
    } catch {
      /* Invalid URLs are handled below. */
    }
    const phases: Record<string, number> = {};
    let logged = false;
    const completed = () => {
      if (logged) return;
      logged = true;
      log({
        event: "web_http",
        timestamp: new Date().toISOString(),
        role: "web",
        pid: process.pid,
        request_id: requestId,
        phases_ms: {
          ...phases,
          to_headers: (headersAt ?? performance.now()) - startedAt,
          response: performance.now() - (headersAt ?? startedAt),
        },
        method: req.method,
        route,
        code: res.writableFinished ? code : "aborted",
        status: res.statusCode,
        duration_ms: performance.now() - startedAt,
      });
    };
    res.once("finish", completed);
    res.once("close", completed);
    void handle(req, res, (stage, ms) => {
      phases[stage] = ms;
    }).catch((error: unknown) => {
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
    recordTiming: RequestContext["recordTiming"],
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
        checks,
        host: options.machineHost,
        recordTiming,
        buildInfo,
        cardsCache: options.cardsCache,
        needsReadEpoch,
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
        runtimeUnknownGraceMs: options.runtimeUnknownGraceMs,
        roleLaunchConfig: options.roleLaunchConfig,
        launchProfiles: options.launchProfiles,
        runLimit: options.runLimit,
        runLimitMaximum: options.runLimitMaximum,
        machineDisplayName: options.machineDisplayName,
        resourceLimits: options.resourceLimits,
        capabilityCatalog: options.capabilityCatalog,
        stream: options.stream,
        queueWarningMinutes,
        contextUsage: options.contextUsage,
        executionDiagnostics: options.executionDiagnostics,
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
          else void checks.settled().then(resolve, reject);
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

  if (rest === "/machines" || rest.startsWith("/machines/")) {
    return serveMachines(
      { ...context, authorize: () => requireSession(context) },
      project_id,
      rest,
    );
  }

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
      capacityRevision: () =>
        executionCapacityRevision(
          store,
          context.runLimit,
          context.mergeGate,
          context.runLimitMaximum,
          context.machineDisplayName,
          context.resourceLimits,
          project_id,
          clock.now(),
        ),
      ...(context.stream?.pollMs === undefined
        ? {}
        : { pollMs: context.stream.pollMs }),
      ...(context.stream?.heartbeatMs === undefined
        ? {}
        : { heartbeatMs: context.stream.heartbeatMs }),
      log: context.log,
      signal: context.shutdown,
      ...(context.contextUsage
        ? {
            contextRevision: () =>
              contextUsageRevision(context.contextUsage?.(project_id)),
          }
        : {}),
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
        roleLaunchConfig: context.roleLaunchConfig,
        launchProfiles: context.launchProfiles,
        mergeGate: context.mergeGate?.forProject(project_id),
        runLimit: context.runLimit,
        runLimitMaximum: context.runLimitMaximum,
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
      executionCapacity(
        store,
        context.runLimit,
        context.mergeGate,
        context.runLimitMaximum,
        context.machineDisplayName,
        context.resourceLimits,
        project_id,
        clock.now(),
      ),
    );
    return;
  }

  if (rest.startsWith("/prechecks/")) {
    let header = "";
    return serveMergeCheckLog({
      res,
      dataDir: context.dataDir,
      projectId: project_id,
      attempt: rest.slice("/prechecks/".length),
      precheck: true,
      hasAttempt: (attempt) => {
        const event = projectState(store, project_id)
          .events.filter((event) => {
            const payload = event.payload;
            return (
              event.card_id &&
              event.actor.kind === "system" &&
              event.actor.project_id === project_id &&
              [
                "precheck_queued",
                "precheck_started",
                "precheck_finished",
              ].includes(event.type) &&
              payload !== null &&
              typeof payload === "object" &&
              "attempt_id" in payload &&
              payload.attempt_id === attempt &&
              "card_id" in payload &&
              payload.card_id === event.card_id &&
              "head_sha" in payload &&
              typeof payload.head_sha === "string" &&
              /^[a-f0-9]{40}$/u.test(payload.head_sha)
            );
          })
          .sort((a, b) => b.seq - a.seq)[0];
        if (!event) return false;
        const payload = event.payload as { head_sha: string };
        header = `作者预检查\n被检提交：${payload.head_sha}\n更新时间：${event.created_at}\n\n`;
        return true;
      },
      logHeader: () => header,
      authorize: () => requireSession(context),
    });
  }

  if (rest.startsWith("/merge-batches/")) {
    requireSession(context);
    const id = rest.slice("/merge-batches/".length);
    const batches = mergeBatches(projectState(store, project_id).events);
    const batch = batches.find(
      (b) => b.id === id && b.project_id === project_id,
    );
    if (!batch) {
      sendJson(res, 404, { error: "批次不存在" });
      return;
    }
    sendJson(res, 200, {
      batch,
      probes: batches.filter((b) => b.parent_batch_id === batch.id),
    });
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
          if (
            !event.card_id &&
            event.actor.kind === "system" &&
            event.type.startsWith("merge_batch_check_") &&
            (payload as { check?: { attempt_id?: string } } | null)?.check
              ?.attempt_id === attempt
          )
            return true;
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

  if (rest === "/cards" || rest === "/cards/version") {
    try {
      const token = sessionToken(req);
      if (!token) throw new HttpRejection(401, "unauthorized", "需要登录");
      const options = {
        ...context.cardsCache,
        readScope: createHash("sha256")
          .update(`needs-you-read-scope:${token}`)
          .digest("hex"),
      };
      sendJson(
        res,
        200,
        rest === "/cards/version"
          ? readCardsVersion(store, project_id, url, options)
          : readCachedCardsPage(store, project_id, url, options),
      );
    } catch (error) {
      if (error instanceof InvalidQuery)
        throw new HttpRejection(400, "validation_failed", error.message);
      throw error;
    }
    return;
  }

  const card = /^\/cards\/([^/]+)$/.exec(rest);
  if (card !== null) {
    const card_id = decodeURIComponent(card[1] ?? "") as CardId;
    const detail = readPagedCard(store, project_id, card_id, url, {
      recordTiming: context.recordTiming,
      mergeGateStatus:
        context.mergeGate?.forProject(project_id).status ?? "disabled",
      now,
      ...(url.searchParams.get("at")
        ? { timelineAnchor: url.searchParams.get("at") ?? "" }
        : {}),
    });
    if (detail === undefined) {
      throw new HttpRejection(404, "not_found", `card ${card_id} not found`);
    }
    sendJson(res, 200, {
      project_id,
      ...cardSectionPayload(detail, url.searchParams.get("section")),
    });
    return;
  }

  if (rest === "/roles" || rest.startsWith("/roles/")) {
    serveRoleRead(context, project_id, rest);
    return;
  }

  if (rest === "/activity") {
    sendJson(res, 200, readActivity(store, project_id, url, now));
    return;
  }

  if (rest === "/decision-history") {
    sendJson(res, 200, readDecisionHistory(store, project_id, url));
    return;
  }
  if (rest === "/execution/diagnostics") {
    sendJson(
      res,
      200,
      (await context.executionDiagnostics?.(project_id)) ?? {
        configuration: [],
        sessions: [],
      },
    );
    return;
  }
  if (rest === "/execution") {
    sendJson(
      res,
      200,
      readExecution(
        store,
        project_id,
        url,
        now,
        context.queueWarningMinutes,
        context.contextUsage?.(project_id),
        declaredCapabilities(context.capabilityCatalog),
      ),
    );
    return;
  }
  const runPage = /^\/execution\/assignments\/([^/]+)\/runs$/u.exec(rest);
  if (runPage) {
    let assignmentId: string;
    try {
      assignmentId = decodeURIComponent(runPage[1] ?? "");
    } catch {
      throw new HttpRejection(404, "not_found", "Assignment 不存在");
    }
    const page = readExecutionRuns(
      store,
      project_id,
      assignmentId,
      url.searchParams.get("before") ?? undefined,
    );
    if (!page) throw new HttpRejection(404, "not_found", "Assignment 不存在");
    sendJson(res, 200, { project_id, ...page });
    return;
  }
  if (rest === "/needs-you/version") {
    requireSession(context);
    const token = sessionToken(req);
    if (!token) throw new HttpRejection(401, "unauthorized", "需要登录");
    sendJson(res, 200, {
      project_id,
      at: now,
      read_scope: createHash("sha256")
        .update(`needs-you-read-scope:${token}`)
        .digest("hex"),
      revision: readNeedsVersion(
        store,
        project_id,
        JSON.stringify([
          context.needsReadEpoch,
          context.mergeGate?.forProject(project_id).status ?? "disabled",
          context.hostOpsPatrolIntervalMs ?? null,
          context.hcSession ?? null,
          context.runtimeUnknownGraceMs ?? null,
        ]),
        now,
        context.runtimeUnknownGraceMs,
      ),
    });
    return;
  }
  if (rest === "/needs-you" || rest === "/needs-you/counts") {
    requireSession(context);
    const token = sessionToken(req);
    if (!token) throw new HttpRejection(401, "unauthorized", "需要登录");
    res.setHeader("X-Cardigan-Read-At", now);
    res.setHeader(
      "X-Cardigan-Read-Scope",
      createHash("sha256")
        .update(`needs-you-read-scope:${token}`)
        .digest("hex"),
    );
    const section = url.searchParams.get("section");
    if (
      section !== null &&
      !["decisions", "merges", "actions", "later", "notices"].includes(section)
    )
      throw new HttpRejection(400, "validation_failed", "Needs You 标签无效");
    const state = {
      ...readNeedsState(store, project_id),
      ...(context.mergeGate
        ? {
            project_settings:
              mergeProjectSettings(context.mergeGate, project_id) ?? {},
          }
        : {}),
    };
    if (rest === "/needs-you/counts") {
      sendJson(res, 200, {
        project_id,
        ...needsYouCounts(
          state,
          now,
          context.mergeGate?.forProject(project_id).status,
          context.runtimeUnknownGraceMs,
        ),
      });
      return;
    }
    sendJson(res, 200, {
      project_id,
      ...needsYou(
        state,
        now,
        context.mergeGate?.forProject(project_id).status,
        context.hostOpsPatrolIntervalMs,
        context.hcSession,
        context.runtimeUnknownGraceMs,
        (section ?? undefined) as NeedsYouSection | undefined,
      ),
    });
    return;
  }

  if (rest === "/notices") {
    try {
      sendJson(
        res,
        200,
        noticePage(
          readNeedsState(store, project_id),
          url.searchParams.get("before") ?? undefined,
        ),
      );
    } catch (error) {
      if (error instanceof InvalidQuery)
        throw new HttpRejection(400, "validation_failed", error.message);
      throw error;
    }
    return;
  }

  if (rest === "/preferences") {
    const state = store.uow.read((tx) => emptyState(tx, project_id));
    // Preferences do not need project history.
    sendJson(res, 200, {
      ...projectPreferences(state),
      cross_card_read: projectPreferences(state).cross_card_read !== false,
      high_risk_paths: highRiskPaths(projectPreferences(state)),
      auto_merge_paused: projectPreferences(state).auto_merge_paused === true,
      decision_delegation: decisionDelegation(projectPreferences(state)),
      pm_merge_confirmation: pmMergeConfirmation(projectPreferences(state)),
      pm_confirm_role_rule_implementations: pmConfirmRoleRuleImplementations(
        projectPreferences(state),
      ),
      pm_confirm_human_decided_merges: pmConfirmHumanDecidedMerges(
        projectPreferences(state),
      ),
      merge_confirm_snooze_default_minutes: mergeConfirmSnoozeDefaultMinutes(
        projectPreferences(state),
      ),
      merge_confirm_snooze_max_minutes: mergeConfirmSnoozeMaxMinutes(
        projectPreferences(state),
      ),
      merge_confirm_stall_after_minutes: mergeConfirmStallAfterMinutes(
        projectPreferences(state),
      ),
      review_max_rounds: reviewMaxRounds(projectPreferences(state)),
      independent_review_max_rounds: independentReviewMaxRounds(
        projectPreferences(state),
      ),
      review_max_rounds_ceiling: REVIEW_MAX_ROUNDS_CEILING,
      independent_review_limit_delegation:
        projectPreferences(state).independent_review_limit_delegation === true,
      independent_review_limit_delegation_max:
        projectPreferences(state).independent_review_limit_delegation_max ??
        null,
      independent_review_limit_delegation_ceiling:
        INDEPENDENT_REVIEW_DELEGATION_MAX,
      merge_gate_enabled: false,
    });
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
  if (rest === "/snapshot") {
    sendJson(res, 200, projectSnapshotView(state, now));
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
/** Public: tells the login page whether a password exists and who you are. */
function sessionStatus(context: RequestContext): void {
  const token = sessionToken(context.req);
  const live =
    token === undefined ? undefined : context.store.webSession(token);
  sendJson(context.res, 200, {
    authenticated: live !== undefined,
    ...(live && token
      ? {
          build: context.buildInfo,
          read_scope: createHash("sha256")
            .update(`needs-you-read-scope:${token}`)
            .digest("hex"),
        }
      : {}),
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
