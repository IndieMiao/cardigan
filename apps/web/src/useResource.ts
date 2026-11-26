import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "./api.js";
import { isReadOverload } from "./service-retry.js";

/**
 * C-775: an automatic read joins one still in flight for at most this long
 * instead of starting a second one. Longer than the client's whole overload
 * retry schedule (three ~30 s attempts plus 5 + 15 s), so a hung request
 * cannot freeze the page's live updates for good.
 */
export const RESOURCE_JOIN_MAX_MS = 120_000;

/** Ignore abandoned requests; a refresh keeps forms mounted, a new project never shows old data. */
export function useResource<T>(
  load: () => Promise<T>,
  revision = 0,
  enabled = true,
) {
  const version = useRef(0);
  // C-775: the read in flight for `source`; automatic reads asked for meanwhile
  // run once after it settles instead of piling up on a slow server.
  const inflight = useRef<
    | {
        request: number;
        source: typeof load;
        startedAt: number;
        again: boolean;
      }
    | undefined
  >(undefined);
  // C-775: after the server stayed overloaded through every retry, automatic
  // reads of this source wait for an explicit retry instead of loading again.
  const paused = useRef<typeof load | undefined>(undefined);
  const [state, setState] = useState<{
    source: typeof load;
    data?: T;
    error?: string;
    pending: boolean;
    interactive: boolean;
  }>({ source: load, pending: true, interactive: false });
  const start = useCallback(
    (interactive: boolean) => {
      const running = inflight.current;
      if (!interactive) {
        if (paused.current === load) return;
        if (
          running?.source === load &&
          running.request === version.current &&
          Date.now() - running.startedAt < RESOURCE_JOIN_MAX_MS
        ) {
          running.again = true;
          return;
        }
      }
      paused.current = undefined;
      const request = ++version.current;
      inflight.current = {
        request,
        source: load,
        startedAt: Date.now(),
        again: false,
      };
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
      const settle = (overloaded: boolean) => {
        const current = inflight.current;
        if (current?.request !== request) return;
        inflight.current = undefined;
        if (overloaded) paused.current = load;
        else if (current.again) start(false);
      };
      load().then(
        (data) => {
          if (request !== version.current) return;
          setState({
            source: load,
            data,
            pending: false,
            interactive: false,
          });
          settle(false);
        },
        (error) => {
          if (request !== version.current) return;
          setState((old) => ({
            ...old,
            error: describeError(error),
            pending: false,
          }));
          settle(isReadOverload(error));
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
  // A new source, unmount or disable abandons the read in flight; a revision
  // alone does not (the next effect joins or follows it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the source identity is the reset signal.
  useEffect(() => {
    if (!enabled) return;
    return () => {
      ++version.current;
      inflight.current = undefined;
    };
  }, [start, enabled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit external invalidation signal.
  useEffect(() => {
    if (enabled) start(false);
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
