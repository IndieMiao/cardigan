import { loadMergeGateConfig, loadRunCapacityConfig } from "@cardigan/host";
import type { McpBackend } from "@cardigan/mcp-server";
import {
  type Logger,
  type RunningServer,
  startMcpServer,
} from "@cardigan/mcp-server";
import {
  LOCAL_RUNTIME_WARNING,
  resolveExecutionConfig,
  secureDataDirectory,
} from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import {
  type ControlPlane,
  type ControlPlaneOptions,
  startControlPlane,
} from "./assembly.js";
import {
  resolveServerConfig,
  type ServerConfig,
  type ServerEnv,
} from "./config.js";
import { type GitBinding, ServerGit } from "./git.js";
import type { WebConfig } from "./web/config.js";
import { type RunningWebServer, startWebServer } from "./web/server.js";

export interface StartServerOptions {
  readonly env?: ServerEnv;
  readonly config?: ServerConfig;
  /** Inject a store (tests); otherwise one is opened from the config. */
  readonly store?: Store;
  readonly log?: Logger;
  readonly warn?: (message: string) => void;
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
  if (execution.mode === "local")
    (options.warn ?? ((message) => process.stderr.write(`${message}\n`)))(
      LOCAL_RUNTIME_WARNING,
    );
  await secureDataDirectory({ ...execution, dataDir: config.dataDir });
  const store = options.store ?? Store.open({ dataDir: config.dataDir });
  const ownsStore = options.store === undefined;
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
      ...(options.captureAgent === undefined
        ? {}
        : { captureAgent: options.captureAgent }),
    });

  // Assigned once, read from `close()`; the compiler cannot see through the
  // callback, so use `let` with a definite type.
  let mcp: RunningServer;
  try {
    mcp = await startMcpServer({
      // The store satisfies McpBackend structurally; this keeps mcp-server
      // depending on domain only (§20.2).
      store: store as McpBackend,
      dataDir: config.dataDir,
      host: config.host,
      port: config.port,
      // §3.3: production always verifies against the real Git service, and the
      // verifier follows the project the request belongs to.
      deliveryVerifier: git.verifierFor,
      pinDelivery: (request) => git.pinDelivery(request),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
  } catch (error) {
    if (ownsStore) {
      store.close();
    }
    throw error;
  }

  // The control plane runs beside the endpoint; a failure here closes the
  // endpoint again instead of leaving a half-started server.
  let plane: ControlPlane | undefined;
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
      plane = startControlPlane({
        ...options.dispatcher,
        store,
        git,
        mergeGate: { configuration: mergeGate, execution },
        runLimit: runCapacity.forMachine,
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
    } catch (error) {
      await mcp.close();
      if (ownsStore) store.close();
      throw error;
    }
  }

  // The Workbench is a second listener on its own loopback port (§3.1). It
  // shares the store but nothing else: a failure here must not leave a
  // half-started server behind.
  let web: RunningWebServer | undefined;
  if (options.web !== undefined) {
    try {
      web = await startWebServer({
        store,
        mergeGate,
        dataDir: config.dataDir,
        config: options.web.config,
        ...(options.web.log === undefined ? {} : { log: options.web.log }),
        ...(options.web.stream === undefined
          ? {}
          : { stream: options.web.stream }),
      });
    } catch (error) {
      await plane?.stop();
      await mcp.close();
      if (ownsStore) store.close();
      throw error;
    }
  }

  return {
    url: mcp.url,
    host: mcp.host,
    port: mcp.port,
    store,
    ...(web === undefined ? {} : { web }),
    close: async () => {
      // Order matters: stop scheduling and drain the current delivery first,
      // then stop serving the UI, then stop accepting tool calls, then close
      // the database.
      await plane?.stop();
      await web?.close();
      await mcp.close();
      if (ownsStore) {
        store.close();
      }
    },
  };
}
