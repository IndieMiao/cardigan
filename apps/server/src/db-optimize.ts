import type { Store } from "@cardigan/store";
import { type LoopStartup, startTimerLoop, type TimerLoop } from "./loop.js";

/**
 * C-793: planner statistics as a fallback only. Hot statements are written to
 * use their indexes without statistics (tests run on unanalyzed databases), so
 * this never replaces an index or a bound `project_id`. Mask 0x10002 checks
 * every table, not just the ones this connection queried: tables never
 * analyzed or whose row count drifted are analyzed, the rest are left alone.
 * The explicit analysis_limit samples each index instead of reading it whole,
 * keeping the write lock short on large tables. Runs once shortly after the
 * background process starts — i.e. after every deployment — and daily.
 */
export const DB_OPTIMIZE_SQL =
  "PRAGMA analysis_limit = 1000; PRAGMA optimize = 0x10002";
export const DEFAULT_DB_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DB_OPTIMIZE_DELAY_MS = 60_000;

export function optimizeDatabase(store: Pick<Store, "database">): void {
  store.database.exec(DB_OPTIMIZE_SQL);
}

export function startDbOptimizeLoop(options: {
  readonly store: Pick<Store, "database">;
  readonly startup?: LoopStartup;
  readonly intervalMs?: number;
  readonly initialDelayMs?: number;
  readonly onError: (error: unknown) => void;
}): TimerLoop {
  return startTimerLoop({
    name: "db-optimize",
    startup: options.startup,
    initialDelayMs: options.initialDelayMs ?? DEFAULT_DB_OPTIMIZE_DELAY_MS,
    intervalMs: options.intervalMs ?? DEFAULT_DB_OPTIMIZE_INTERVAL_MS,
    slowTickMs: 10_000,
    tick: async () => optimizeDatabase(options.store),
    onError: options.onError,
  });
}
