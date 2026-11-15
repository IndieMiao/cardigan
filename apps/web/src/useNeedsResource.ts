import { useCallback, useEffect, useRef, useState } from "react";
import type { CardiganClient } from "./api.js";
import { useResource } from "./useResource.js";

/** One shell resource feeds both the global count and the Needs You list. */
export function useNeedsResource(
  client: CardiganClient,
  project: string | undefined,
  revision: number,
  invalidation: string,
) {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  const key = useRef<string | undefined>(invalidation);
  key.current = invalidation;
  const load = useCallback(
    () =>
      project
        ? client.needsYou(project, key.current)
        : Promise.resolve({
            decisions: [],
            human_actions: [],
            incidents: [],
            attention: [],
          }),
    [client, project],
  );
  const resource = useResource(
    load,
    revision,
    visible && project !== undefined,
  );
  const reload = () => {
    // Explicit retry or a completed write always asks for a fresh read.
    key.current = undefined;
    resource.reload();
  };
  return { ...resource, reload };
}
