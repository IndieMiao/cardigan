export type StreamStatus = "connecting" | "live" | "retrying";
export interface ProjectChange {
  readonly stream: string;
  readonly seq: number;
  readonly type: string;
}
export interface StreamCallbacks {
  readonly change: (event: ProjectChange) => void;
  readonly ready: () => void;
  readonly status: (status: StreamStatus) => void;
  /**
   * C-232: the host's in-memory context samples changed (first sample, new
   * reading, unknown or expired). Only the execution view needs to re-read.
   */
  readonly context?: () => void;
}
export interface EventConnection {
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}
export type StreamFactory = (url: string) => EventConnection;
export const browserStream: StreamFactory = (url) => new EventSource(url);

/** One project subscription, monotonic per-stream cursors, explicit reconnect URLs. */
export function subscribeProject(
  project: string,
  callbacks: StreamCallbacks,
  create: StreamFactory = browserStream,
  retryMs = 3000,
): () => void {
  const seen = new Map<string, number>();
  // Last run-queue revision the server announced. The queue has no seq, so a
  // resumed connection relies on this to notice changes made while away.
  let queueRevision: string | undefined;
  // C-232: the same for the host's context samples.
  let contextRevision: string | undefined;
  let source: EventConnection | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    stopped = false;
  const reconnect = () => {
    if (stopped || timer !== undefined) return;
    callbacks.status("retrying");
    timer = setTimeout(() => {
      timer = undefined;
      connect(true);
    }, retryMs);
  };
  function connect(retry: boolean) {
    if (stopped) return;
    const cursors = [...seen].sort(([a], [b]) => a.localeCompare(b));
    const resumed = retry && cursors.length > 0;
    // No events observed before disconnect: requesting an explicit zero avoids "start at now".
    const after = (cursors.length ? cursors : [["project", 0]])
      .map(([s, n]) => `${s}:${n}`)
      .join(",");
    const url = `/api/projects/${encodeURIComponent(project)}/stream${retry ? `?after=${encodeURIComponent(after)}` : ""}`;
    callbacks.status("connecting");
    let connection: EventConnection;
    try {
      connection = create(url);
    } catch {
      reconnect();
      return;
    }
    source = connection;
    const current = () => !stopped && source === connection;
    connection.addEventListener("open", () => {
      if (!current()) return;
      callbacks.status("live");
      // A connection resumed from known cursors replays exactly the seqs
      // missed while away, so the views already on screen stay as they are.
      // The first connection, and a retry with no cursor yet (which replays
      // from zero anyway), re-read to cover the window before the stream.
      if (!resumed) callbacks.ready();
    });
    connection.addEventListener("queue", (event) => {
      if (!current()) return;
      let revision: unknown;
      try {
        revision = (
          JSON.parse((event as MessageEvent<string>).data) as {
            revision?: unknown;
          }
        ).revision;
      } catch {
        revision = undefined;
      }
      if (typeof revision !== "string") {
        // No revision to compare (older server): always refresh.
        callbacks.ready();
        return;
      }
      const known = queueRevision;
      queueRevision = revision;
      if (known === revision) return;
      // The first revision of the first connection is already covered by the
      // re-read on open; on a resumed connection any revision we did not have
      // yet means the queue may have changed while we were away.
      if (known !== undefined || resumed) callbacks.ready();
    });
    connection.addEventListener("context", (event) => {
      if (!current()) return;
      let revision: unknown;
      try {
        revision = (
          JSON.parse((event as MessageEvent<string>).data) as {
            revision?: unknown;
          }
        ).revision;
      } catch {
        revision = undefined;
      }
      if (typeof revision !== "string") {
        callbacks.context?.();
        return;
      }
      const known = contextRevision;
      contextRevision = revision;
      if (known === revision) return;
      // As with the queue: the first connection's first revision is covered
      // by the re-read on open.
      if (known !== undefined || resumed) callbacks.context?.();
    });
    connection.addEventListener("change", (event) => {
      if (!current()) return;
      let change: Partial<ProjectChange>;
      try {
        change = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as Partial<ProjectChange>;
      } catch {
        return;
      }
      if (
        !change ||
        typeof change.stream !== "string" ||
        !/^(project|C-[1-9][0-9]*)$/u.test(change.stream) ||
        typeof change.seq !== "number" ||
        !Number.isSafeInteger(change.seq) ||
        change.seq <= 0 ||
        typeof change.type !== "string"
      )
        return;
      if (change.seq <= (seen.get(change.stream) ?? 0)) return;
      seen.set(change.stream, change.seq);
      callbacks.change({
        stream: change.stream,
        seq: change.seq,
        type: change.type,
      });
    });
    const lost = () => {
      if (!current()) return;
      source = undefined;
      connection.close();
      reconnect();
    };
    connection.addEventListener("error", lost);
    // The server is restarting: drop this connection now and resume on the
    // next server with the same cursors, without a page reload.
    connection.addEventListener("shutdown", lost);
  }
  connect(false);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    source?.close();
    source = undefined;
  };
}
