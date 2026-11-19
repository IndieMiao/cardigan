import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Hash routing (M5 plan §2: no routing library).
 *
 * Views, filters and card anchors share one hash route. No routing dependency;
 * copied URLs and browser history restore the same selection.
 */

export type Route = (
  | {
      readonly kind: "merge-batch";
      readonly projectId: string;
      readonly batchId: string;
    }
  | { readonly kind: "board"; readonly projectId: string }
  | {
      readonly kind:
        | "cards"
        | "list"
        | "needs-you"
        | "snapshot"
        | "execution"
        | "activity"
        | "settings"
        | "help"
        | "decision-history";
      readonly projectId: string;
    }
  | {
      readonly kind: "card";
      readonly projectId: string;
      readonly cardId: string;
      /** Element to scroll to after the card page renders (e.g. `decision-Q-2`). */
      readonly anchor?: string;
    }
) & { readonly filters?: Readonly<Record<string, string>> };

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * `#/p/<project>/cards?view=list|board&card=<card>`,
 * `#/p/<project>/cards/<card>?at=<anchor>`.
 *
 * `board` and `list` are legacy routes the shell redirects to `cards`.
 *
 * The location anchor is a query parameter of the card route, not a second
 * `#fragment`: the hash is the route itself, so `#decision-Q-2` would replace
 * the route and send the Workbench to its fallback project (M5.S S23).
 */
/** C-132: `decision-q(2)` / `human-action-h(3)` from old links → `decision-Q-2` / `human-action-H-3`. */
function legacyAnchor(anchor: string | null): string | null {
  return (
    anchor
      ?.replace(/^decision-q\(([1-9][0-9]*)\)$/u, "decision-Q-$1")
      .replace(/^human-action-h\(([1-9][0-9]*)\)$/u, "human-action-H-$1") ??
    null
  );
}

export function parseRoute(hash: string): Route | undefined {
  const [path = "", query = ""] = hash
    .replace(/^#/, "")
    .replace(/^\/+/, "")
    .split("?", 2);
  const params = new URLSearchParams(query);
  const filters = Object.fromEntries(
    [...params].filter(([k, v]) => k !== "at" && v),
  );
  const filtered = Object.keys(filters).length ? { filters } : {};
  const segments = path.split("/").filter((part) => part.length > 0);
  if (segments[0] !== "p") return undefined;
  const projectId = segments[1] === undefined ? undefined : decode(segments[1]);
  if (projectId === undefined) return undefined;
  if (segments.length === 3 && segments[2] === "board") {
    return { kind: "board", projectId, ...filtered };
  }
  if (segments.length === 3 && segments[2] === "cards") {
    return { kind: "cards", projectId, ...filtered };
  }
  if (
    segments.length === 3 &&
    (segments[2] === "list" ||
      segments[2] === "needs-you" ||
      segments[2] === "snapshot" ||
      segments[2] === "execution" ||
      segments[2] === "activity" ||
      segments[2] === "settings" ||
      segments[2] === "help" ||
      segments[2] === "decision-history")
  ) {
    return { kind: segments[2], projectId, ...filtered };
  }
  if (segments.length === 4 && segments[2] === "merge-batches") {
    const batchId = decode(segments[3] ?? "");
    if (!batchId || !/^MB-[1-9][0-9]*$/u.test(batchId)) return undefined;
    return { kind: "merge-batch", projectId, batchId };
  }
  if (segments.length === 4 && segments[2] === "cards") {
    const cardSegment = segments[3] ?? "";
    const cardId = decode(cardSegment);
    if (cardId === undefined) return undefined;
    const anchor = legacyAnchor(params.get("at"));
    return {
      kind: "card",
      projectId,
      cardId,
      ...filtered,
      ...(anchor === null || anchor.length === 0 ? {} : { anchor }),
    };
  }
  return undefined;
}

export function routeHash(route: Route): string {
  const project = encodeURIComponent(route.projectId);
  const path =
    route.kind === "merge-batch"
      ? `#/p/${project}/merge-batches/${encodeURIComponent(route.batchId)}`
      : route.kind === "card"
        ? `#/p/${project}/cards/${encodeURIComponent(route.cardId)}`
        : `#/p/${project}/${route.kind}`;
  const params = Object.entries(route.filters ?? {}).filter(
    ([, value]) => value,
  );
  if (route.kind === "card" && route.anchor !== undefined)
    params.push(["at", route.anchor]);
  const query = params
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
  return query ? `${path}?${query}` : path;
}

const currentHash = (): string =>
  typeof window === "undefined" ? "" : window.location.hash;

const isUnparseable = (hash: string): boolean =>
  hash.length > 0 && hash !== "#" && parseRoute(hash) === undefined;

/**
 * Navigation hold (C-455): while a page finishes work (a setting that is still
 * saving) the reader stays on it. The latest attempt to leave is remembered
 * and carried out by `release(true)`; `release(false)` drops it and stays.
 *
 * - Hash links are intercepted on click, so the decision is made when the
 *   reader clicks, whatever the work does before `hashchange` runs.
 * - `navigate()` and work deferred with `deferWhileHeld` are remembered.
 * - Back/forward cannot be cancelled: the step is undone by traversing back
 *   to the held entry (marked in `history.state`), so no history entry is
 *   rewritten, and redone the same way after success.
 */
const HOLD_MARK = "cardiganHold";
/** Position of each entry this app created, so a jump's size is known. */
const ENTRY = "cardiganEntry";
type State = Record<string, unknown> | null;
const stamp = (key: string, value: unknown) =>
  history.replaceState(
    { ...((history.state as State) ?? {}), [key]: value },
    "",
  );
const entryOf = (state: unknown) => {
  const at = (state as State)?.[ENTRY];
  return typeof at === "number" ? at : undefined;
};
let entry = 0;

type Restore = {
  /** Offset from the entry the reader went to; the held entry is found at `pos`. */
  pos: number;
  order: number[];
  /** Offsets known to lie past either end of history. */
  up: number;
  down: number;
  target?: number | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
  redo: { delta: number };
};
let hold:
  | {
      home: string;
      mark: string;
      entry: number;
      leave?: (() => void) | undefined;
      restoring?: Restore | undefined;
      /** Set when released during a restore; applied once it ends. */
      released?: boolean | undefined;
    }
  | undefined;

const atHome = () =>
  hold !== undefined && (history.state as State)?.[HOLD_MARK] === hold.mark;

function finish(proceed: boolean) {
  const leave = hold?.leave;
  hold = undefined;
  if (proceed) leave?.();
}

/** Steps to the next candidate offset until the held entry is reached. */
function seek() {
  const restoring = hold?.restoring;
  if (!restoring) return;
  const next = restoring.order.find(
    (t) => t !== restoring.pos && t <= restoring.up && t >= restoring.down,
  );
  restoring.order = restoring.order.filter((t) => t !== next);
  if (next === undefined) return lost();
  restoring.target = next;
  // A step past either end of history fires no event.
  restoring.timer = setTimeout(() => {
    if (hold?.restoring !== restoring) return;
    if (next > restoring.pos) restoring.up = next - 1;
    else restoring.down = next + 1;
    seek();
  }, 150);
  history.go(next - restoring.pos);
}

/**
 * The held entry is no longer in this tab's history (not expected in use):
 * stay on the page without touching history and drop the way out.
 */
function lost() {
  if (!hold) return;
  hold.restoring = undefined;
  hold.leave = undefined;
  if (hold.released !== undefined) finish(false);
}

function onHashChange() {
  const known = entryOf(history.state);
  if (!hold) {
    // A new entry has no position yet: it follows the one it was pushed from.
    if (known === undefined) {
      entry += 1;
      stamp(ENTRY, entry);
    } else entry = known;
    return;
  }
  const restoring = hold.restoring;
  if (restoring) {
    clearTimeout(restoring.timer);
    if (restoring.target !== undefined) restoring.pos = restoring.target;
  }
  if (atHome()) {
    if (!restoring) return;
    hold.restoring = undefined;
    // From the held entry, the reader's choice lies the opposite way.
    restoring.redo.delta = -restoring.pos;
    if (hold.released !== undefined) finish(hold.released);
    return;
  }
  if (restoring) return seek();
  // The reader went back or forward while held: return, then redo the same
  // step once saved. Recorded now, so a later choice replaces it.
  const redo = { delta: 0 };
  hold.leave = () => {
    if (redo.delta) history.go(redo.delta);
  };
  const exact = known === undefined ? undefined : hold.entry - known;
  const order: number[] = exact === undefined ? [] : [exact];
  for (let n = 1; n <= 100; n += 1) order.push(n, -n);
  hold.restoring = { pos: 0, order, up: Infinity, down: -Infinity, redo };
  seek();
}

function onClick(event: MouseEvent) {
  if (!hold || event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (!(link instanceof HTMLAnchorElement)) return;
  if (link.target && link.target !== "_self") return;
  const href = link.getAttribute("href") ?? "";
  if (!href.startsWith("#") || href === hold.home) return;
  event.preventDefault();
  hold.leave = () => {
    window.location.hash = href;
  };
}

if (
  typeof window !== "undefined" &&
  typeof history !== "undefined" &&
  typeof document !== "undefined"
) {
  const known = entryOf(history.state);
  if (known === undefined) stamp(ENTRY, entry);
  else entry = known;
  // Registered before any route listener, so a held step never renders.
  window.addEventListener("hashchange", onHashChange);
  document.addEventListener("click", onClick, true);
}

export function holdNavigation(): (proceed: boolean) => void {
  const mark = `${Date.now()}-${Math.random()}`;
  stamp(HOLD_MARK, mark);
  const mine = { home: currentHash(), mark, entry };
  hold = mine;
  return (proceed) => {
    if (hold !== mine) return;
    if (hold.restoring) hold.released = proceed;
    else finish(proceed);
  };
}

/** Test isolation only: drop any hold without leaving. */
export function resetNavigationHold() {
  if (hold?.restoring) clearTimeout(hold.restoring.timer);
  hold = undefined;
}

/**
 * Runs `go` now when nothing holds the page; otherwise remembers it as the
 * latest way to leave and returns false.
 */
export function deferWhileHeld(go: () => void): boolean {
  if (!hold) return true;
  hold.leave = go;
  return false;
}

const held = (hash: string) => hold !== undefined && hash !== hold.home;

/**
 * The route plus an invalid-hash flag.
 *
 * An unparseable hash must not silently send the reader to another project:
 * when a page is already open we keep it, and only an initial bad URL (with no
 * page to keep) reports `invalidHash` so the shell can explain itself.
 */
export interface NavigateOptions {
  /** Replace the current history entry, e.g. when normalising a stale link. */
  readonly replace?: boolean;
}

export function useRoute(): [
  Route | undefined,
  (route: Route, options?: NavigateOptions) => void,
  string | undefined,
] {
  const [route, setRoute] = useState<Route | undefined>(() =>
    parseRoute(currentHash()),
  );
  const [invalidHash, setInvalidHash] = useState<string | undefined>(() =>
    isUnparseable(currentHash()) ? currentHash() : undefined,
  );

  useEffect(() => {
    const sync = (): void => {
      const hash = currentHash();
      if (held(hash)) return;
      const next = parseRoute(hash);
      if (next !== undefined) {
        setRoute(next);
        setInvalidHash(undefined);
        return;
      }
      if (hash.length === 0 || hash === "#") {
        setRoute(undefined);
        setInvalidHash(undefined);
        return;
      }
      // Keep the current screen; the URL alone is what could not be parsed.
      setInvalidHash(hash);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const navigate = useCallback(function go(
    next: Route,
    options?: NavigateOptions,
  ) {
    const hash = routeHash(next);
    if (held(hash) && !deferWhileHeld(() => go(next, options))) return;
    if (window.location.hash !== hash) {
      if (options?.replace) {
        window.location.replace(hash);
        // A replaced entry keeps its position.
        stamp(ENTRY, entry);
      } else window.location.hash = hash;
    }
    setRoute(next);
    setInvalidHash(undefined);
  }, []);

  return [route, navigate, invalidHash];
}

/** Each view restores its own filters, including browser back/forward navigation. */
export function useRouteFilters(fallback: Route) {
  const [route, navigate] = useRoute();
  const selected =
    route?.projectId === fallback.projectId && route.kind === fallback.kind
      ? route
      : fallback;
  const serialized = JSON.stringify(selected.filters ?? {});
  const filters = useMemo(
    () => JSON.parse(serialized) as Record<string, string>,
    [serialized],
  );
  return [
    filters,
    (next: Record<string, string>, options?: NavigateOptions) =>
      navigate(
        {
          // A new filter selection stops spotlighting an old card anchor.
          ...(selected.kind === "card"
            ? {
                kind: selected.kind,
                projectId: selected.projectId,
                cardId: selected.cardId,
              }
            : selected),
          filters: Object.fromEntries(
            Object.entries(next).filter(([, value]) => value),
          ),
        },
        options,
      ),
  ] as const;
}
