import { AsyncLocalStorage } from "node:async_hooks";

/** Request-local profiling: fixed operation names and durations, no card content. */
export type RecordReadTiming = (stage: string, ms: number) => void;
export function timeRead<T>(
  record: RecordReadTiming | undefined,
  stage: string,
  read: () => T,
): T {
  if (!record) return read();
  const start = performance.now();
  try {
    return read();
  } finally {
    record(stage, performance.now() - start);
  }
}

/**
 * C-774: where one read spends its time on command state. `state_ms` is every
 * outermost `loadCommandState` call (cache checks included); `rebuild_ms` is
 * the part that rebuilt the cached state because a version moved.
 */
export interface CommandStateTiming {
  state_ms: number;
  rebuild_ms: number;
}

interface Meter extends CommandStateTiming {
  loads: number;
  builds: number;
}

const meters = new AsyncLocalStorage<Meter>();

/** Runs `read` (sync or async) and reports its command-state time to `done`. */
export function measureCommandState<T>(
  read: () => T,
  done: (timing: CommandStateTiming) => void,
): T {
  const meter: Meter = {
    state_ms: 0,
    rebuild_ms: 0,
    loads: 0,
    builds: 0,
  };
  const report = () =>
    done({
      state_ms: meter.state_ms,
      rebuild_ms: meter.rebuild_ms,
    });
  let result: T;
  try {
    result = meters.run(meter, read);
  } catch (error) {
    report();
    throw error;
  }
  if (result instanceof Promise) return result.finally(report) as unknown as T;
  report();
  return result;
}

/** Nested calls count once, in their outermost caller. */
function metered<T>(
  read: () => T,
  depth: "loads" | "builds",
  total: "state_ms" | "rebuild_ms",
): T {
  const meter = meters.getStore();
  if (!meter || meter[depth] > 0) return read();
  meter[depth]++;
  const start = performance.now();
  try {
    return read();
  } finally {
    meter[depth]--;
    meter[total] += performance.now() - start;
  }
}

export const meterStateLoad = <T>(read: () => T): T =>
  metered(read, "loads", "state_ms");
export const meterStateBuild = <T>(read: () => T): T =>
  metered(read, "builds", "rebuild_ms");
