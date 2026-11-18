import { useEffect, useState } from "react";
import {
  DEFAULT_REFRESH_INTERVAL,
  REFRESH_INTERVALS,
} from "./components/RefreshGroup.js";

function readInterval(key: string): number {
  try {
    const stored = localStorage.getItem(key);
    const value = stored === null ? DEFAULT_REFRESH_INTERVAL : Number(stored);
    return REFRESH_INTERVALS.some((option) => option === value)
      ? value
      : DEFAULT_REFRESH_INTERVAL;
  } catch {
    return DEFAULT_REFRESH_INTERVAL;
  }
}

/**
 * Page-owned periodic refresh for RefreshGroup: the choice persists under
 * `key`, a pending or hidden page skips the tick, and 0 turns it off.
 */
export function useRefreshInterval(
  key: string,
  pending: boolean,
  reload: () => void,
): readonly [number, (interval: number) => void] {
  const [choice, setChoice] = useState(() => ({
    key,
    value: readInterval(key),
  }));
  const interval = choice.key === key ? choice.value : readInterval(key);
  useEffect(() => {
    if (!interval) return;
    const timer = window.setInterval(() => {
      if (!pending && !document.hidden) reload();
    }, interval);
    return () => window.clearInterval(timer);
  }, [interval, pending, reload]);
  return [
    interval,
    (next: number) => {
      setChoice({ key, value: next });
      try {
        localStorage.setItem(key, String(next));
      } catch {
        /* Optional preference. */
      }
    },
  ];
}
