/** The subset of `process` needed to install signal handlers. */
export interface SignalHost {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Close the server on SIGTERM/SIGINT, and ignore further signals while the
 * shutdown runs so a second Ctrl+C does not kill the process mid-close.
 */
export function installShutdownHandlers(
  host: SignalHost,
  shutdown: (signal: NodeJS.Signals) => void,
  signals: readonly NodeJS.Signals[] = SHUTDOWN_SIGNALS,
): () => void {
  const installed: Array<[NodeJS.Signals, () => void]> = [];

  for (const signal of signals) {
    const handler = (): void => {
      remove();
      shutdown(signal);
    };
    host.once(signal, handler);
    installed.push([signal, handler]);
  }

  const remove = (): void => {
    for (const [signal, handler] of installed.splice(0)) {
      host.off(signal, handler);
    }
  };

  return remove;
}

/** Run `fire` after `ms`; the returned function cancels it. */
export type ShutdownTimer = (ms: number, fire: () => void) => () => void;

/** A real timer that never keeps the process alive on its own. */
export const systemShutdownTimer: ShutdownTimer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

/**
 * Extra time after the request grace period for the listeners and the store to
 * close normally before the process gives up and exits.
 */
export const SHUTDOWN_EXIT_MARGIN_MS = 2_000;
