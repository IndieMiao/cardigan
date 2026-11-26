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
  readonly capacity?: () => void;
}
export interface EventConnection {
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}
export type StreamFactory = (url: string) => EventConnection;
export const browserStream: StreamFactory = (url) => new EventSource(url);

/**
 * One project subscription with monotonic per-stream dedupe.
 *
 * C-779: every connection, a reconnect included, opens without `after` and so
 * starts at the server's current seqs; `ready()` on open re-reads the views on
 * screen, which covers whatever changed while the page was away. Sending the
 * seen cursors back made the URL grow with every card (431 past ~16 KB) and a
 * page that had seen only a few streams replayed the whole history once.
 */
export function subscribeProject(
  project: string,
  callbacks: StreamCallbacks,
  create: StreamFactory = browserStream,
  retryMs = 3000,
): () => void {
  const seen = new Map<string, number>();
  // Last run-queue revision the server announced. The queue has no seq, so
  // this tells a real change from a repeated revision on one connection.
  let queueRevision: string | undefined;
  // C-232: the same for the host's context samples.
  let contextRevision: string | undefined;
  let capacityRevision: string | undefined;
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
    // Revisions changed while away are not covered by `ready()` for context
    // and capacity, so a reconnect still reports a revision it had not seen.
    const resumed = retry;
    // The queue's opening revision is always covered by the re-read on open.
    let queueOpened = false;
    const url = `/api/projects/${encodeURIComponent(project)}/stream`;
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
      // The stream starts at "now": re-read to cover the window before it,
      // on the first connection and after every reconnect alike.
      callbacks.ready();
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
      const opening = !queueOpened;
      queueOpened = true;
      if (known === revision) return;
      // Each connection's first revision is covered by the re-read on open.
      if (!opening) callbacks.ready();
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
    connection.addEventListener("capacity", (event) => {
      if (!current()) return;
      let revision: unknown;
      try {
        revision = JSON.parse((event as MessageEvent<string>).data)?.revision;
      } catch {
        return;
      }
      if (typeof revision !== "string") return;
      const known = capacityRevision;
      capacityRevision = revision;
      if (known !== revision && (known !== undefined || resumed))
        callbacks.capacity?.();
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
    // The server is restarting: drop this connection now and reconnect to the
    // next server, without a page reload.
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
