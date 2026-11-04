import type { McpBackend } from "@cardigan/mcp-server";
import {
  type Logger,
  type RunningServer,
  startMcpServer,
} from "@cardigan/mcp-server";
import {
  LOCAL_RUNTIME_WARNING,
  resolveExecutionConfig,
} from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import {
  resolveServerConfig,
  type ServerConfig,
  type ServerEnv,
} from "./config.js";

export interface StartServerOptions {
  readonly env?: ServerEnv;
  readonly config?: ServerConfig;
  /** Inject a store (tests); otherwise one is opened from the config. */
  readonly store?: Store;
  readonly log?: Logger;
  readonly warn?: (message: string) => void;
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
  const store = options.store ?? Store.open({ dataDir: config.dataDir });
  const ownsStore = options.store === undefined;

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
      ...(options.log === undefined ? {} : { log: options.log }),
    });
  } catch (error) {
    if (ownsStore) {
      store.close();
    }
    throw error;
  }

  return {
    url: mcp.url,
    host: mcp.host,
    port: mcp.port,
    store,
    close: async () => {
      await mcp.close();
      if (ownsStore) {
        store.close();
      }
    },
  };
}
