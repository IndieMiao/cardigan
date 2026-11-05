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
      readonly kind: "list" | "needs-you" | "snapshot" | "execution";
      readonly projectId: string;
    }
  | {
      readonly kind: "card";
      readonly projectId: string;
      readonly cardId: string;
    };

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** `#/p/<project>/board`, `#/p/<project>/list`, `#/p/<project>/cards/<card>`. */
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
      segments[2] === "execution")
  ) {
    return { kind: segments[2], projectId };
  }
  if (segments.length === 4 && segments[2] === "cards") {
    const cardId = decode(segments[3] ?? "");
    if (cardId === undefined) return undefined;
    return { kind: "card", projectId, cardId };
  }
  return undefined;
}

export function routeHash(route: Route): string {
  const project = encodeURIComponent(route.projectId);
  if (route.kind === "card") {
    return `#/p/${project}/cards/${encodeURIComponent(route.cardId)}`;
  }
  return `#/p/${project}/${route.kind}`;
}

const currentHash = (): string =>
  typeof window === "undefined" ? "" : window.location.hash;

export function useRoute(): [Route | undefined, (route: Route) => void] {
  const [route, setRoute] = useState<Route | undefined>(() =>
    parseRoute(currentHash()),
  );

  useEffect(() => {
    const sync = (): void => setRoute(parseRoute(currentHash()));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const navigate = useCallback((next: Route) => {
    const hash = routeHash(next);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
    setRoute(next);
  }, []);

  return [route, navigate];
}
