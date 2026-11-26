import { parentPort, workerData } from "node:worker_threads";
import type { ProjectId } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { readNeedsState } from "./needs-state.js";
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

/**
 * C-774: a fresh worker decodes its projects' history in slices of this many
 * events, then builds their command state once, so the first reads after a
 * restart do not each wait for a cold build. A read that arrives meanwhile
 * runs between slices (it reads the database itself, never a partial view).
 */
const WARM_SLICE_ROWS = 5_000;
const warming: string[] = [];
let warmScheduled = false;

function scheduleWarm() {
  if (warmScheduled || closing || !warming.length) return;
  warmScheduled = true;
  setImmediate(warmStep);
}

function warmStep() {
  warmScheduled = false;
  // Reads go first; the finished read schedules the next slice.
  if (closing || current) return;
  const project = warming[0];
  if (project === undefined) return;
  try {
    if (store.warmCommandEvents(project as ProjectId, WARM_SLICE_ROWS)) {
      readNeedsState(store, project as ProjectId);
      warming.shift();
    }
  } catch {
    // Best effort: the project's first read builds whatever is left.
    warming.shift();
  }
  scheduleWarm();
}

port.on("message", (message) => {
  if (message.kind === "warm") {
    for (const project of message.projects as string[])
      if (!warming.includes(project)) warming.push(project);
    scheduleWarm();
    return;
  }
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
    scheduleWarm();
  });
  current = request;
});
