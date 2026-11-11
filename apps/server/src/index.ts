import { stdoutLogger } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  resolveServerConfig,
  type ServerEnv,
} from "./config.js";
import { createHostWiring } from "./host.js";
import {
  installShutdownHandlers,
  SHUTDOWN_EXIT_MARGIN_MS,
  type ShutdownTimer,
  type SignalHost,
  systemShutdownTimer,
} from "./lifecycle.js";
import { type CardiganServer, startCardiganServer } from "./server.js";
import { resolveWebConfig } from "./web/config.js";

export interface RunServerOptions {
  readonly env?: ServerEnv;
  readonly log?: (line: string) => void;
}

export interface ShutdownOptions {
  readonly server: Pick<CardiganServer, "close">;
  readonly store: Pick<Store, "close">;
  readonly write: (line: string) => void;
  /** Request grace period; the process exits at most a margin later. */
  readonly graceMs: number;
  readonly signals?: SignalHost;
  readonly timer?: ShutdownTimer;
  /** Ends the process when the close is cut off; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
}

/**
 * Wait for SIGTERM/SIGINT, close the server and resolve with the exit code.
 *
 * The process lifetime is bounded, not just `server.close()`: in-flight
 * requests get `graceMs`, and `SHUTDOWN_EXIT_MARGIN_MS` later the process
 * exits no matter what is still alive — a phase loop stuck in its tick, or a
 * timer a cut-off request left behind after the listeners closed. The deadline
 * is never cancelled; its timer does not keep the process alive, so a clean
 * shutdown simply ends before it fires. When the close itself did not finish,
 * the store is left open — the loops may still be using it, SQLite recovers on
 * the next start, and the existing startup rules mark a cut-off merge check
 * interrupted and queue it again.
 */
export function awaitShutdown(options: ShutdownOptions): Promise<number> {
  const { server, store, write } = options;
  const timer = options.timer ?? systemShutdownTimer;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  return new Promise<number>((resolve) => {
    installShutdownHandlers(options.signals ?? process, (signal) => {
      write(JSON.stringify({ shutting_down: signal }));
      let code: number | undefined;
      const finish = (value: number): void => {
        if (code !== undefined) return;
        code = value;
        resolve(value);
      };
      timer(options.graceMs + SHUTDOWN_EXIT_MARGIN_MS, () => {
        const closed = code !== undefined;
        write(
          JSON.stringify({
            shutdown_forced: signal,
            ...(closed ? { after_close: true } : {}),
          }),
        );
        finish(1);
        exit(code ?? 1);
      });
      let closing: Promise<void>;
      try {
        closing = server.close();
      } catch (error) {
        closing = Promise.reject(error);
      }
      closing.then(
        () => {
          if (code !== undefined) return;
          store.close();
          finish(0);
        },
        (error: unknown) => {
          if (code !== undefined) return;
          write(JSON.stringify({ shutdown_failed: String(error) }));
          store.close();
          finish(1);
        },
      );
    });
  });
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
  // Resolved before the store is opened: a non-loopback Workbench address is a
  // startup error, not a listener that comes up in the wrong place (§3.1).
  const webConfig = resolveWebConfig(env);
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
      // Workspace Git in agent-ssh mode runs as the agent account (§12.6);
      // the Git assembly is built by startCardiganServer from the same
      // resolved execution it uses for the rest of startup.
      captureAgent: (command, args, timeout) =>
        host.runtime.captureAgent(command, args, timeout),
      web: { config: webConfig },
      dispatcher: {
        runtime: host.runtime,
        snapshot: host.snapshot,
        startRun: host.startRun,
        beforeWake: host.beforeWake,
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

  write(
    JSON.stringify({
      ready: true,
      url: server.url,
      ...(server.web === undefined ? {} : { web_url: server.web.url }),
    }),
  );

  return awaitShutdown({
    server,
    store,
    write,
    graceMs: config.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
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
export {
  configDir,
  createHostWiring,
  type HostEnv,
  type HostWiring,
  loadLaunchFiles,
} from "./host.js";
export {
  installShutdownHandlers,
  SHUTDOWN_EXIT_MARGIN_MS,
  SHUTDOWN_SIGNALS,
  type ShutdownTimer,
  systemShutdownTimer,
} from "./lifecycle.js";
export { type CardiganServer, startCardiganServer } from "./server.js";
export {
  allowedHosts,
  DEFAULT_WEB_PORT,
  resolveWebConfig,
  type WebConfig,
  type WebEnv,
} from "./web/config.js";
export {
  type RunningWebServer,
  startWebServer,
  type WebServerOptions,
} from "./web/server.js";
