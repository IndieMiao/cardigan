import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "./api.js";
import { isReadOverload } from "./service-retry.js";

/**
 * C-775: an automatic read joins one still in flight for at most this long
 * instead of starting a second one. Well past a ~30 s `read_timeout` plus the
 * ~15 s restart schedule, so a hung request cannot freeze the page's live
 * updates for good.
 */
export const RESOURCE_JOIN_MAX_MS = 120_000;

/**
 * C-775: after the server refuses a read as overloaded, automatic reads of
 * that resource wait this long. Changes asked for meanwhile are read once
 * when it ends (keeping the failure shown until that read succeeds), so a
 * resource without a retry button, such as the Needs You count, still
 * recovers; an explicit retry reads at once. Default chosen by the author.
 */
export const RESOURCE_OVERLOAD_COOLDOWN_MS = 30_000;

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
  // C-775: the overload cooldown of `source`: until `until`, automatic reads
  // only set `wanted`, and the timer reads once when it ends.
  const cooling = useRef<
    | {
        source: typeof load;
        until: number;
        wanted: boolean;
        timer?: number | undefined;
      }
    | undefined
  >(undefined);
  const [state, setState] = useState<{
    source: typeof load;
    data?: T;
    error?: string;
    /** C-775: the error is the server refusing the read as overloaded. */
    overloaded?: boolean;
    pending: boolean;
    interactive: boolean;
  }>({ source: load, pending: true, interactive: false });
  const start = useCallback(
    (interactive: boolean) => {
      const running = inflight.current;
      const cool =
        cooling.current?.source === load ? cooling.current : undefined;
      // Read after an overload cooldown: keep the failure shown meanwhile.
      let resumed = false;
      if (!interactive) {
        if (cool) {
          if (Date.now() < cool.until) {
            cool.wanted = true;
            cool.timer ??= window.setTimeout(() => {
              cool.timer = undefined;
              if (cooling.current !== cool || !cool.wanted) return;
              cool.until = 0;
              start(false);
            }, cool.until - Date.now());
            return;
          }
          resumed = true;
        }
        if (
          running?.source === load &&
          running.request === version.current &&
          Date.now() - running.startedAt < RESOURCE_JOIN_MAX_MS
        ) {
          running.again = true;
          return;
        }
      }
      if (cooling.current?.timer !== undefined)
        window.clearTimeout(cooling.current.timer);
      cooling.current = undefined;
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
        ...(resumed && old.source === load && old.error !== undefined
          ? { error: old.error, overloaded: old.overloaded }
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
        if (overloaded) {
          cooling.current = {
            source: load,
            until: Date.now() + RESOURCE_OVERLOAD_COOLDOWN_MS,
            wanted: false,
          };
          // Changes that arrived during the failed read wait out the cooldown.
          if (current.again) start(false);
        } else if (current.again) start(false);
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
          const overloaded = isReadOverload(error);
          setState((old) => ({
            ...old,
            error: describeError(error),
            overloaded,
            pending: false,
          }));
          settle(overloaded);
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
  // A new source, unmount or disable abandons the read in flight and the
  // cooldown timer; a revision alone does not (the next effect joins or
  // follows it). The cooldown itself outlives a disable, so showing a hidden
  // tab again reads once it ends.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the source identity is the reset signal.
  useEffect(() => {
    if (!enabled) return;
    return () => {
      ++version.current;
      inflight.current = undefined;
      const cool = cooling.current;
      if (cool?.timer !== undefined) {
        window.clearTimeout(cool.timer);
        cool.timer = undefined;
      }
    };
  }, [start, enabled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit external invalidation signal.
  useEffect(() => {
    if (enabled) start(false);
  }, [start, revision, enabled]);
  return {
    data: state.source === load ? state.data : undefined,
    error: state.source === load ? state.error : undefined,
    /** C-775: `error` is the server refusing the read as overloaded. */
    overloaded: state.source === load && state.overloaded === true,
    pending: state.source !== load || state.pending,
    interactive: state.source === load && state.interactive,
    reload,
    refresh,
    replace,
  };
}
