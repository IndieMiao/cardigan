import { useEffect, useState } from "react";
import type { CardiganClient } from "./api.js";
import type { StreamStatus } from "./stream.js";

const initial = (project: string | undefined) => ({
  project,
  revision: 0,
  connectionRevision: 0,
  contextRevision: 0,
  streams: new Map<string, number>(),
  status: "connecting" as StreamStatus,
});
/** One stream per selected project; coalesce bursts and keep card-local invalidations separate. */
export function useProjectStream(
  client: CardiganClient,
  project: string | undefined,
  expired: () => void | Promise<void>,
) {
  const [state, setState] = useState(() => initial(project));
  useEffect(() => {
    setState(initial(project));
    if (!project) return;
    let disposed = false,
      opened = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed) return;
        const changes = [...pending],
          ready = opened;
        pending.clear();
        opened = false;
        setState((old) => {
          const current = old.project === project ? old : initial(project),
            streams = new Map(current.streams);
          // One shared clock also orders events for dependencies discovered
          // after a pending card read; independent stream counts could tie.
          for (const stream of changes)
            streams.set(stream, current.revision + 1);
          const next = {
            ...current,
            revision: current.revision + 1,
            connectionRevision: ready
              ? current.revision + 1
              : current.connectionRevision,
            streams,
          };
          return next;
        });
      }, 100);
    };
    const stop = client.subscribe(project, {
      ready: () => {
        opened = true;
        schedule();
      },
      change: (event) => {
        pending.add(event.stream);
        schedule();
      },
      // C-232: context samples only refresh the execution view, never the
      // card or board reads that follow `revision`.
      context: () => {
        if (disposed) return;
        setState((old) =>
          old.project === project
            ? { ...old, contextRevision: old.contextRevision + 1 }
            : old,
        );
      },
      status: (status) => {
        if (disposed) return;
        setState((old) => ({ ...old, status }));
        if (status === "retrying")
          void client.session().then(
            (session) => {
              if (!disposed && !session.authenticated) void expired();
            },
            () => {},
          );
      },
    });
    return () => {
      disposed = true;
      stop();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, project, expired]);
  const current = state.project === project ? state : initial(project);
  return {
    revision: current.revision,
    contextRevision: current.contextRevision,
    status: current.status,
    cardRevision: (id: string, affectedCards: readonly string[] = []) =>
      [...new Set([id, ...affectedCards])].reduce(
        (latest, card) => Math.max(latest, current.streams.get(card) ?? 0),
        Math.max(
          current.connectionRevision,
          current.streams.get("project") ?? 0,
        ),
      ),
  };
}
