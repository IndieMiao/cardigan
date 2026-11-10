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
      if (current()) {
        callbacks.status("live");
        callbacks.ready();
      }
    });
    connection.addEventListener("queue", () => {
      if (current()) callbacks.ready();
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
    connection.addEventListener("error", () => {
      if (!current()) return;
      source = undefined;
      connection.close();
      reconnect();
    });
  }
  connect(false);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    source?.close();
    source = undefined;
  };
}
