import { useEffect, useState } from "react";
import type { CardiganClient } from "./api.js";
import type { StreamStatus } from "./stream.js";

const initial = (project: string | undefined) => ({
  project,
  revision: 0,
  needsKey: "initial",
  connectionRevision: 0,
  contextRevision: 0,
  capacityRevision: 0,
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
    const seen = new Map<string, number>();
    let connection = 0;
    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed) return;
        const changes = [...pending],
          ready = opened;
        pending.clear();
        opened = false;
        const needsKey = JSON.stringify([
          connection,
          [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ]);
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
            needsKey,
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
        connection++;
        schedule();
      },
      change: (event) => {
        seen.set(
          event.stream,
          Math.max(seen.get(event.stream) ?? 0, event.seq),
        );
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
      capacity: () => {
        if (disposed) return;
        setState((old) =>
          old.project === project
            ? { ...old, capacityRevision: old.capacityRevision + 1 }
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
    needsKey: current.needsKey,
    changedCardsSince: (revision: number) =>
      [...current.streams]
        .filter(([, changed]) => changed > revision)
        .map(([id]) => id),
    changedCards: [...current.streams]
      .filter(([, revision]) => revision === current.revision)
      .map(([id]) => id),
    contextRevision: current.contextRevision,
    capacityRevision: current.capacityRevision,
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
