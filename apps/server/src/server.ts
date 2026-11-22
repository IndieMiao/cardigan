import { join } from "node:path";
import {
  type Assignment,
  type ProjectId,
  tickProfileOn,
} from "@cardigan/domain";
import {
  acquireRepositoryFlock,
  CpuProfileController,
  configureMachinePlacement,
  defaultExtMessagePath,
  enqueueOwnerMessage,
  executorExecution,
  HostOpsService,
  LiveExtMessageSender,
  loadMachineCapabilityCatalog,
  loadMergeGateConfig,
  loadRunCapacityConfig,
  loadRuntimeWorkers,
  MachineLeases,
  machineRunCapacity,
  RuntimeTargets,
  redactFailureLine,
  runtimeWorkerMcpHosts,
  runtimeWorkersPath,
  scrubRunCredentials,
  sessionFingerprint,
  targetProbe,
} from "@cardigan/host";
import type { McpBackend } from "@cardigan/mcp-server";
import {
  defaultToolCatalog,
  type Logger,
  type RunningServer,
  startMcpServer,
  stdoutLogger,
} from "@cardigan/mcp-server";
import {
  DEFAULT_HC_SESSION,
  describeRuntime,
  LOCAL_RUNTIME_WARNING,
  REGISTERED_RUNTIME_FILE,
  readRegisteredRuntime,
  resolveExecutionConfig,
  runtimeOwnsRef,
  secureDataDirectory,
  writeRegisteredRuntime,
} from "@cardigan/runtime-herdr";
import { getRoleVersion, Store, tokensForAssignment } from "@cardigan/store";
import {
  type ControlPlane,
  type ControlPlaneOptions,
  startControlPlane,
} from "./assembly.js";
import { checkArtifact, readCheckApproval } from "./check-handoff-artifact.js";
import { startCheckControl } from "./check-handoff-control.js";
import {
  DEFAULT_LISTEN_RETRY_INTERVAL_MS,
  DEFAULT_LISTEN_RETRY_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  resolveServerConfig,
  type ServerConfig,
  type ServerEnv,
} from "./config.js";
import { DiagnosticsReader } from "./diagnostics-reader.js";
import { type GitBinding, ServerGit } from "./git.js";
import { DEFAULT_HOST_OPS_PATROL_INTERVAL_MS } from "./host-ops-patrol.js";
import type { ShutdownTimer } from "./lifecycle.js";
import { createListenRetry } from "./listen-retry.js";
import { startTimerLoop, type TimerLoop } from "./loop.js";
import { mergeProjectSettings } from "./merge-push-loop.js";
import {
  drainMobileSigning,
  openMobileArtifact,
  requestMobileSignature,
} from "./mobile-signing.js";
import { serverProbes } from "./probes.js";
import { apkPublisher } from "./publish-artifact.js";
import {
  clearTickProfileSync,
  releaseSha,
  setTickProfileSync,
  TickProfiler,
  TickProfileSwitch,
  tickProfileEnabled,
  tickStoreObserver,
} from "./tick-profile.js";
import type { WebConfig } from "./web/config.js";
import { machineHost } from "./web/machine-host.js";
import { readMergeCheckLogRange } from "./web/merge-check-log.js";
import {
  type RunningWebServer,
  startWebServer,
  type WebServerOptions,
} from "./web/server.js";

/**
 * Signing helpers get the shutdown grace minus this margin to finish on their
 * own, then SIGTERM and `MOBILE_SIGNING_TERM_MS` to record `interrupted`; the
 * process exit deadline is the grace plus `SHUTDOWN_EXIT_MARGIN_MS` (C-601).
 */
const MOBILE_SIGNING_DRAIN_MARGIN_MS = 3_000;
const MOBILE_SIGNING_TERM_MS = 2_000;

export interface StartServerOptions {
  /** Explicit production role. Omitted only for embedded single-process callers. */
  readonly role?: "web" | "background";
  /** Activate the launch publisher only while this process owns the dispatch lock. */
  readonly backgroundReady?: Promise<void>;
  readonly onBackgroundOwner?: () => () => void;
  readonly env?: ServerEnv;
  readonly config?: ServerConfig;
  /** Inject a store (tests); otherwise one is opened from the config. */
  readonly store?: Store;
  readonly log?: Logger;
  readonly warn?: (message: string) => void;
  /** Trusted artifact reader port; production uses the built executable identity. */
  readonly checkArtifact?: typeof checkArtifact;
  /**
   * M3.5: the Dispatcher and RuntimeMonitor loops. Omitted in tests that only
   * need the MCP endpoint; `runServer` always provides it.
   */
  readonly dispatcher?: Omit<ControlPlaneOptions, "store" | "git">;
  /**
   * M4.4: the Git assembly. `runServer` passes one that also routes workspace
   * Git through the Agent in agent-ssh mode; tests get the local default.
   */
  readonly git?: GitBinding;
  /**
   * The Agent execution entry. agent-ssh mode cannot run workspace Git without
   * it, so the server refuses to start rather than fall back to the host
   * identity inside an Agent-writable repository (§3.4, §14).
   */
  readonly captureAgent?: (
    command: "git",
    args: readonly string[],
    timeoutMs?: number,
  ) => Promise<
    | { readonly ok: true; readonly value: string }
    | {
        readonly ok: false;
        readonly error: { readonly code: string; readonly message: string };
      }
  >;
  /**
   * M5.1: the Workbench listener. Deliberately a separate listener from the MCP
   * endpoint (§3.1); absent in tests that only exercise the MCP surface.
   */
  readonly web?: {
    readonly launchSettings?: WebServerOptions["launchSettings"];
    readonly config: WebConfig;
    readonly log?: (event: Readonly<Record<string, unknown>>) => void;
    /** SSE cadence; tests shorten it. */
    readonly stream?: {
      readonly pollMs?: number;
      readonly heartbeatMs?: number;
    };
    /** Drives the request grace period after `close()`; tests control it. */
    readonly shutdownTimer?: ShutdownTimer;
  };
}

export interface CardiganServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** The store the MCP endpoint reads and writes. */
  readonly store: Store;
  /** The Workbench listener, when this server was started with one. */
  readonly web?: RunningWebServer;
  close(): Promise<void>;
}

/**
 * Assemble the control plane: open the store (running migrations), hand it to
 * the MCP server as a `McpBackend`, and listen on loopback.
 */
export async function startCardiganServer(
  options: StartServerOptions = {},
): Promise<CardiganServer> {
  if (options.role === "background" && !options.dispatcher)
    throw new Error("Background role requires control-plane wiring");
  if (options.role === "web" || !options.dispatcher)
    return assembleServer(options);
  const config =
    options.config ?? resolveServerConfig(options.env ?? process.env);
  const execution =
    config.execution ??
    resolveExecutionConfig({
      ...(options.env ?? process.env),
      CARDIGAN_DATA_DIR: config.dataDir,
    });
  await secureDataDirectory({ ...execution, dataDir: config.dataDir });
  // Same lifetime as the background process; a crash closes the lock descriptor.
  // Reuse the existing supervisor lock acquisition budget, without retry rules.
  const unlock = await acquireRepositoryFlock(
    join(config.dataDir, "locks", "background.lock"),
    1,
  );
  let stopPublishing: (() => void) | undefined;
  try {
    stopPublishing = options.onBackgroundOwner?.();
    const server = await assembleServer(options);
    return {
      ...server,
      close: async () => {
        await server.close();
        stopPublishing?.();
        await unlock();
      },
    };
  } catch (error) {
    stopPublishing?.();
    await unlock();
    throw error;
  }
}

async function assembleServer(
  options: StartServerOptions,
): Promise<CardiganServer> {
  const config =
    options.config ?? resolveServerConfig(options.env ?? process.env);
  const execution =
    config.execution ??
    resolveExecutionConfig({
      ...(options.env ?? process.env),
      CARDIGAN_DATA_DIR: config.dataDir,
    });
  const runtimeEnv = options.env ?? process.env;
  const session = runtimeEnv.CARDIGAN_HC_SESSION ?? DEFAULT_HC_SESSION;
  // C-155: confirm the data directory is private and host-owned before
  // trusting anything inside it, including the runtime registration.
  await secureDataDirectory({ ...execution, dataDir: config.dataDir });
  // C-152: an existing agent-ssh registration is never downgraded by a shell
  // that merely forgot runtime.env; switching to local must be explicit.
  // Only a missing file means "not registered"; an unreadable or corrupt one
  // might hide an agent-ssh registration, so it stops the start (V-489).
  const previous = await readRegisteredRuntime(config.dataDir).catch(
    (error: unknown) => {
      throw new Error(
        `拒绝启动：无法读取数据目录中已有的运行时登记 ${REGISTERED_RUNTIME_FILE}（${error instanceof Error ? error.message : String(error)}）；它可能记录着 agent-ssh，不能当作未登记。请修复该文件的权限或内容；确认要重新登记时，先把它移走，再用正确的运行环境启动 server。`,
        { cause: error },
      );
    },
  );
  if (
    previous?.mode === "agent-ssh" &&
    execution.mode === "local" &&
    (runtimeEnv.CARDIGAN_RUNTIME_MODE ?? "") === ""
  )
    throw new Error(
      `拒绝启动：数据目录已登记 ${describeRuntime(previous)}，当前环境没有设置 CARDIGAN_RUNTIME_MODE（没有加载 runtime.env）。请加载 runtime.env 后再启动；确实要改为本机模式时显式设置 CARDIGAN_RUNTIME_MODE=local。`,
    );
  if (execution.mode === "local")
    (options.warn ?? ((message) => process.stderr.write(`${message}\n`)))(
      LOCAL_RUNTIME_WARNING,
    );
  if (options.dispatcher?.runtime instanceof RuntimeTargets)
    options.dispatcher.runtime.assertRegistration(execution, session);
  const store = options.store ?? Store.open({ dataDir: config.dataDir });
  const ownsStore = options.store === undefined;
  // C-216: opt-in tick measurement. C-265: the human's `tick-profile`
  // preference turns it on or off at the start of the next loop tick, without
  // a restart; CARDIGAN_TICK_PROFILE=1 still forces it on.
  const warnLine =
    options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sha = releaseSha();
  let cpuProfile: CpuProfileController | undefined;
  const profiles = new TickProfileSwitch({
    forced: tickProfileEnabled(runtimeEnv),
    enabled: () =>
      store.uow.read((tx) =>
        store
          .listProjects()
          .some((project) =>
            tickProfileOn(tx.project_preferences.get(project.id, project.id)),
          ),
      ),
    create: () =>
      new TickProfiler({
        log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
        sha,
      }),
    attach: () => store.observe(tickStoreObserver),
    detach: () => store.observe(undefined),
    onError: (error) =>
      warnLine(
        `性能计时开关读取失败，保持当前状态：${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  const syncProfiles = () => {
    profiles.sync();
    cpuProfile?.sync();
  };
  setTickProfileSync(syncProfiles);
  profiles.sync();
  let profilerStopped = false;
  const stopProfiler = () => {
    if (profilerStopped) return;
    profilerStopped = true;
    clearTickProfileSync(syncProfiles);
    profiles.close();
  };
  // Request latencies go to whichever profiler is installed right now.
  const mcpLog: Logger = (entry) => {
    if (entry.event !== "tool") syncProfiles();
    if (entry.event === "http") {
      if (entry.duration_ms !== undefined)
        profiles.profiler?.request("mcp", entry.duration_ms);
    }
    (options.log ?? stdoutLogger)(entry);
  };
  // M4.5: stamp `standing_mode` on rows written before the field existed, so
  // routing and token issuance only ever read the field.
  store.backfillStandingModes();
  const mergeGate = await loadMergeGateConfig({
    dataDir: config.dataDir,
    baseBranches: Object.fromEntries(
      store.listProjects().map((p) => [p.id, p.base_branch ?? "main"]),
    ),
    projectIds: store.listProjects().map((project) => project.id),
    env: { ...(options.env ?? process.env) },
  });
  const runCapacity = await loadRunCapacityConfig({
    env: { ...(options.env ?? process.env) },
  });
  const targets = options.dispatcher?.runtime;
  const leases = new MachineLeases(
    store,
    runCapacity,
    targetProbe(async (project, machine_id) =>
      targets instanceof RuntimeTargets
        ? (
            await targets.forLaunch(project, {
              machine_id,
              runtime_ref: null,
            })
          ).execution
        : execution,
    ),
    targets instanceof RuntimeTargets
      ? targets.publicationResourceProbe
      : undefined,
  );
  configureMachinePlacement(
    store,
    config.dataDir,
    { ...runtimeEnv },
    runCapacity,
    () => options.dispatcher?.upstream,
  );
  for (const message of [...mergeGate.errors, ...runCapacity.errors])
    (options.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      message,
    );
  // Use the execution that was resolved above (config or environment): the
  // Agent mode decides whether workspace Git may run as the host at all.
  const git =
    options.git ??
    new ServerGit({
      store,
      dataDir: config.dataDir,
      execution,
      ...(options.dispatcher?.runtime instanceof RuntimeTargets
        ? { targets: options.dispatcher.runtime }
        : {}),
      // P2a-12 C: reconcile a project's remote check directories over SSH.
      checkExecutor: (project_id) => {
        const settings = mergeGate.forProject(project_id);
        return settings.status === "enabled" &&
          settings.executor &&
          settings.executor.type !== "github"
          ? executorExecution(settings.executor, execution)
          : undefined;
      },
      ...(config.checkCleanupGraceMs === undefined
        ? {}
        : { checkCleanupGraceMs: config.checkCleanupGraceMs }),
      ...(options.captureAgent === undefined
        ? {}
        : { captureAgent: options.captureAgent }),
    });

  const probes = serverProbes({
    store,
    dataDir: config.dataDir,
    env: runtimeEnv,
    git,
    configuration: mergeGate,
    releaseSha: sha,
  });

  // Assigned once, read from `close()`; the compiler cannot see through the
  // callback, so use `let` with a definite type.
  const hostOpsOptions:
    | ConstructorParameters<typeof HostOpsService>[0]
    | undefined = options.dispatcher
    ? {
        store,
        runtime: options.dispatcher.runtime,
        ...(config.workerInspectionIntervalMs
          ? { workerInspectionIntervalMs: config.workerInspectionIntervalMs }
          : {}),
        workerExecution: (project, machine) => {
          const runtime = options.dispatcher?.runtime;
          if (!(runtime instanceof RuntimeTargets))
            throw new Error("Worker registry unavailable");
          return runtime.resolve(project, machine).execution;
        },
        snapshot: options.dispatcher.snapshot,
        get upstream() {
          return options.dispatcher?.upstream;
        },
        contextUsage: {
          execution,
          cacheDir:
            config.contextUsageCacheDir ??
            join(
              execution.mode === "local"
                ? execution.dataDir
                : execution.agentRoot,
              "shared",
              "context-usage",
            ),
          staleAfterMs: config.contextUsageStaleAfterMs ?? 600_000,
        },
        scrubCredentials: async (project, assignment, ref) => {
          const runtime = options.dispatcher?.runtime;
          const targetExecution =
            runtime instanceof RuntimeTargets && ref
              ? runtime.executionForRef(ref, project)
              : execution;
          await scrubRunCredentials(targetExecution, project, assignment, ref);
          // C-152: a terminal started in local mode left its credentials
          // under the private data directory, not the Agent root.
          if (
            ref &&
            execution.mode !== "local" &&
            ref.runtime_machine === "local"
          )
            await scrubRunCredentials(
              { mode: "local", dataDir: config.dataDir },
              project,
              assignment,
            );
        },
        ownsRuntimeRef: (ref) =>
          options.dispatcher?.runtime instanceof RuntimeTargets
            ? options.dispatcher.runtime.ownsRef(ref)
            : runtimeOwnsRef(execution, ref),
        runtimeLabel: describeRuntime(execution),
        hcSession: session,
        onError: (error) =>
          options.dispatcher?.onError?.(
            new Error(
              `context patrol failed: ${redactFailureLine(error instanceof Error ? error.message : String(error))}`,
            ),
          ),
        settings: (project) => ({
          merge_gate_enabled:
            mergeGate.forProject(project).status === "enabled",
        }),
        ...(options.dispatcher.clock
          ? { clock: options.dispatcher.clock }
          : {}),
      }
    : undefined;
  const hostOps = hostOpsOptions
    ? new HostOpsService(hostOpsOptions)
    : undefined;
  const databaseFile = String(
    store.database.prepare("PRAGMA database_list").get()?.file ?? "",
  );
  const diagnostics =
    hostOpsOptions && options.role !== "background" && databaseFile
      ? new DiagnosticsReader(
          {
            dbPath: databaseFile,
            get upstream() {
              return hostOpsOptions.upstream;
            },
            ...(hostOpsOptions.contextUsage
              ? { contextUsage: hostOpsOptions.contextUsage }
              : {}),
          },
          hostOpsOptions.runtime,
          hostOpsOptions.clock,
        )
      : undefined;
  const listen = createListenRetry({
    intervalMs:
      config.listenRetryIntervalMs ?? DEFAULT_LISTEN_RETRY_INTERVAL_MS,
    timeoutMs: config.listenRetryTimeoutMs ?? DEFAULT_LISTEN_RETRY_TIMEOUT_MS,
    warn: options.warn ?? ((line) => process.stderr.write(`${line}\n`)),
  });
  const mobileSigning =
    options.role !== "background" &&
    execution.mode === "agent-ssh" &&
    runtimeEnv.CARDIGAN_MOBILE_SIGNING === "1";
  let mcp: RunningServer;
  try {
    mcp =
      options.role === "background"
        ? {
            host: config.host,
            port: config.port,
            url: `http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}/mcp`,
            toolCatalog: defaultToolCatalog,
            close: async () => {},
          }
        : await listen(config.port, () =>
            startMcpServer({
              // The store satisfies McpBackend structurally; this keeps mcp-server
              // depending on domain only (§20.2).
              store: store as McpBackend,
              probeHost: probes,
              ...(execution.mode === "agent-ssh" &&
              runtimeEnv.CARDIGAN_ARTIFACT_PUBLICATION === "1"
                ? { publishArtifact: apkPublisher(config.dataDir) }
                : {}),
              ...(mobileSigning
                ? {
                    openMobileArtifact: (scope, id, current) =>
                      openMobileArtifact(config.dataDir, scope, id, current),
                    signMobile: (scope, current) =>
                      requestMobileSignature(config.dataDir, scope, current),
                  }
                : {}),
              enqueueOwnerMessage: (actor, input, revalidate) =>
                enqueueOwnerMessage(store, actor, input, revalidate),
              reserveResource: (actor, input, revalidate) =>
                leases.reserve(
                  actor,
                  input.machine,
                  input.resource,
                  input.starts_at,
                  input.ends_at,
                  () => new Date().toISOString(),
                  { key: input.idempotency_key, revalidate },
                ),
              auditProbeCall: (actor, code) =>
                store.uow.run((tx) => {
                  tx.global_events.append({
                    id: tx.global_ids.nextEventId(),
                    seq: tx.global_ids.nextEventSequence(),
                    actor: { kind: "system" },
                    type: "probe_call",
                    payload: {
                      project_id: actor.project_id,
                      assignment_id: actor.assignment_id,
                      code,
                    },
                    created_at: new Date().toISOString(),
                  });
                }),
              dataDir: config.dataDir,
              ...(config.attachmentInlineBytes === undefined
                ? {}
                : { attachmentInlineBytes: config.attachmentInlineBytes }),
              ...(config.checkLogLimits
                ? { checkLogLimits: config.checkLogLimits }
                : {}),
              checkLogReader: (input) =>
                readMergeCheckLogRange({
                  dataDir: config.dataDir,
                  projectId: input.project_id,
                  attempt: input.attempt_id,
                  offset: input.offset,
                  limit: input.limit,
                }),
              host: config.host,
              port: config.port,
              proxyHosts: (projectId) =>
                runtimeWorkerMcpHosts(
                  loadRuntimeWorkers(
                    config.dataDir,
                    runtimeWorkersPath({ ...runtimeEnv }),
                  ),
                  projectId,
                ),
              projectSettings: (projectId) => ({
                ...mergeProjectSettings(mergeGate, projectId),
                merge_gate_enabled:
                  mergeGate.forProject(projectId).status !== "disabled",
              }),
              runCapacity: () =>
                store.uow.read((tx) =>
                  machineRunCapacity(store, tx, {
                    defaults: runCapacity.forMachine,
                    maximums: runCapacity.maxForMachine,
                    displayName: runCapacity.displayNameForMachine,
                  }),
                ),
              // §3.3: production always verifies against the real Git service, and the
              // verifier follows the project the request belongs to.
              deliveryVerifier: git.verifierFor,
              checkHead: (project) => ({
                head: async (assignment) => {
                  if (!git.checkHead)
                    throw new Error("Check HEAD reader unavailable");
                  return git.checkHead(project, assignment);
                },
              }),
              ...(hostOps
                ? {
                    hostOps: {
                      ...hostOps.tools,
                      ...(diagnostics
                        ? {
                            read: (context, project) =>
                              diagnostics.read(context, project),
                          }
                        : {}),
                    },
                  }
                : {}),
              pinDelivery: (request) => git.pinDelivery(request),
              log: mcpLog,
            }),
          );
  } catch (error) {
    await diagnostics?.close();
    await hostOps?.close();
    stopProfiler();
    if (ownsStore) {
      store.close();
    }
    throw error;
  }

  // The Workbench is a second listener on its own loopback port (§3.1). It
  // shares the store but nothing else: a failure here must not leave a
  // half-started server behind.
  let web: RunningWebServer | undefined;
  const checkHost = machineHost(
    store,
    execution,
    session,
    { ...runtimeEnv },
    () => options.dispatcher?.upstream?.browser?.browsers_path,
  );
  const webOptions = options.web;
  if (webOptions !== undefined && options.role !== "background") {
    try {
      web = await listen(webOptions.config.port, () =>
        startWebServer({
          store,
          mergeGate,
          ...(hostOps
            ? {
                contextUsage: (project) => hostOps.contextUsage(project),
                executionDiagnostics: (project) =>
                  diagnostics
                    ? diagnostics.execution(project)
                    : hostOps.executionDiagnostics(project),
              }
            : {}),
          machineHost: checkHost,
          machineDisplayName: runCapacity.displayNameForMachine,
          resourceLimits: runCapacity.resourcesForMachine,
          capabilityCatalog: () =>
            loadMachineCapabilityCatalog({ ...runtimeEnv }),
          runLimit: runCapacity.forMachine,
          runLimitMaximum: runCapacity.maxForMachine,
          dataDir: config.dataDir,
          config: webOptions.config,
          feishuSettingsPath: defaultExtMessagePath({ ...runtimeEnv }),
          ...(webOptions.launchSettings
            ? { launchSettings: webOptions.launchSettings }
            : {}),
          roleLaunchConfig: () => options.dispatcher?.upstream,
          launchProfiles: () =>
            Object.keys(options.dispatcher?.upstream?.profiles ?? {}),
          hcSession: session,
          ...(config.runtimeUnknownGraceMs === undefined
            ? {}
            : { runtimeUnknownGraceMs: config.runtimeUnknownGraceMs }),
          hostOpsPatrolIntervalMs:
            options.dispatcher?.hostOpsPatrolIntervalMs ??
            config.hostOpsPatrolIntervalMs ??
            DEFAULT_HOST_OPS_PATROL_INTERVAL_MS,
          log: (event) => {
            if (event.event === "web_http") {
              syncProfiles();
              if (typeof event.duration_ms === "number")
                profiles.profiler?.request("web", event.duration_ms);
            }
            (
              webOptions.log ??
              ((line) => process.stdout.write(`${JSON.stringify(line)}\n`))
            )(event);
          },
          ...(webOptions.stream === undefined
            ? {}
            : { stream: webOptions.stream }),
          ...(config.shutdownGraceMs === undefined
            ? {}
            : { shutdownGraceMs: config.shutdownGraceMs }),
          ...(webOptions.shutdownTimer === undefined
            ? {}
            : { shutdownTimer: webOptions.shutdownTimer }),
        }),
      );
    } catch (error) {
      await diagnostics?.close();
      await hostOps?.close();
      await mcp.close();
      stopProfiler();
      if (ownsStore) store.close();
      throw error;
    }
  }

  // Start background work only after every listener is bound. A Web port
  // timeout must not have to drain a merge, dispatch or reconciliation that
  // started during the retry window.
  const startup = Promise.withResolvers<boolean>();
  let plane: ControlPlane | undefined;
  let extLoop: TimerLoop | undefined;
  let probeLoop: TimerLoop | undefined;
  let extSender: LiveExtMessageSender | undefined;
  if (options.dispatcher !== undefined && options.role !== "web") {
    try {
      probeLoop = startTimerLoop({
        name: "probes",
        startup: startup.promise,
        initialDelayMs: 1500,
        intervalMs: 5000,
        slowTickMs: 60000,
        tick: () => probes.tick(),
        onError: () => warnLine("集成探针执行或清理未完成，将重试"),
      });
      const mergeIntervalMs =
          options.dispatcher.mergeIntervalMs ?? config.mergeIntervalMs,
        mergeWatchdogMs =
          options.dispatcher.mergeWatchdogMs ?? config.mergeWatchdogMs,
        frameworkWaitReminderMs =
          options.dispatcher.frameworkWaitReminderMs ??
          config.frameworkWaitReminderMs,
        mergeBlockedReminderMs =
          options.dispatcher.mergeBlockedReminderMs ??
          config.mergeBlockedReminderMs,
        cleanupIntervalMs =
          options.dispatcher.cleanupIntervalMs ?? config.cleanupIntervalMs,
        reconcileIntervalMs =
          options.dispatcher.reconcileIntervalMs ?? config.reconcileIntervalMs,
        backupIntervalMs =
          options.dispatcher.backupIntervalMs ?? config.backupIntervalMs,
        attachmentIntervalMs =
          options.dispatcher.attachmentIntervalMs ??
          config.attachmentIntervalMs;
      const served = mcp;
      plane = startControlPlane({
        machineHost: checkHost,
        // P2a-10 A: the fingerprint comes from the endpoint's own tool set, so
        // it always matches what a new session would list.
        toolCatalog: (assignment, project) => {
          const role = store.uow.read((tx) =>
            getRoleVersion(
              tx,
              project,
              assignment.role_id,
              assignment.role_version,
            ),
          );
          const allowed =
            tokensForAssignment(store.database, project, assignment.id).at(-1)
              ?.allowed_tools ?? role?.allowed_tools;
          // P2a-3: plus the verifier launch-environment revision, so a session
          // launched without the build checkout environment is replaced once.
          return allowed === undefined || role === undefined
            ? undefined
            : sessionFingerprint(
                served.toolCatalog(allowed, assignment),
                role,
                assignment,
              );
        },
        ...(config.providerFailureThreshold !== undefined
          ? { providerFailureThreshold: config.providerFailureThreshold }
          : {}),
        ...(config.providerCooldownMs !== undefined
          ? { providerCooldownMs: config.providerCooldownMs }
          : {}),
        ...options.dispatcher,
        startup: startup.promise,
        ...((options.dispatcher.runtimeFailureLimit ??
          config.runtimeFailureLimit) === undefined
          ? {}
          : {
              runtimeFailureLimit:
                options.dispatcher.runtimeFailureLimit ??
                config.runtimeFailureLimit,
            }),
        ...((options.dispatcher.runtimeUnknownGraceMs ??
          config.runtimeUnknownGraceMs) === undefined
          ? {}
          : {
              runtimeUnknownGraceMs:
                options.dispatcher.runtimeUnknownGraceMs ??
                config.runtimeUnknownGraceMs,
            }),
        ...(hostOps
          ? {
              hostOpsTick: () => hostOps.tick(),
              inspectHarnessActivity: (
                project: ProjectId,
                stopTarget?: Assignment["id"],
                localOnly?: boolean,
              ) =>
                hostOps.inspectHarnessActivity(project, stopTarget, localOnly),
              harnessActivity: (
                project: ProjectId,
                assignment: Assignment["id"],
              ) => hostOps.harnessActivity(project, assignment),
            }
          : {}),
        hostOpsPatrolIntervalMs:
          options.dispatcher.hostOpsPatrolIntervalMs ??
          config.hostOpsPatrolIntervalMs ??
          DEFAULT_HOST_OPS_PATROL_INTERVAL_MS,
        ...((options.dispatcher.intervalMs ?? config.dispatchIntervalMs) ===
        undefined
          ? {}
          : {
              intervalMs:
                options.dispatcher.intervalMs ?? config.dispatchIntervalMs,
            }),
        ...((options.dispatcher.dispatchTimeoutMs ??
          config.dispatchTimeoutMs) === undefined
          ? {}
          : {
              dispatchTimeoutMs:
                options.dispatcher.dispatchTimeoutMs ??
                config.dispatchTimeoutMs,
            }),
        store,
        git,
        mergeGate: {
          configuration: mergeGate,
          execution,
          ...(config.recoveryInspectionIntervalMs === undefined
            ? {}
            : {
                recoveryInspectionIntervalMs:
                  config.recoveryInspectionIntervalMs,
              }),
        },
        runLimit: runCapacity.forMachine,
        runLimitMaximum: runCapacity.maxForMachine,
        leases,
        projectQuota: runCapacity.projectQuota,
        resourceLimits: runCapacity.resourcesForMachine,
        queuedRecheckAfterMs: runCapacity.queuedRecheckAfterMs,
        inboxStallAfterMs: runCapacity.inboxStallAfterMs,
        inactiveCancelAfterMs: runCapacity.inactiveCancelAfterMs,
        // Test overrides win; otherwise the server configuration decides.
        ...(mergeIntervalMs === undefined ? {} : { mergeIntervalMs }),
        ...(mergeWatchdogMs === undefined ? {} : { mergeWatchdogMs }),
        ...(frameworkWaitReminderMs === undefined
          ? {}
          : { frameworkWaitReminderMs }),
        ...(mergeBlockedReminderMs === undefined
          ? {}
          : { mergeBlockedReminderMs }),
        ...(cleanupIntervalMs === undefined ? {} : { cleanupIntervalMs }),
        ...(reconcileIntervalMs === undefined ? {} : { reconcileIntervalMs }),
        ...(backupIntervalMs === undefined ? {} : { backupIntervalMs }),
        ...(attachmentIntervalMs === undefined ? {} : { attachmentIntervalMs }),
        // The blob GC sweeps `<dataDir>/attachments`; §9.3.
        dataDir: config.dataDir,
      });
      extSender = new LiveExtMessageSender(
        defaultExtMessagePath({ ...runtimeEnv }),
        {
          store,
          gate: (project) => ({
            ...mergeProjectSettings(mergeGate, project),
            merge_gate_enabled:
              mergeGate.forProject(project).status !== "disabled",
          }),
        },
      );
      extSender.start();
      const notificationSender = extSender;
      extLoop = startTimerLoop({
        name: "ext-message",
        startup: startup.promise,
        initialDelayMs: 1000,
        intervalMs:
          options.dispatcher.intervalMs ?? config.dispatchIntervalMs ?? 1000,
        tick: () => notificationSender.tick(),
        onError: () => options.warn?.("外部通知循环失败，将在下一轮恢复"),
      });
    } catch (error) {
      startup.resolve(false);
      await Promise.allSettled([
        extSender?.stop(),
        extLoop?.stop(),
        probeLoop?.stop(),
        plane?.stop(),
      ]);
      await web?.close();
      await diagnostics?.close();
      await hostOps?.close();
      await mcp.close();
      stopProfiler();
      if (ownsStore) store.close();
      throw error;
    }
  }

  let checkControl: Awaited<ReturnType<typeof startCheckControl>> | undefined;
  // C-152: register only once every listener is up, so a failed or
  // competing start (e.g. EADDRINUSE) cannot replace the live server's entry.
  try {
    if (
      process.platform === "linux" &&
      options.role !== "web" &&
      options.dispatcher &&
      git instanceof ServerGit
    ) {
      const artifact = options.checkArtifact ?? checkArtifact;
      const startupArtifact = await artifact().catch(() => {
        (options.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
          "检查移交已禁用（artifact_unavailable）：启动制品身份核验失败。请修复制品后重新启动控制进程；普通 Run/Web 继续运行。",
        );
        return undefined;
      });
      checkControl = await startCheckControl({
        store,
        git: Object.freeze({
          projectOf: git.projectOf.bind(git),
          verifyCheckCandidate: git.verifyCheckCandidate.bind(git),
          distribute: git.distribute.bind(git),
        }),
        execution,
        configuration: mergeGate,
        freshConfiguration: () =>
          loadMergeGateConfig({
            dataDir: config.dataDir,
            baseBranches: Object.fromEntries(
              store.listProjects().map((p) => [p.id, p.base_branch ?? "main"]),
            ),
            projectIds: store.listProjects().map((p) => p.id),
            env: { ...(options.env ?? process.env) },
          }),
        approval: () => readCheckApproval(config.dataDir),
        artifact,
        startupArtifact,
      });
    }
    if (options.role !== "background")
      await writeRegisteredRuntime(config.dataDir, execution, session);
  } catch (error) {
    startup.resolve(false);
    await checkControl?.close();
    await web?.close();
    await Promise.allSettled([
      extSender?.stop(),
      extLoop?.stop(),
      probeLoop?.stop(),
      plane?.stop(),
    ]);
    await diagnostics?.close();
    await hostOps?.close();
    await mcp.close();
    stopProfiler();
    if (ownsStore) store.close();
    throw error;
  }

  // Only explicit split-process roles register targets. Missing release identity
  // disables this optional diagnostic; it never weakens the ordinary server.
  if (options.role === "web" || options.role === "background") {
    try {
      cpuProfile = new CpuProfileController({
        dataDir: config.dataDir,
        role: options.role,
        sha,
        notice: (code) => warnLine(`cpu_profile_${code}`),
      });
    } catch {
      warnLine("cpu_profile_unavailable");
    }
  }
  // runServer releases this only after handlers are installed and stdout reports ready.
  // Embedded servers without a supervisor use completion of their own initialization.
  if (options.backgroundReady)
    void options.backgroundReady.then(() => startup.resolve(true));
  else startup.resolve(true);
  return {
    url: mcp.url,
    host: mcp.host,
    port: mcp.port,
    store,
    ...(web === undefined ? {} : { web }),
    close: async () => {
      // The Workbench closes first, alongside the control plane: it stops
      // accepting connections and ends every SSE stream at once, so an open
      // browser tab cannot hold the restart while the phase loops drain their
      // current tick (a merge is never cut in half). In-flight requests get
      // the grace period. The MCP endpoint and the store close after both.
      const results = await Promise.allSettled([
        cpuProfile?.close(),
        checkControl?.close(),
        web?.close(),
        plane?.stop(),
        extSender?.stop(),
        extLoop?.stop(),
        probeLoop?.stop(),
        // C-601: in-flight signing helpers end inside the shutdown grace (a
        // margin before the forced exit), never as orphans of this process.
        mobileSigning
          ? drainMobileSigning({
              waitMs:
                (config.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS) -
                MOBILE_SIGNING_DRAIN_MARGIN_MS,
              killMs: MOBILE_SIGNING_TERM_MS,
            })
          : undefined,
      ]);
      await diagnostics?.close();
      await hostOps?.close();
      await mcp.close();
      stopProfiler();
      if (ownsStore) {
        store.close();
      }
      const failed = results.find((result) => result.status === "rejected");
      if (failed !== undefined) throw failed.reason;
    },
  };
}
