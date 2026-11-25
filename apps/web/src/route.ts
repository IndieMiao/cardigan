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
        | "decision-history"
        | "release-notes"
        | "shared-files";
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
      segments[2] === "decision-history" ||
      segments[2] === "release-notes" ||
      segments[2] === "shared-files")
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

  const navigate = useCallback((next: Route, options?: NavigateOptions) => {
    const hash = routeHash(next);
    if (window.location.hash !== hash) {
      if (options?.replace) window.location.replace(hash);
      else window.location.hash = hash;
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
