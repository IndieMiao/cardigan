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
