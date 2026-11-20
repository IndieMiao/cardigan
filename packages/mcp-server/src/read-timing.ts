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
