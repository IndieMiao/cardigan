import { stdoutLogger } from "@cardigan/mcp-server";
import type { ServerEnv } from "./config.js";
import { installShutdownHandlers } from "./lifecycle.js";
import { startCardiganServer } from "./server.js";

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
  const server = await startCardiganServer({ env, log: stdoutLogger });

  write(JSON.stringify({ ready: true, url: server.url }));

  return new Promise<number>((resolve) => {
    installShutdownHandlers(process, (signal) => {
      write(JSON.stringify({ shutting_down: signal }));
      void server.close().then(
        () => resolve(0),
        (error: unknown) => {
          write(JSON.stringify({ shutdown_failed: String(error) }));
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
