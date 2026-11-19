/**
 * Ordering instead of server versions (C-455, Q-928): a logical clock stamps
 * when each settings read starts and when each write starts and ends. A read
 * that started before a setting's last write ended is old for that setting;
 * the view reads again. A failure is void when a read that started after the
 * write began already shows its value. Shared by every read a settings write
 * is compared with: preferences and the execution capacity (C-479).
 */
let clock = 0;
const readStarts = new WeakMap<object, number>();

/** Next tick of the logical clock (write start and end). */
export const settingsTick = () => ++clock;

/** One project's setting, as keyed by saves, failures and confirmations. */
export const settingKey = (project: string, id: string) => `${project}:${id}`;

type Confirmation = (key: string, at: number, value: unknown) => void;
const confirmations = new Set<Confirmation>();
/** Called for every setting value a tracked read shows (see `values`). */
export function onSettingsRead(listener: Confirmation) {
  confirmations.add(listener);
  return () => confirmations.delete(listener);
}

/**
 * Wraps a settings read so its start can be compared with writes. `values`
 * lists the settings the read shows (key and value): they confirm writes and
 * retire failure notices even when no view of the setting is mounted, e.g.
 * the shared capacity read after the settings page was left (C-479).
 */
export function trackSettingsRead<T extends object>(
  read: Promise<T>,
  values?: (data: T) => Iterable<readonly [string, unknown]>,
) {
  const at = ++clock;
  return read.then((data) => {
    readStarts.set(data, at);
    if (values)
      for (const [key, value] of values(data))
        for (const listener of confirmations) listener(key, at, value);
    return data;
  });
}

/** When the read that produced `source` started, if it was tracked. */
export const readStart = (source: unknown) =>
  typeof source === "object" && source !== null
    ? readStarts.get(source)
    : undefined;
