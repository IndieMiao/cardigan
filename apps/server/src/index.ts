import { stdoutLogger } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { resolveServerConfig, type ServerEnv } from "./config.js";
import { ServerGit } from "./git.js";
import { createHostWiring } from "./host.js";
import { installShutdownHandlers } from "./lifecycle.js";
import { type CardiganServer, startCardiganServer } from "./server.js";

export interface RunServerOptions {
  readonly env?: ServerEnv;
  readonly log?: (line: string) => void;
}

/**
 * Start the server, print its address, and shut down cleanly on SIGTERM.
 *
 * Resolves with the exit code once a signal arrives, so the caller (bin) decides
 * when the process ends.
 */
export async function runServer(
  options: RunServerOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const write =
    options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const config = resolveServerConfig(env);
  // One Store for the endpoint, the router and the dispatcher: they share the
  // same write lock and see each other's commits immediately.
  const store = Store.open({ dataDir: config.dataDir });
  let server: CardiganServer;
  try {
    const host = await createHostWiring({
      env,
      store,
      dataDir: config.dataDir,
      ...(config.execution === undefined
        ? {}
        : { execution: config.execution }),
    });
    server = await startCardiganServer({
      config,
      env,
      store,
      log: stdoutLogger,
      git: new ServerGit({
        store,
        dataDir: config.dataDir,
        ...(config.execution === undefined
          ? {}
          : { execution: config.execution }),
        // Workspace Git in agent-ssh mode runs as the agent account (§12.6).
        captureAgent: (command, args) =>
          host.runtime.captureAgent(command, args),
      }),
      dispatcher: {
        runtime: host.runtime,
        snapshot: host.snapshot,
        startRun: host.startRun,
        standing: host.standing,
        onError: (error) =>
          write(
            JSON.stringify({
              dispatch_error:
                error instanceof Error ? error.message : String(error),
            }),
          ),
      },
    });
  } catch (error) {
    store.close();
    throw error;
  }

  write(JSON.stringify({ ready: true, url: server.url }));

  return new Promise<number>((resolve) => {
    installShutdownHandlers(process, (signal) => {
      write(JSON.stringify({ shutting_down: signal }));
      void server.close().then(
        () => {
          store.close();
          resolve(0);
        },
        (error: unknown) => {
          write(JSON.stringify({ shutdown_failed: String(error) }));
          store.close();
          resolve(1);
        },
      );
    });
  });
}

export {
  resolveServerConfig,
  type ServerConfig,
  type ServerEnv,
} from "./config.js";
export { Dispatcher, type DispatcherOptions } from "./dispatch.js";
export {
  acknowledgeInbox,
  routeProjectEvents,
  routeStreamEvents,
  type StandingResolver,
} from "./dispatch-inbox.js";
export {
  type DispatchLoop,
  type DispatchLoopOptions,
  startDispatchLoop,
} from "./dispatch-loop.js";
export {
  type RuntimeEventSource,
  RuntimeMonitor,
  type RuntimeMonitorOptions,
} from "./dispatch-monitor.js";
export { installShutdownHandlers, SHUTDOWN_SIGNALS } from "./lifecycle.js";
export { type CardiganServer, startCardiganServer } from "./server.js";
