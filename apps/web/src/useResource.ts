import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "./api.js";

/** Ignore abandoned requests; a refresh keeps forms mounted, a new project never shows old data. */
export function useResource<T>(
  load: () => Promise<T>,
  revision = 0,
  enabled = true,
) {
  const version = useRef(0);
  const [state, setState] = useState<{
    source: typeof load;
    data?: T;
    error?: string;
    pending: boolean;
    interactive: boolean;
  }>({ source: load, pending: true, interactive: false });
  const start = useCallback(
    (interactive: boolean) => {
      const request = ++version.current;
      setState((old) => ({
        source: load,
        ...(old.source === load && old.data !== undefined
          ? { data: old.data }
          : {}),
        pending: true,
        interactive:
          interactive ||
          (old.source === load && old.pending && old.interactive),
      }));
      load().then(
        (data) => {
          if (request === version.current)
            setState({
              source: load,
              data,
              pending: false,
              interactive: false,
            });
        },
        (error) => {
          if (request === version.current)
            setState((old) => ({
              ...old,
              error: describeError(error),
              pending: false,
            }));
        },
      );
    },
    [load],
  );
  const reload = useCallback(() => start(true), [start]);
  /** Periodic background read: quiet unless it outlasts the slow threshold. */
  const refresh = useCallback(() => start(false), [start]);
  /** Show data read outside `load` (e.g. an older page) without abandoning a read in flight. */
  const replace = useCallback(
    (data: T) =>
      setState((old) => (old.source === load ? { ...old, data } : old)),
    [load],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit external invalidation signal.
  useEffect(() => {
    if (!enabled) return;
    start(false);
    return () => {
      ++version.current;
    };
  }, [start, revision, enabled]);
  return {
    data: state.source === load ? state.data : undefined,
    error: state.source === load ? state.error : undefined,
    pending: state.source !== load || state.pending,
    interactive: state.source === load && state.interactive,
    reload,
    refresh,
    replace,
  };
}
