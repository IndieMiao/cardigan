import { useCallback, useEffect, useState } from "react";

/**
 * Hash routing (M5 plan §2: no routing library).
 *
 * The Workbench has three screens and one project parameter; a twelve-line
 * parser over `location.hash` is less code than the smallest router dependency,
 * and it keeps every URL shareable and reload-safe.
 */

export type Route =
  | { readonly kind: "board"; readonly projectId: string }
  | {
      readonly kind:
        | "list"
        | "needs-you"
        | "snapshot"
        | "execution"
        | "activity";
      readonly projectId: string;
    }
  | {
      readonly kind: "card";
      readonly projectId: string;
      readonly cardId: string;
      /** Element to scroll to after the card page renders (e.g. `decision-q(2)`). */
      readonly anchor?: string;
    };

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * `#/p/<project>/board`, `#/p/<project>/list`,
 * `#/p/<project>/cards/<card>?at=<anchor>`.
 *
 * The location anchor is a query parameter of the card route, not a second
 * `#fragment`: the hash is the route itself, so `#decision-q(2)` would replace
 * the route and send the Workbench to its fallback project (M5.S S23).
 */
export function parseRoute(hash: string): Route | undefined {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "");
  const segments = path.split("/").filter((part) => part.length > 0);
  if (segments[0] !== "p") return undefined;
  const projectId = segments[1] === undefined ? undefined : decode(segments[1]);
  if (projectId === undefined) return undefined;
  if (segments.length === 3 && segments[2] === "board") {
    return { kind: "board", projectId };
  }
  if (
    segments.length === 3 &&
    (segments[2] === "list" ||
      segments[2] === "needs-you" ||
      segments[2] === "snapshot" ||
      segments[2] === "execution" ||
      segments[2] === "activity")
  ) {
    return { kind: segments[2], projectId };
  }
  if (segments.length === 4 && segments[2] === "cards") {
    const [cardSegment = "", query = ""] = (segments[3] ?? "").split("?", 2);
    const cardId = decode(cardSegment);
    if (cardId === undefined) return undefined;
    const anchor = new URLSearchParams(query).get("at");
    return {
      kind: "card",
      projectId,
      cardId,
      ...(anchor === null || anchor.length === 0 ? {} : { anchor }),
    };
  }
  return undefined;
}

export function routeHash(route: Route): string {
  const project = encodeURIComponent(route.projectId);
  if (route.kind === "card") {
    const path = `#/p/${project}/cards/${encodeURIComponent(route.cardId)}`;
    return route.anchor === undefined
      ? path
      : `${path}?at=${encodeURIComponent(route.anchor)}`;
  }
  return `#/p/${project}/${route.kind}`;
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
export function useRoute(): [
  Route | undefined,
  (route: Route) => void,
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

  const navigate = useCallback((next: Route) => {
    const hash = routeHash(next);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
    setRoute(next);
    setInvalidHash(undefined);
  }, []);

  return [route, navigate, invalidHash];
}
