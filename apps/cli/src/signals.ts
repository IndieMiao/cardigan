import type { SignalHost, SpawnedChild } from "./io.js";

/**
 * Signals the parent ignores while the harness CLI runs.
 *
 * The terminal delivers Ctrl+C (SIGINT) and Ctrl+\ (SIGQUIT) to the whole
 * foreground process group, so the child already gets them. If the parent
 * exited here, its `finally` would delete the settings file the child is still
 * reading, and the shell would take the terminal back while the child runs.
 */
export const IGNORED_SIGNALS = ["SIGINT", "SIGQUIT"] as const;

/** Signals the parent forwards to the child, then keeps waiting for it. */
export const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/**
 * Install handlers for the duration of one child process. Returns a function
 * that removes them again, restoring the parent's default signal behaviour.
 *
 * Pure with respect to the process: it only talks to `host` and `child`, so it
 * can be tested with a fake `EventEmitter` outside the test runner's process.
 */
export function forwardSignals(
  child: SpawnedChild,
  host: SignalHost,
): () => void {
  const installed: Array<[NodeJS.Signals, () => void]> = [];

  for (const signal of IGNORED_SIGNALS) {
    const handler = (): void => {
      // Intentionally empty: installing a listener is what suppresses Node's
      // default "exit immediately" behaviour for these signals.
    };
    host.on(signal, handler);
    installed.push([signal, handler]);
  }

  for (const signal of FORWARDED_SIGNALS) {
    const handler = (): void => {
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between the signal and the forward.
      }
    };
    host.on(signal, handler);
    installed.push([signal, handler]);
  }

  return () => {
    for (const [signal, handler] of installed) {
      host.off(signal, handler);
    }
  };
}
