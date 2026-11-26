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
  extractQualifiedReferences,
  highRiskPaths,
  humanCardTemplates,
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
import {
  MAX_ATTACHMENT_BYTES,
  offsiteFor,
  uploadSessionsFor,
} from "@cardigan/mcp-server";
import { resolveDataDirectory } from "@cardigan/runtime-herdr";
import {
  feishuStatus,
  listRoleVersions,
  manageFeishuBinding,
  type Store,
  type WebSession,
} from "@cardigan/store";
import { beginActivity } from "../activity.js";
import { type BuildInfo, readBuildInfo } from "../build-info.js";
import { DEFAULT_SHUTDOWN_GRACE_MS } from "../config.js";
import { type ShutdownTimer, systemShutdownTimer } from "../lifecycle.js";
import { mergeProjectSettings } from "../merge-push-loop.js";
import { type ProcessRole, processHealthView } from "../process-health.js";
import { readActivity } from "./activity-state.js";
import { readAttachmentRefs } from "./attachment-ref-read.js";
import {
  serveAttachment,
  serveAttachmentPreview,
  serveVideoPoster,
} from "./attachments.js";
import { serveAvatar } from "./avatars.js";
import { serveCapabilityGuides } from "./capability-guides.js";
import type { CardsCacheOptions } from "./cards-cache.js";
import {
  allowedHosts,
  bracket,
  requireLoopbackHost,
  type WebConfig,
} from "./config.js";
import { readDecisionHistory } from "./decision-history-state.js";
import { DevicePairings } from "./device-pairings.js";
import { drainTasks } from "./drain-tasks.js";
import {
  ExecutionCapacityCache,
  executionCapacity,
  executionCapacityInputs,
} from "./execution-capacity.js";
import { FeishuSettings } from "./feishu-settings.js";
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
  sendJsonText,
  sessionCookie,
  unauthorized,
} from "./http.js";
import { LaunchSettings } from "./launch-settings.js";
import { LoginLimiter } from "./login-limiter.js";
import { MachineChecks } from "./machine-checks.js";
import type { MachineHost } from "./machine-host.js";
import { serveMachines } from "./machines.js";
import { readMentionCandidates } from "./mention-candidates.js";
import { serveMergeCheckLog } from "./merge-check-log.js";
import { qualifiedReferenceResolver } from "./qualified-refs.js";
import {
  contextUsageRevision,
  type ExecutionContexts,
  projectSnapshotView,
  projectState,
  roleDetail,
  roleHistory,
  roleList,
  templateHistory,
  templateList,
  webMemberView,
} from "./read.js";
import {
  fromReadError,
  type HostFacts,
  type HostFactsReader,
  runWorkbenchRead,
  toReadError,
  type WorkbenchReadOp,
  type WorkbenchReadResult,
} from "./read-ops.js";
import { type WorkbenchReadOptions, WorkbenchReadPool } from "./read-pool.js";
import { releaseNotesView } from "./release-notes.js";
import { serveSharedFiles } from "./shared-files.js";
import { emptyState } from "./sql-state.js";
import { serveStatic } from "./static.js";
import { parseAfter, type StreamCursor, serveStream } from "./stream.js";
import { serveAttachmentThumbnail } from "./thumbnails.js";
import { serveUploads } from "./uploads.js";
import { WorkerWizards } from "./worker-wizards.js";
import { serveWrite } from "./write.js";

const HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

/**
 * The Workbench listener (M5 plan §3.1).
 *
 * A second, independent HTTP server beside the MCP endpoint: it serves the SPA,
 * the read/写 Workbench API and the SSE stream, and it accepts only a logged-in
 * human session. An MCP Bearer token is never consulted here, and a session
 * cookie is never consulted by the MCP endpoint (§3.2 credential separation).
 */

export interface WebServerOptions {
  readonly feishuSettingsPath?: string;
  readonly launchSettings?: {
    dir: string;
    effective: () => import("@cardigan/roles").LaunchConfig;
    adopt: (generation: import("../live-launch.js").LaunchGeneration) => void;
  };
  readonly machineHost?: MachineHost;
  readonly roleLaunchConfig?: () =>
    | import("@cardigan/roles").LaunchConfig
    | undefined;
  readonly launchProfiles?: () => readonly string[];
  readonly executionDiagnostics?: HostOpsService["executionDiagnostics"];
  readonly cardsCache?: CardsCacheOptions;
  /**
   * C-644: run the heavy Workbench reads (cards, card detail, Needs You,
   * execution, check-log lookups) in read workers with a private query-only
   * connection. Absent: they run inline on this thread, as before.
   */
  readonly workbenchReads?: WorkbenchReadOptions;
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
  /** C-638: this process on the health page; "web" also shows the background one. */
  readonly processRole?: ProcessRole;
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
  readonly feishuSettings: FeishuSettings | undefined;
  readonly launchSettings: LaunchSettings | undefined;
  readonly wizards: WorkerWizards;
  readonly pairings: DevicePairings;
  readonly checks: MachineChecks;
  readonly host: MachineHost | undefined;
  readonly recordTiming: (stage: string, ms: number) => void;
  readonly roleLaunchConfig: WebServerOptions["roleLaunchConfig"];
  readonly launchProfiles: WebServerOptions["launchProfiles"];
  readonly executionDiagnostics: WebServerOptions["executionDiagnostics"];
  readonly buildInfo: BuildInfo;
  readonly cardsCache: CardsCacheOptions | undefined;
  /** C-644: one heavy read, in its worker when configured, else inline. */
  readonly read: (
    op: WorkbenchReadOp,
    recordTiming?: (stage: string, ms: number) => void,
  ) => Promise<WorkbenchReadResult>;
  readonly needsReadEpoch: string;
  readonly capacity: ExecutionCapacityCache;
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
  readonly processRole: ProcessRole;
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
  // C-634: every SSE connection and the GET share one view per project.
  const capacity = new ExecutionCapacityCache({
    now: () => clock.now(),
    inputs: (now) => executionCapacityInputs(store, now),
    build: (project, now) =>
      executionCapacity(
        store,
        options.runLimit,
        options.mergeGate,
        options.runLimitMaximum,
        options.machineDisplayName,
        options.resourceLimits,
        project,
        now,
      ),
  });
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
  const feishuSettings = options.feishuSettingsPath
    ? new FeishuSettings(store, options.feishuSettingsPath)
    : undefined;
  const launchSettings = options.launchSettings
    ? new LaunchSettings(
        store,
        options.launchSettings.dir,
        dataDir,
        options.launchSettings.effective,
        options.launchSettings.adopt,
      )
    : undefined;
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

  // Host facts stay on this thread: they read private runtime files and
  // in-memory check jobs. Only machines named by open notices are asked.
  const hostFacts: HostFactsReader = async ({ project, machines, purpose }) => {
    const records = store.uow.read((tx) =>
      machines.map((id) => [id, tx.machines.get(project, id)] as const),
    );
    const facts: Record<string, HostFacts[string]> = {};
    for (const [id, machine] of records) {
      if (purpose === "needs_version") {
        facts[id] = {
          manual: checks.currentBinding(project, machine, "manual-upgrade"),
          ...(machine
            ? { tools: checks.currentToolsCommand(project, machine) }
            : {}),
        };
        continue;
      }
      const binding = checks.currentBinding(project, machine);
      facts[id] = {
        binding,
        ...(machine && binding
          ? { upgrade: checks.currentUpgradeCommand(project, machine, binding) }
          : {}),
        ...(machine
          ? { tools: checks.currentToolsCommand(project, machine) }
          : {}),
      };
    }
    return facts;
  };
  const pool = options.workbenchReads
    ? new WorkbenchReadPool({
        warmProjects: warmOrder(store),
        ...options.workbenchReads,
      })
    : undefined;
  const read: RequestContext["read"] = async (op, recordTiming) => {
    if (pool) return pool.read(op, hostFacts, recordTiming);
    let result: WorkbenchReadResult;
    try {
      result = await runWorkbenchRead(store, op, hostFacts);
    } catch (error) {
      const rejection = toReadError(error);
      throw rejection ? fromReadError(rejection) : error;
    }
    for (const [stage, ms] of Object.entries(result.timings))
      recordTiming?.(stage, ms);
    return result;
  };

  // C-705: one-time device pairing codes feed the add-worker wizard.
  const pairings = new DevicePairings(clock, !!options.machineHost?.wizard);
  const wizards = new WorkerWizards(
    store,
    clock,
    checks,
    shutdown.signal,
    options.machineHost?.wizard,
    options.runLimit,
    options.runLimitMaximum,
    pairings,
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
    // C-638: named by method and route template only, for stall attribution.
    const activity = beginActivity(
      "request",
      `web ${HTTP_METHODS.has(req.method ?? "") ? req.method : "OTHER"} ${route}`,
    );
    let logged = false;
    const completed = () => {
      activity.end();
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
    void activity
      .run(() =>
        handle(req, res, (stage, ms) => {
          phases[stage] = ms;
        }),
      )
      .catch((error: unknown) => {
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
    applySecurityHeaders(res, offsiteFor(dataDir)?.imageOrigin());
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
        wizards,
        pairings,
        host: options.machineHost,
        recordTiming,
        buildInfo,
        cardsCache: options.cardsCache,
        read,
        needsReadEpoch,
        capacity,
        req,
        res,
        url,
        store,
        config,
        clock,
        limiter,
        dataDir,
        processRole: options.processRole ?? "server",
        mergeGate: options.mergeGate,
        hostOpsPatrolIntervalMs: options.hostOpsPatrolIntervalMs,
        hcSession: options.hcSession,
        runtimeUnknownGraceMs: options.runtimeUnknownGraceMs,
        launchSettings,
        feishuSettings,
        roleLaunchConfig: launchSettings
          ? () => launchSettings.effective()
          : options.roleLaunchConfig,
        launchProfiles: launchSettings
          ? () => Object.keys(launchSettings.effective().profiles)
          : options.launchProfiles,
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
        launchSettings?.checks.beginShutdown();
        feishuSettings?.beginShutdown();
        let cancel = (): void => {};
        // Stop listening first, then end the streams; `close` also drops the
        // connections that are already idle.
        http.close((error) => {
          cancel();
          void drainTasks([
            pool?.close(),
            checks.settled(),
            wizards.settled(),
            launchSettings?.checks.drain(),
            feishuSettings?.drain(),
          ]).then(
            () => (error ? reject(error) : resolve()),
            (reason) => reject(error ?? reason),
          );
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

  // C-705: a new device has no account; it only gets a one-time pairing code.
  // C-706: the claimed device fetches its init script and reports the result.
  if (
    /^\/api\/device-pairings(?:\/(?:status|init-script|initialized))?$/.test(
      path,
    )
  )
    return context.pairings.serveDevice(
      req,
      context.res,
      path.slice("/api/device-pairings".length),
    );

  // C-725: an Agent's MCP Token is refused outright, not asked to log in.
  if (
    CAPABILITY_GUIDES_ROUTE.test(path) &&
    req.headers.authorization !== undefined
  )
    throw new HttpRejection(403, "unauthorized", "仅限人类登录会话");

  // Everything below needs a session; an MCP Bearer token does not count.
  const session = requireSession(context);

  if (
    path === "/api/feishu-settings" ||
    path.startsWith("/api/feishu-settings/")
  ) {
    if (!context.feishuSettings)
      throw new HttpRejection(503, "unavailable", "未配置飞书设置");
    const owner = createHash("sha256")
      .update(`feishu-settings:${sessionToken(req)}`)
      .digest("hex");
    return context.feishuSettings.serve(
      path.slice("/api/feishu-settings".length),
      req,
      res,
      () => requireSession(context),
      owner,
    );
  }
  if (
    path === "/api/launch-settings" ||
    path.startsWith("/api/launch-settings/")
  ) {
    if (!context.launchSettings)
      throw new HttpRejection(503, "unavailable", "未配置启动设置");
    const owner = createHash("sha256")
      .update(`launch-settings:${sessionToken(req)}`)
      .digest("hex");
    return context.launchSettings.serve(
      path.slice("/api/launch-settings".length),
      req,
      res,
      () => requireSession(context),
      owner,
    );
  }

  if (path === "/api/me/feishu") {
    if (req.method !== "GET" && req.method !== "POST")
      methodNotAllowed(["GET", "POST"]);
    if (req.method === "GET") {
      sendJson(res, 200, feishuStatus(context.store.database));
      return;
    }
    const input = await readJsonBody(req);
    const action = input.action;
    if (
      Object.keys(input).length !== 1 ||
      (action !== "code" && action !== "unbind")
    )
      throw new HttpRejection(400, "invalid_action", "绑定操作无效");
    const output = context.store.uow.run(() => {
      const live = requireSession(context);
      if (!live.member_id)
        throw new HttpRejection(403, "owner_required", "请重新登录");
      try {
        return manageFeishuBinding(
          context.store.database,
          live.member_id,
          action,
        );
      } catch {
        throw new HttpRejection(
          409,
          "binding_unavailable",
          "当前不能执行绑定操作，请刷新",
        );
      }
    });
    sendJson(res, 200, { ...feishuStatus(context.store.database), ...output });
    return;
  }
  if (path.startsWith("/api/avatars/")) {
    return serveAvatar(
      req,
      res,
      context.dataDir,
      path.slice("/api/avatars/".length),
    );
  }

  // C-614: off-site copy health for the control host; counts only, no secrets.
  if (path === "/api/offsite") {
    if (req.method !== "GET") methodNotAllowed(["GET"]);
    sendJson(res, 200, offsiteFor(context.dataDir)?.status() ?? null);
    return;
  }

  // C-685: the cross-project shared file library; a human session acts here.
  if (path === "/api/shared-files" || path.startsWith("/api/shared-files/"))
    return serveSharedFiles({
      req,
      res,
      url,
      store: context.store,
      dataDir: context.dataDir,
      human: { kind: "human", member_id: session.member_id ?? null },
    });

  // C-638: heap use and limit of the server processes; numbers only.
  if (path === "/api/process-health") {
    if (req.method !== "GET") methodNotAllowed(["GET"]);
    sendJson(res, 200, processHealthView(context.dataDir, context.processRole));
    return;
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
        // C-674: the display code full numbers are written with (`SEN-C-34`).
        code: project.code,
      })),
    });
    return;
  }

  // C-675: a full number typed into a search box (`SEN-C-34`, `SEN-Q-12`,
  // `SEN-H-46`), resolved in the project its code names; null when there is
  // no such project or entity.
  if (path === "/api/refs/resolve") {
    if (req.method !== "GET") methodNotAllowed(["GET"]);
    const id = (url.searchParams.get("id") ?? "").trim();
    const refs = extractQualifiedReferences(id).filter(
      (ref) => ref.qualified === id,
    );
    const [found] = qualifiedReferenceResolver(context.store)(refs).filter(
      (ref) => ref.exists,
    );
    sendJson(res, 200, { reference: found ?? null });
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

const CAPABILITY_GUIDES_ROUTE = /^\/api\/projects\/[^/]+\/capability-guides$/;

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

  if (rest === "/worker-wizards" || rest.startsWith("/worker-wizards/"))
    return context.wizards.serve(req, res, project_id, rest, () =>
      requireSession(context),
    );

  if (rest === "/capability-guides")
    return serveCapabilityGuides(
      { ...context, authorize: () => requireSession(context) },
      project_id,
    );

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
      capacityRevision: () => context.capacity.revision(project_id),
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
    await serveUploads(
      {
        req,
        res,
        url,
        project_id,
        dataDir: context.dataDir,
        authorize: () => requireSession(context),
      },
      rest,
    )
  )
    return;

  if (
    await serveWrite(
      {
        checks: context.checks,
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
    sendJson(res, 200, context.capacity.read(project_id).view);
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
      hasAttempt: async (attempt) => {
        const { value } = await context.read(
          { kind: "precheck_attempt", project: project_id, attempt },
          context.recordTiming,
        );
        if (typeof value !== "string") return false;
        header = value;
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
      hasAttempt: async (attempt) =>
        (
          await context.read(
            { kind: "merge_check_attempt", project: project_id, attempt },
            context.recordTiming,
          )
        ).value === true,
      authorize: () => requireSession(context),
    });
  }

  const thumbnail = /^\/attachments\/([^/]+)\/thumbnail$/.exec(rest);
  if (thumbnail !== null) {
    const served = await serveAttachmentThumbnail({
      store,
      project_id,
      attachment_id: decodeURIComponent(thumbnail[1] ?? ""),
      req,
      res,
      dataDir: context.dataDir,
    });
    if (!served) {
      throw new HttpRejection(404, "not_found", "attachment not found");
    }
    return;
  }

  const poster = /^\/attachments\/([^/]+)\/poster$/.exec(rest);
  if (poster !== null) {
    const served = await serveVideoPoster({
      store,
      project_id,
      attachment_id: decodeURIComponent(poster[1] ?? ""),
      req,
      res,
      dataDir: context.dataDir,
    });
    if (!served) {
      throw new HttpRejection(404, "not_found", "attachment not found");
    }
    return;
  }

  const preview = /^\/attachments\/([^/]+)\/preview$/.exec(rest);
  if (preview !== null) {
    const served = await serveAttachmentPreview({
      store,
      project_id,
      attachment_id: decodeURIComponent(preview[1] ?? ""),
      req,
      res,
      dataDir: context.dataDir,
    });
    if (!served) {
      throw new HttpRejection(404, "not_found", "attachment not found");
    }
    return;
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
    const token = sessionToken(req);
    if (!token) throw new HttpRejection(401, "unauthorized", "需要登录");
    const { body } = await context.read(
      {
        kind: "cards",
        project: project_id,
        url: url.href,
        version: rest === "/cards/version",
        cache: {
          ...context.cardsCache,
          readScope: createHash("sha256")
            .update(`needs-you-read-scope:${token}`)
            .digest("hex"),
        },
      },
      context.recordTiming,
    );
    sendJsonText(res, 200, body ?? "null");
    return;
  }

  // C-615 / V-3070: another card's attachment as a chip of this card. The
  // reference is rechecked on every read (sensitive source card, cross-card
  // reading off); the plain /attachments routes keep their own rules.
  const refFile =
    /^\/cards\/([^/]+)\/attachment-refs\/([^/]+)(\/thumbnail|\/preview|\/poster)?$/.exec(
      rest,
    );
  if (refFile !== null) {
    const card_id = decodeURIComponent(refFile[1] ?? "") as CardId;
    const attachment_id = decodeURIComponent(refFile[2] ?? "");
    const allowed = readAttachmentRefs(
      store,
      project_id,
      card_id,
      attachment_id,
    )?.attachments.some((a) => a.id === attachment_id);
    if (!allowed)
      throw new HttpRejection(404, "not_found", "attachment not found");
    const part = refFile[3];
    const serve =
      part === "/thumbnail"
        ? serveAttachmentThumbnail
        : part === "/preview"
          ? serveAttachmentPreview
          : part === "/poster"
            ? serveVideoPoster
            : serveAttachment;
    const served = await serve({
      store,
      project_id,
      attachment_id,
      req,
      res,
      dataDir: context.dataDir,
    });
    if (!served)
      throw new HttpRejection(404, "not_found", "attachment not found");
    return;
  }

  const attachmentRefs = /^\/cards\/([^/]+)\/attachment-refs$/.exec(rest);
  if (attachmentRefs !== null) {
    const card_id = decodeURIComponent(attachmentRefs[1] ?? "") as CardId;
    const refs = readAttachmentRefs(
      store,
      project_id,
      card_id,
      url.searchParams.get("ids"),
    );
    if (refs === undefined) {
      throw new HttpRejection(404, "not_found", `card ${card_id} not found`);
    }
    sendJson(res, 200, refs);
    return;
  }

  const mentions = /^\/cards\/([^/]+)\/mentions$/.exec(rest);
  if (mentions !== null) {
    const card_id = decodeURIComponent(mentions[1] ?? "") as CardId;
    const candidates = readMentionCandidates(store, project_id, card_id);
    if (candidates === undefined) {
      throw new HttpRejection(404, "not_found", `card ${card_id} not found`);
    }
    sendJson(res, 200, candidates);
    return;
  }

  const card = /^\/cards\/([^/]+)$/.exec(rest);
  if (card !== null) {
    const ifNoneMatch = req.headers["if-none-match"];
    const acceptGzip = /\bgzip\b/.test(
      String(req.headers["accept-encoding"] ?? ""),
    );
    const { body, gzip, etag, notModified } = await context.read(
      {
        kind: "card",
        project: project_id,
        card: decodeURIComponent(card[1] ?? "") as CardId,
        url: url.href,
        mergeGateStatus:
          context.mergeGate?.forProject(project_id).status ?? "disabled",
        now,
        ...(ifNoneMatch ? { ifNoneMatch } : {}),
        ...(acceptGzip ? { acceptGzip } : {}),
      },
      context.recordTiming,
    );
    // C-688: an open detail revalidates; an unchanged card answers 304.
    const validator = etag ? { ETag: etag } : {};
    if (notModified) {
      res.writeHead(304, { "Cache-Control": "no-store", ...validator });
      res.end();
      return;
    }
    if (gzip) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        "Content-Length": gzip.byteLength,
        "Cache-Control": "no-store",
        Vary: "Accept-Encoding",
        ...validator,
      });
      res.end(gzip);
      return;
    }
    sendJsonText(res, 200, body ?? "null", {
      Vary: "Accept-Encoding",
      ...validator,
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
    const { body } = await context.read(
      {
        kind: "execution",
        project: project_id,
        url: url.href,
        now,
        queueWarningMinutes: context.queueWarningMinutes,
        contexts: context.contextUsage?.(project_id),
        capabilityCatalog: capabilityCatalog(context),
      },
      context.recordTiming,
    );
    sendJsonText(res, 200, body ?? "null");
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
    const { body } = await context.read(
      {
        kind: "execution_runs",
        project: project_id,
        assignment: assignmentId,
        before: url.searchParams.get("before") ?? undefined,
      },
      context.recordTiming,
    );
    sendJsonText(res, 200, body ?? "null");
    return;
  }
  if (rest === "/needs-you/version") {
    requireSession(context);
    const token = sessionToken(req);
    if (!token) throw new HttpRejection(401, "unauthorized", "需要登录");
    const { body } = await context.read(
      {
        kind: "needs_version",
        project: project_id,
        now,
        readScope: createHash("sha256")
          .update(`needs-you-read-scope:${token}`)
          .digest("hex"),
        context: JSON.stringify([
          context.needsReadEpoch,
          context.mergeGate?.forProject(project_id).status ?? "disabled",
          context.hostOpsPatrolIntervalMs ?? null,
          context.hcSession ?? null,
          context.runtimeUnknownGraceMs ?? null,
        ]),
        runtimeUnknownGraceMs: context.runtimeUnknownGraceMs,
      },
      context.recordTiming,
    );
    sendJsonText(res, 200, body ?? "null");
    return;
  }
  if (rest === "/needs-you" || rest === "/needs-you/counts") {
    requireSession(context);
    const token = sessionToken(req);
    if (!token) throw new HttpRejection(401, "unauthorized", "需要登录");
    const section = url.searchParams.get("section");
    if (
      section !== null &&
      !["decisions", "merges", "actions", "later", "notices"].includes(section)
    )
      throw new HttpRejection(400, "validation_failed", "Needs You 标签无效");
    const { body } = await context.read(
      {
        kind: "needs",
        project: project_id,
        counts: rest === "/needs-you/counts",
        section: (section ?? undefined) as NeedsYouSection | undefined,
        now,
        mergeGateStatus: context.mergeGate?.forProject(project_id).status,
        projectSettings: context.mergeGate
          ? (mergeProjectSettings(context.mergeGate, project_id) ?? {})
          : undefined,
        hostOpsPatrolIntervalMs: context.hostOpsPatrolIntervalMs,
        hcSession: context.hcSession,
        runtimeUnknownGraceMs: context.runtimeUnknownGraceMs,
      },
      context.recordTiming,
    );
    sendJsonText(res, 200, body ?? "null", {
      "X-Cardigan-Read-At": now,
      "X-Cardigan-Read-Scope": createHash("sha256")
        .update(`needs-you-read-scope:${token}`)
        .digest("hex"),
    });
    return;
  }

  if (rest === "/notices") {
    const { body } = await context.read(
      {
        kind: "notices",
        project: project_id,
        before: url.searchParams.get("before") ?? undefined,
      },
      context.recordTiming,
    );
    sendJsonText(res, 200, body ?? "null");
    return;
  }

  if (rest === "/preferences") {
    const state = store.uow.read((tx) => emptyState(tx, project_id));
    // Preferences do not need project history.
    sendJson(res, 200, {
      ...projectPreferences(state),
      cross_card_read: projectPreferences(state).cross_card_read !== false,
      high_risk_paths: highRiskPaths(projectPreferences(state)),
      human_card_templates: humanCardTemplates(projectPreferences(state)),
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
  if (rest === "/release-notes") {
    sendJson(res, 200, releaseNotesView(state, url));
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
    sendJson(
      context.res,
      200,
      roleList(project_id, versions, context.roleLaunchConfig?.()),
    );
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
          // C-616: lets the comment box refuse an oversized file before posting.
          attachment_max_bytes: MAX_ATTACHMENT_BYTES,
          // C-683: videos go through resumable uploads with their own limit.
          video_max_bytes: uploadSessionsFor(context.dataDir).maxBytes,
          video_chunk_bytes: uploadSessionsFor(context.dataDir).chunkBytes,
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

/** An unreadable catalog declares nothing rather than failing the read. */
function capabilityCatalog(context: RequestContext) {
  if (!context.capabilityCatalog) return undefined;
  try {
    // Keys and platforms only: entries also carry parsers, which never clone.
    return context
      .capabilityCatalog()
      .map(({ key, os }) => ({ key, os: [...os] }));
  } catch {
    return undefined;
  }
}

/**
 * C-774: projects for the read workers to warm at start, those with the most
 * cards first, so the two busiest land on different workers. Best effort.
 */
function warmOrder(store: Store): string[] {
  try {
    return store.database
      .prepare(
        "SELECT p.id AS id FROM projects p LEFT JOIN (SELECT project_id, count(*) AS n FROM cards GROUP BY project_id) c ON c.project_id = p.id ORDER BY COALESCE(c.n, 0) DESC, p.id",
      )
      .all()
      .map((row) => String(row.id));
  } catch {
    return [];
  }
}
