import { join } from "node:path";
import {
  type Assignment,
  type ProjectId,
  tickProfileOn,
} from "@cardigan/domain";
import {
  ExtMessageSender,
  executorExecution,
  HostOpsService,
  loadExtMessageConfig,
  loadMergeGateConfig,
  loadRunCapacityConfig,
  machineRunCapacity,
  RuntimeTargets,
  redactFailureLine,
  scrubRunCredentials,
  sessionFingerprint,
} from "@cardigan/host";
import type { McpBackend } from "@cardigan/mcp-server";
import {
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
  resolveServerConfig,
  type ServerConfig,
  type ServerEnv,
} from "./config.js";
import { type GitBinding, ServerGit } from "./git.js";
import { DEFAULT_HOST_OPS_PATROL_INTERVAL_MS } from "./host-ops-patrol.js";
import type { ShutdownTimer } from "./lifecycle.js";
import { createListenRetry } from "./listen-retry.js";
import { startTimerLoop, type TimerLoop } from "./loop.js";
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
import { type RunningWebServer, startWebServer } from "./web/server.js";

export interface StartServerOptions {
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
  const syncProfiles = () => profiles.sync();
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
    if (entry.event === "http" && entry.duration_ms !== undefined)
      profiles.profiler?.request("mcp", entry.duration_ms);
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
      // P2a-12 C: reconcile a project's remote check directories over SSH.
      checkExecutor: (project_id) => {
        const settings = mergeGate.forProject(project_id);
        return settings.status === "enabled" && settings.executor
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

  // Assigned once, read from `close()`; the compiler cannot see through the
  // callback, so use `let` with a definite type.
  const hostOps = options.dispatcher
    ? new HostOpsService({
        store,
        runtime: options.dispatcher.runtime,
        snapshot: options.dispatcher.snapshot,
        ...(options.dispatcher.upstream
          ? { upstream: options.dispatcher.upstream }
          : {}),
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
      })
    : undefined;
  const listen = createListenRetry({
    intervalMs:
      config.listenRetryIntervalMs ?? DEFAULT_LISTEN_RETRY_INTERVAL_MS,
    timeoutMs: config.listenRetryTimeoutMs ?? DEFAULT_LISTEN_RETRY_TIMEOUT_MS,
    warn: options.warn ?? ((line) => process.stderr.write(`${line}\n`)),
  });
  let mcp: RunningServer;
  try {
    mcp = await listen(config.port, () =>
      startMcpServer({
        // The store satisfies McpBackend structurally; this keeps mcp-server
        // depending on domain only (§20.2).
        store: store as McpBackend,
        dataDir: config.dataDir,
        host: config.host,
        port: config.port,
        projectSettings: (projectId) => ({
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
        ...(hostOps ? { hostOps: hostOps.tools } : {}),
        pinDelivery: (request) => git.pinDelivery(request),
        log: mcpLog,
      }),
    );
  } catch (error) {
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
  const webOptions = options.web;
  if (webOptions !== undefined) {
    try {
      web = await listen(webOptions.config.port, () =>
        startWebServer({
          store,
          mergeGate,
          ...(hostOps
            ? { contextUsage: (project) => hostOps.contextUsage(project) }
            : {}),
          machineDisplayName: runCapacity.displayNameForMachine,
          runLimit: runCapacity.forMachine,
          runLimitMaximum: runCapacity.maxForMachine,
          dataDir: config.dataDir,
          config: webOptions.config,
          hcSession: session,
          ...(config.runtimeUnknownGraceMs === undefined
            ? {}
            : { runtimeUnknownGraceMs: config.runtimeUnknownGraceMs }),
          hostOpsPatrolIntervalMs:
            options.dispatcher?.hostOpsPatrolIntervalMs ??
            config.hostOpsPatrolIntervalMs ??
            DEFAULT_HOST_OPS_PATROL_INTERVAL_MS,
          log: (event) => {
            if (
              event.event === "web_http" &&
              typeof event.duration_ms === "number"
            )
              profiles.profiler?.request("web", event.duration_ms);
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
  let plane: ControlPlane | undefined;
  let extLoop: TimerLoop | undefined;
  let extSender: ExtMessageSender | undefined;
  if (options.dispatcher !== undefined) {
    try {
      const mergeIntervalMs =
          options.dispatcher.mergeIntervalMs ?? config.mergeIntervalMs,
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
        ...options.dispatcher,
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
        mergeGate: { configuration: mergeGate, execution },
        runLimit: runCapacity.forMachine,
        runLimitMaximum: runCapacity.maxForMachine,
        inactiveCancelAfterMs: runCapacity.inactiveCancelAfterMs,
        // Test overrides win; otherwise the server configuration decides.
        ...(mergeIntervalMs === undefined ? {} : { mergeIntervalMs }),
        ...(cleanupIntervalMs === undefined ? {} : { cleanupIntervalMs }),
        ...(reconcileIntervalMs === undefined ? {} : { reconcileIntervalMs }),
        ...(backupIntervalMs === undefined ? {} : { backupIntervalMs }),
        ...(attachmentIntervalMs === undefined ? {} : { attachmentIntervalMs }),
        // The blob GC sweeps `<dataDir>/attachments`; §9.3.
        dataDir: config.dataDir,
      });
      extSender = new ExtMessageSender({
        store,
        configuration: loadExtMessageConfig(),
      });
      extSender.recordStatus();
      const notificationSender = extSender;
      extLoop = startTimerLoop({
        name: "ext-message",
        intervalMs:
          options.dispatcher.intervalMs ?? config.dispatchIntervalMs ?? 1000,
        tick: () => notificationSender.tick(),
        onError: () => options.warn?.("外部通知循环失败，将在下一轮恢复"),
      });
    } catch (error) {
      await Promise.allSettled([
        extSender?.stop(),
        extLoop?.stop(),
        plane?.stop(),
      ]);
      await web?.close();
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
    await writeRegisteredRuntime(config.dataDir, execution, session);
  } catch (error) {
    await checkControl?.close();
    await web?.close();
    await Promise.allSettled([
      extSender?.stop(),
      extLoop?.stop(),
      plane?.stop(),
    ]);
    await hostOps?.close();
    await mcp.close();
    stopProfiler();
    if (ownsStore) store.close();
    throw error;
  }

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
        checkControl?.close(),
        web?.close(),
        plane?.stop(),
        extSender?.stop(),
        extLoop?.stop(),
      ]);
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
