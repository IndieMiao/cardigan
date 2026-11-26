import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CardId, Event, ProjectId } from "@cardigan/domain";
import { readRunQueue } from "@cardigan/host";
import type { Store } from "@cardigan/store";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";

/**
 * `GET /api/projects/:id/stream` — Server-Sent Events (M5 plan §3.3).
 *
 * A client may send the seq it has already seen per stream
 * (`?after=project:12,C-1:8`); the server replays what is missing and then
 * pushes new seqs. C-779: the Workbench no longer does — it connects without
 * cursors and re-reads its views on open — because the cursor list grows with
 * every card; `after` stays for older pages still open. Only the seq, the type
 * and the card are sent — the body is
 * fetched by the view that needs it — so a slow reader cannot make the stream
 * expensive.
 *
 * The stream is strictly read-only: it never acknowledges, never advances an
 * Assignment cursor (§3.3).
 */

/** A `stream:seq` pair; the project stream is spelled `project`. */
export interface StreamCursor {
  readonly stream: string;
  readonly seq: number;
}

export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_POLL_MS = 500;
/** What the browser should wait before reconnecting. */
export const SSE_RETRY_MS = 3_000;

/** `project:12,C-1:8` → cursors; `project` is the project-level stream. */
export function parseAfter(value: string | null): StreamCursor[] {
  if (value === null || value.trim().length === 0) return [];
  const cursors: StreamCursor[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const index = trimmed.lastIndexOf(":");
    if (index <= 0) {
      throw new Error(`malformed cursor ${JSON.stringify(trimmed)}`);
    }
    const stream = trimmed.slice(0, index);
    const seq = Number(trimmed.slice(index + 1));
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new Error(`malformed seq in ${JSON.stringify(trimmed)}`);
    }
    cursors.push({
      stream: stream === "project" ? PROJECT_EVENT_STREAM : stream,
      seq,
    });
  }
  return cursors;
}

export interface StreamOptions {
  readonly store: Store;
  readonly project_id: ProjectId;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly after: readonly StreamCursor[];
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
  /**
   * Aborted when the server shuts down: the stream sends `event: shutdown` and
   * ends at once, so a long-lived browser connection never holds a restart
   * open; the client reconnects to the next server with its cursors.
   */
  readonly signal?: AbortSignal;
  /**
   * C-232: revision of the host patrol's in-memory context samples, which have
   * no seq either. Checked on the same poll as the queue; absent without a
   * dispatcher, and then no `context` frame is sent.
   */
  readonly contextRevision?: () => string;
  /** Shared Agent/CI counts and limits, including changes in other projects. */
  readonly capacityRevision?: () => string;
}

export const SSE_SHUTDOWN_FRAME = "event: shutdown\ndata: {}\n\n";

/**
 * Open the stream and keep it open until the client goes away. Resolves when the
 * connection closes, so the caller can log one line per connection.
 */
export async function serveStream(options: StreamOptions): Promise<void> {
  const { store, project_id, req, res } = options;
  const pollMs = options.pollMs ?? SSE_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: ${SSE_RETRY_MS}\n\n`);

  // Highest seq already sent per stream; `events` are per-stream, so the client
  // can resume without the browser's Last-Event-ID (§3.3).
  const cursors = new Map<string, number>();
  for (const cursor of options.after) {
    cursors.set(
      cursor.stream,
      Math.max(cursors.get(cursor.stream) ?? 0, cursor.seq),
    );
  }

  // A client that sends no cursors starts at "now": it asked for changes, not
  // for the project's history. History is one explicit `after=project:0` away.
  // C-634: one aggregate query, not a history read per card.
  if (options.after.length === 0) {
    for (const [stream, seq] of store.uow.read(() =>
      store.latestEventSeqs(project_id),
    ))
      cursors.set(stream, seq);
  }

  // The run queue has no seq, so a reconnecting client cannot ask for what it
  // missed. Instead every connection opens with the queue's revision and every
  // change carries the new one: the client compares it with the revision it
  // last saw and refreshes only when they differ (C-117).
  const queueRevisionOf = (): string =>
    createHash("sha256")
      .update(
        JSON.stringify(
          readRunQueue(store).filter((r) => r.project_id === project_id),
        ),
      )
      .digest("hex")
      .slice(0, 16);
  const queueFrame = (revision: string): string =>
    `event: queue\ndata: ${JSON.stringify({ revision })}\n\n`;
  let queueRevision = queueRevisionOf();
  res.write(queueFrame(queueRevision));
  // C-232: same contract for context samples: a first sample, a new reading,
  // an unknown sample or expiry changes the revision; only the execution view
  // re-reads on it.
  const contextFrame = (revision: string): string =>
    `event: context\ndata: ${JSON.stringify({ revision })}\n\n`;
  let contextRevision = options.contextRevision?.();
  if (contextRevision !== undefined) res.write(contextFrame(contextRevision));
  const capacityFrame = (revision: string): string =>
    `event: capacity\ndata: ${JSON.stringify({ revision })}\n\n`;
  let capacityRevision = options.capacityRevision?.();
  if (capacityRevision !== undefined)
    res.write(capacityFrame(capacityRevision));
  let closed = false;
  let poll: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const stopTimers = (): void => {
    if (poll !== undefined) clearInterval(poll);
    if (heartbeat !== undefined) clearInterval(heartbeat);
    poll = undefined;
    heartbeat = undefined;
  };
  const close = (): void => {
    closed = true;
    stopTimers();
    if (!res.writableEnded) res.end();
  };

  const flush = (): void => {
    if (closed || res.writableEnded) return;
    let batch: Event[];
    try {
      const nextQueue = queueRevisionOf();
      if (nextQueue !== queueRevision) {
        queueRevision = nextQueue;
        // Cross-project capacity changes have no seq in this project's streams.
        res.write(queueFrame(queueRevision));
      }
      const nextContext = options.contextRevision?.();
      if (nextContext !== undefined && nextContext !== contextRevision) {
        contextRevision = nextContext;
        res.write(contextFrame(contextRevision));
      }
      const nextCapacity = options.capacityRevision?.();
      if (nextCapacity !== undefined && nextCapacity !== capacityRevision) {
        capacityRevision = nextCapacity;
        res.write(capacityFrame(capacityRevision));
      }
      // C-634: only streams whose counter passed this connection's cursor
      // are read; an idle poll is one small query.
      batch = store.uow.read((tx) =>
        [...store.eventStreamCounters(project_id)].flatMap(
          ([stream, counter]) => {
            const since = cursors.get(stream) ?? 0;
            if (counter <= since) return [];
            return tx.events.listAfter(
              project_id,
              stream === PROJECT_EVENT_STREAM ? undefined : (stream as CardId),
              since,
            );
          },
        ),
      );
    } catch (error) {
      options.log?.({
        event: "web_stream",
        code: "read_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (batch.length === 0) return;
    // Per-stream seq order is what matters: the dedupe below is monotonic per
    // stream, so an out-of-order batch would silently drop an event.
    batch.sort((left, right) => {
      const leftStream = left.card_id ?? PROJECT_EVENT_STREAM;
      const rightStream = right.card_id ?? PROJECT_EVENT_STREAM;
      return leftStream === rightStream
        ? left.seq - right.seq
        : leftStream.localeCompare(rightStream);
    });
    for (const event of batch) {
      const stream = event.card_id ?? PROJECT_EVENT_STREAM;
      const last = cursors.get(stream) ?? 0;
      // A re-listed stream can repeat an event; send each seq once per connection.
      if (event.seq <= last) continue;
      cursors.set(stream, event.seq);
      res.write(
        `event: change\ndata: ${JSON.stringify({
          stream: stream === PROJECT_EVENT_STREAM ? "project" : stream,
          seq: event.seq,
          type: event.type,
          card_id: event.card_id ?? null,
          id: event.id,
          at: event.created_at,
        })}\n\n`,
      );
    }
  };

  // Catch up first, then poll: a reconnect must not miss events created while
  // the browser was away (§3.3).
  flush();
  poll = setInterval(flush, pollMs);
  heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) {
      res.write(`: ping ${new Date().toISOString()}\n\n`);
    }
  }, heartbeatMs);

  const shutdown = (): void => {
    if (!closed && !res.writableEnded) res.write(SSE_SHUTDOWN_FRAME);
    close();
  };
  if (options.signal?.aborted) shutdown();
  else options.signal?.addEventListener("abort", shutdown, { once: true });

  await new Promise<void>((resolve) => {
    if (closed) {
      resolve();
      return;
    }
    req.on("close", () => {
      close();
      resolve();
    });
    res.on("close", () => {
      stopTimers();
      closed = true;
      resolve();
    });
    // A shutdown ends the response ourselves; the socket may stay open as an
    // idle keep-alive connection, so do not wait for it.
    res.on("finish", resolve);
  });
  options.signal?.removeEventListener("abort", shutdown);
  close();
}
