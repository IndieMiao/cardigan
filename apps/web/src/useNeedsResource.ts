import { useCallback, useEffect, useRef, useState } from "react";
import type { CardiganClient, NeedsCounts } from "./api.js";
import { useResource } from "./useResource.js";

/** The shell loads counts only; the active Needs You tab loads its own content. */
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
        ? client.needsYouCounts(project, key.current)
        : Promise.resolve<NeedsCounts>({
            total_pending: 0,
            tabs: {
              decisions: { count: 0, attention: 0 },
              merges: { count: 0, attention: 0 },
              actions: { count: 0, attention: 0 },
              later: { count: 0, attention: 0 },
              notices: { count: 0, attention: 0 },
            },
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
