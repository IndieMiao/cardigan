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

/** Wraps a settings read so its start can be compared with writes. */
export function trackSettingsRead<T extends object>(read: Promise<T>) {
  const at = ++clock;
  return read.then((data) => {
    readStarts.set(data, at);
    return data;
  });
}

/** When the read that produced `source` started, if it was tracked. */
export const readStart = (source: unknown) =>
  typeof source === "object" && source !== null
    ? readStarts.get(source)
    : undefined;
