import { parentPort, workerData } from "node:worker_threads";
import { Store } from "@cardigan/store";
import {
  type HostFacts,
  type HostFactsRequest,
  runWorkbenchRead,
  toReadError,
  type WorkbenchReadOp,
} from "./read-ops.js";

/**
 * C-644: one Workbench read worker. It owns a private, query-only connection
 * and its own caches; it never writes and never sees a session token. The pool
 * sends it one read at a time, so its queue lives on the Web thread.
 */
const port = parentPort;
if (!port) throw new Error("Workbench read worker requires its parent port");
const { dbPath } = workerData as { dbPath: string };
const store = Store.open({ dbPath, migrate: false });
store.database.exec("PRAGMA query_only = ON");
const asks = new Map<number, (facts: HostFacts) => void>();
let serial = 0;
let closing = false;
let current: Promise<void> | undefined;

function askHost(request: HostFactsRequest): Promise<HostFacts> {
  if (closing) return Promise.resolve({});
  const id = ++serial;
  return new Promise((resolve) => {
    asks.set(id, resolve);
    port?.postMessage({ kind: "host", id, request });
  });
}

async function read(id: number, op: WorkbenchReadOp) {
  const started = performance.now();
  try {
    const result = await runWorkbenchRead(store, op, askHost);
    if (!closing)
      port?.postMessage({
        kind: "done",
        id,
        result: {
          ...result,
          timings: {
            ...result.timings,
            read_worker: performance.now() - started,
          },
        },
      });
  } catch (error) {
    if (!closing)
      port?.postMessage({
        kind: "done",
        id,
        error: toReadError(error) ?? null,
      });
  }
}

port.on("message", (message) => {
  if (message.kind === "host") {
    asks.get(message.id)?.(message.facts ?? {});
    asks.delete(message.id);
    return;
  }
  if (message.kind === "close") {
    closing = true;
    for (const resolve of asks.values()) resolve({});
    asks.clear();
    void Promise.resolve(current).finally(() => {
      store.close();
      port.close();
    });
    return;
  }
  if (message.kind !== "read" || closing) return;
  const request = read(message.id, message.op).finally(() => {
    if (current === request) current = undefined;
  });
  current = request;
});
