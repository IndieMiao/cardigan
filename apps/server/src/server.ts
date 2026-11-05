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
}

export interface CardiganServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** The store the MCP endpoint reads and writes. */
  readonly store: Store;
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
  const git =
    options.git ??
    new ServerGit({
      store,
      dataDir: config.dataDir,
      ...(config.execution === undefined
        ? {}
        : { execution: config.execution }),
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
      plane = startControlPlane({
        ...options.dispatcher,
        store,
        git,
      });
    } catch (error) {
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
    close: async () => {
      // Order matters: stop scheduling and drain the current delivery first,
      // then stop accepting tool calls, then close the database.
      await plane?.stop();
      await mcp.close();
      if (ownsStore) {
        store.close();
      }
    },
  };
}
