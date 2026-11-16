import { createConnection } from "node:net";
import { hcError, RuntimeFailure } from "./runtime-failure.js";

const unavailable = () =>
  new RuntimeFailure("runtime_unavailable", "hc protocol connection failed");

/** hc 0.1.18 schema: generation 1, plain JSON-RPC, one message per line.
 * Each request owns its connection. Never replay a request after disconnect.
 * Subscriptions own a separate connection and start from a fresh snapshot.
 */
export async function* socketMessages(
  path: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  if (signal?.aborted) return;
  const socket = createConnection(path);
  socket.setEncoding("utf8");
  let timedOut = false;
  const stop = () => socket.destroy();
  const timer = setTimeout(() => {
    timedOut = true;
    socket.destroy();
  }, timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  const send = (id: number, name: string, input: Record<string, unknown>) =>
    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method: name, params: input })}\n`,
    );
  send(1, "hello", { generation: 1, framed: false });
  let buffer = "",
    greeted = false,
    subscribed = false;
  let snapshotSeq: number | undefined;
  try {
    for await (const chunk of socket) {
      buffer += chunk;
      // Match execFile's existing stdout budget for command replies. Event
      // snapshots retain the previous streaming client's separate semantics.
      if (
        method !== "events.subscribe" &&
        Buffer.byteLength(buffer) > 1024 * 1024
      )
        throw unavailable();
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw unavailable();
          message = parsed as Record<string, unknown>;
        } catch {
          throw unavailable();
        }
        if (message.jsonrpc !== "2.0") throw unavailable();
        if (message.error !== undefined) {
          if (message.id !== (greeted ? 2 : 1)) throw unavailable();
          const error = message.error as { data?: { kind?: unknown } } | null;
          const kind = error?.data?.kind;
          // Protocol diagnostics never contain server text, paths or output.
          if (typeof kind !== "string" || !/^[a-z_]+$/.test(kind))
            throw unavailable();
          const known = [
            "not_found",
            "finished",
            "blocked",
            "status_mismatch",
            "name_taken",
            "live",
            "invalid_params",
            "invalid_template",
            "usage",
          ];
          throw hcError(
            JSON.stringify({
              error: { kind: known.includes(kind) ? kind : "unavailable" },
            }),
          );
        }
        if (!greeted) {
          if (message.id !== 1) throw unavailable();
          const hello = message.result as {
            generation?: unknown;
            version?: unknown;
            framed?: unknown;
            methods?: unknown;
          } | null;
          if (
            hello?.generation !== 1 ||
            hello.version !== "0.1.18" ||
            hello.framed !== false ||
            !Array.isArray(hello.methods) ||
            !hello.methods.includes(method)
          )
            throw unavailable();
          greeted = true;
          send(2, method, params);
        } else if (!subscribed) {
          if (message.id !== 2 || !("result" in message)) throw unavailable();
          if (method === "events.subscribe")
            snapshotSeq = (message.result as { seq?: number } | null)?.seq;
          timer.refresh();
          yield message.result;
          if (method !== "events.subscribe") return;
          subscribed = true;
        } else {
          if (
            "id" in message ||
            !["event", "heartbeat", "missed"].includes(String(message.method))
          )
            throw unavailable();
          const event = message.params as {
            seq?: number;
            type?: string;
          } | null;
          const type = event?.type ?? message.method;
          // SubscribeResult's contract: after a missed snapshot ignore older
          // queued facts. Heartbeats still count as liveness at the same seq.
          if (type === "missed") snapshotSeq = event?.seq;
          else if (
            message.method === "event" &&
            type !== "heartbeat" &&
            typeof event?.seq === "number" &&
            snapshotSeq !== undefined &&
            event.seq <= snapshotSeq
          )
            continue;
          timer.refresh();
          yield message;
        }
      }
    }
    if (!signal?.aborted) throw unavailable();
  } catch (error) {
    if (signal?.aborted) return;
    if (timedOut)
      throw new RuntimeFailure(
        "runtime_timeout",
        method === "events.subscribe"
          ? "hc event stream stopped responding"
          : "hc command timed out",
      );
    throw error instanceof RuntimeFailure ? error : unavailable();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    socket.destroy();
  }
}

/** Read-only CLI forms used by the adapter; all other forms retain the CLI. */
export function socketRead(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { method: string; params: Record<string, unknown> } | undefined {
  if (args.length === 3 && args[0] === "get" && args[2] === "--json")
    return {
      method: "terminal.get",
      params: {
        terminal: args[1],
        ...(env.HC_TERMINAL_ID ? { caller: env.HC_TERMINAL_ID } : {}),
      },
    };
  if (
    args.length === 3 &&
    args[0] === "machine" &&
    args[1] === "ls" &&
    args[2] === "--json"
  )
    return { method: "machine.list", params: {} };
  return undefined;
}
