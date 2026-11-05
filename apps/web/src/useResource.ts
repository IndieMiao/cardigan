import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "./api.js";

/** Ignore abandoned requests; a refresh keeps forms mounted, a new project never shows old data. */
export function useResource<T>(load: () => Promise<T>, revision = 0) {
  const version = useRef(0);
  const [state, setState] = useState<{
    source: typeof load;
    data?: T;
    error?: string;
    pending: boolean;
  }>({ source: load, pending: true });
  const reload = useCallback(() => {
    const request = ++version.current;
    setState((old) => ({
      source: load,
      ...(old.source === load && old.data !== undefined
        ? { data: old.data }
        : {}),
      pending: true,
    }));
    load().then(
      (data) => {
        if (request === version.current)
          setState({ source: load, data, pending: false });
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
  }, [load]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit external invalidation signal.
  useEffect(() => {
    reload();
    return () => {
      ++version.current;
    };
  }, [reload, revision]);
  return {
    data: state.source === load ? state.data : undefined,
    error: state.source === load ? state.error : undefined,
    pending: state.source !== load || state.pending,
    reload,
  };
}
