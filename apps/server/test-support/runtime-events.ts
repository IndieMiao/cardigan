import type { RuntimeRef, RuntimeResult } from "@cardigan/domain";
import type { RuntimeEvent } from "@cardigan/runtime-herdr";
import type { RuntimeEventSource } from "../src/dispatch-monitor.js";

/** A controllable hc subscription, including EOF and abort. */
export function runtimeEvents() {
  const sessions: {
    ref: RuntimeRef;
    signal?: AbortSignal | undefined;
    push: (event: RuntimeResult<RuntimeEvent>) => void;
    end: () => void;
  }[] = [];
  const source: RuntimeEventSource = {
    async *events(ref, signal) {
      const pending: RuntimeResult<RuntimeEvent>[] = [];
      let ended = false,
        wake = () => {};
      const end = () => {
        ended = true;
        wake();
      };
      sessions.push({
        ref,
        signal,
        push: (e) => {
          pending.push(e);
          wake();
        },
        end,
      });
      signal?.addEventListener("abort", end, { once: true });
      try {
        while (!ended && !signal?.aborted) {
          if (!pending.length)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          for (const event of pending.splice(0)) yield event;
        }
      } finally {
        signal?.removeEventListener("abort", end);
      }
    },
  };
  const send = (
    event: Partial<RuntimeEvent> & Pick<RuntimeEvent, "seq" | "type">,
    index = sessions.length - 1,
  ) => {
    const session = sessions[index];
    if (!session) throw new Error("Missing subscription");
    session.push({ ok: true, value: { observations: [], ...event } });
  };
  return { source, sessions, send };
}
