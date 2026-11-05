import { useEffect, useState } from "react";
import type { CardiganClient } from "./api.js";
import type { StreamStatus } from "./stream.js";

const initial = (project: string | undefined) => ({
  project,
  revision: 0,
  connections: 0,
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
          for (const stream of changes)
            streams.set(stream, (streams.get(stream) ?? 0) + 1);
          const next = {
            ...current,
            revision: current.revision + 1,
            connections: current.connections + (ready ? 1 : 0),
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
    status: current.status,
    cardRevision: (id: string) =>
      current.connections +
      (current.streams.get("project") ?? 0) +
      (current.streams.get(id) ?? 0),
  };
}
