import type { RuntimeObservation } from "@cardigan/domain";
import { type HcClient, RuntimeFailure } from "./client.js";
import type { RuntimeEvent } from "./runtime-event.js";

interface Listener {
  readonly epoch: number;
  readonly pending: RuntimeEvent[];
  wake?: () => void;
  ended: boolean;
  error?: unknown;
}
type Terminal = {
  address: string;
  state: string;
  status?: { state?: string } | null;
};
function observation(t: Terminal, seq: number): RuntimeObservation {
  const agent = t.status?.state;
  return {
    process:
      t.state === "live"
        ? "alive"
        : t.state === "finished"
          ? "exited"
          : "unknown",
    agent: ["working", "blocked", "done", "idle", "error"].includes(agent ?? "")
      ? (agent as RuntimeObservation["agent"])
      : "unknown",
    observed_seq: seq,
  };
}
function parse(line: string): RuntimeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new RuntimeFailure("runtime_unavailable", "Invalid hc event JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new RuntimeFailure("runtime_unavailable", "Invalid hc event shape");
  const message = parsed as Record<string, unknown>;
  const raw = message.params ?? message;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new RuntimeFailure("runtime_unavailable", "Invalid hc event shape");
  const data = raw as Record<string, unknown>;
  const seq = data.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0)
    throw new RuntimeFailure(
      "runtime_unavailable",
      "hc event lacks a sequence",
    );
  const type = data.type ?? message.method ?? "snapshot";
  if (
    typeof type !== "string" ||
    (data.terminals !== undefined && !Array.isArray(data.terminals))
  )
    throw new RuntimeFailure("runtime_unavailable", "Invalid hc event shape");
  const terminals = (data.terminals ?? []) as Terminal[];
  if (
    ["snapshot", "missed"].includes(type.split(/[.:/]/u).at(-1) ?? "") &&
    !Array.isArray(data.terminals)
  )
    throw new RuntimeFailure(
      "runtime_unavailable",
      "hc snapshot has no terminal list",
    );
  if (
    terminals.some(
      (t) => !t || typeof t.address !== "string" || typeof t.state !== "string",
    )
  )
    throw new RuntimeFailure(
      "runtime_unavailable",
      "Invalid hc terminal snapshot",
    );
  return {
    seq,
    type,
    ...(typeof data.terminal === "string"
      ? { terminal_ref: data.terminal }
      : {}),
    ...(data.data === undefined ? {} : { data: data.data }),
    observations: terminals.map((t) => ({
      terminal_ref: t.address,
      status: observation(t, seq),
    })),
  };
}

/** One live source per core. Intentional refreshes close the old source first. */
export class CoreEvents {
  private readonly listeners = new Set<Listener>();
  private epoch = 0;
  private controller: AbortController | undefined;
  private task: Promise<void> | undefined;
  private pendingEpoch: number | undefined;
  constructor(private readonly client: HcClient) {}
  get subscribers() {
    return this.listeners.size;
  }
  get sources() {
    return this.controller && !this.controller.signal.aborted ? 1 : 0;
  }
  private refresh(): number {
    if (this.pendingEpoch !== undefined) return this.pendingEpoch;
    const epoch = ++this.epoch;
    this.pendingEpoch = epoch;
    void Promise.resolve().then(async () => {
      this.controller?.abort();
      await this.task;
      this.pendingEpoch = undefined;
      if (!this.listeners.size) return;
      const controller = new AbortController();
      this.controller = controller;
      this.task = this.read(epoch, controller);
    });
    return epoch;
  }
  private async read(epoch: number, controller: AbortController) {
    let failure: unknown;
    try {
      for await (const line of this.client.lines(
        ["events", "--json"],
        controller.signal,
      )) {
        if (controller.signal.aborted) break;
        const event = { ...parse(line), source_generation: epoch };
        for (const listener of this.listeners)
          if (listener.epoch <= epoch && !listener.ended) {
            listener.pending.push(event);
            listener.wake?.();
          }
      }
    } catch (error) {
      failure = error;
    } finally {
      if (this.controller === controller) this.controller = undefined;
      if (!controller.signal.aborted) {
        for (const listener of this.listeners)
          if (listener.epoch <= epoch) {
            listener.error = failure;
            listener.ended = true;
            listener.wake?.();
          }
      }
    }
  }
  /** New consumers receive a new snapshot, never a replayed cached alive/exit. */
  async *subscribe(signal?: AbortSignal): AsyncGenerator<RuntimeEvent> {
    if (signal?.aborted) return;
    const listener: Listener = {
      epoch: this.refresh(),
      pending: [],
      ended: false,
    };
    this.listeners.add(listener);
    const abort = () => {
      listener.ended = true;
      listener.wake?.();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      for (;;) {
        if (signal?.aborted) return;
        const event = listener.pending.shift();
        if (event) {
          yield event;
          continue;
        }
        if (listener.ended) {
          if (listener.error) throw listener.error;
          return;
        }
        await new Promise<void>((resolve) => {
          listener.wake = resolve;
        });
        delete listener.wake;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.controller?.abort();
        await this.task;
      }
    }
  }
  async snapshot(timeoutMs: number): Promise<RuntimeEvent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for await (const event of this.subscribe(controller.signal)) {
        const type = event.type.split(/[.:/]/u).at(-1);
        if (type === "snapshot" || type === "missed") return event;
      }
      throw new RuntimeFailure(
        controller.signal.aborted ? "runtime_timeout" : "runtime_unavailable",
        "hc event stream ended without a fresh snapshot",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

const hubs = new WeakMap<object, CoreEvents>();
export function coreEvents(identity: object, client: HcClient): CoreEvents {
  let hub = hubs.get(identity);
  if (!hub) {
    hub = new CoreEvents(client);
    hubs.set(identity, hub);
  }
  return hub;
}
