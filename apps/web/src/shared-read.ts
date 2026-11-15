type Retained = { key: string; value: unknown; dispose: () => void };
let cached: Retained | undefined;
let activeKey: string | undefined;
let generation = 0;
const holders = new Set<() => void>();
/** A page retains only one validated project/revision; logout discards it. */
export function clearSharedReads() {
  generation++;
  activeKey = undefined;
  cached = undefined;
  for (const dispose of [...holders]) dispose();
}

/**
 * Share reads scoped by a freshly validated session, project and server revision.
 * No storage, TTL or timers. Optional completed reuse keeps one revision in this
 * page's memory; callers MUST revalidate source and clock membership before each
 * call. Its result lock also hands ownership to a follower if the owner exits.
 */
export async function sharePendingRead<T>(
  scope: string,
  project: string,
  invalidation: string,
  load: () => Promise<T>,
  retainCompleted = false,
): Promise<T> {
  if (typeof document !== "undefined" && document.hidden)
    throw new DOMException("Read abandoned", "AbortError");
  if (typeof BroadcastChannel === "undefined" || !navigator.locks)
    return load();
  const name = JSON.stringify(["cardigan-needs", scope, project, invalidation]);
  if (retainCompleted && activeKey !== name) {
    clearSharedReads();
    activeKey = name;
  }
  const currentGeneration = generation;
  if (retainCompleted && cached?.key === name) return cached.value as T;
  const channel = new BroadcastChannel(name);
  const lifetime = new AbortController();
  let rejectRead: ((reason: unknown) => void) | undefined;
  let rejectWait: ((reason: unknown) => void) | undefined;
  let releaseResult: (() => void) | undefined;
  const cleanup = () => {
    holders.delete(abandon);
    if (cached?.dispose === abandon) cached = undefined;
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", abandon);
    channel.close();
    releaseResult?.();
  };
  const abandon = () => {
    const error = new DOMException("Read abandoned", "AbortError");
    lifetime.abort(error);
    cancel?.abort();
    rejectRead?.(error);
    rejectWait?.(error);
    cleanup();
  };
  const visibility = () => {
    if (document.hidden) abandon();
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", abandon);
  let received: { value: T } | undefined;
  let served: { value: T } | undefined;
  let accept: ((value: T) => void) | undefined;
  let cancel: AbortController | undefined;
  let retained = false;
  const alive = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  const keep = (value: T) => {
    if (
      !retainCompleted ||
      currentGeneration !== generation ||
      activeKey !== name
    )
      return false;
    served = { value };
    retained = true;
    holders.add(abandon);
    cached = { key: name, value, dispose: abandon };
    return true;
  };
  channel.onmessage = (event: MessageEvent<{ kind: string; value: T }>) => {
    if (lifetime.signal.aborted) return;
    if (event.data.kind === "request") {
      if (served) channel.postMessage({ kind: "value", ...served });
    } else if (event.data.kind === "value") {
      received = { value: event.data.value };
      const keepResult = keep(received.value);
      accept?.(received.value);
      if (!keepResult) cancel?.abort();
    }
  };
  try {
    if (document.hidden) abandon();
    return await navigator.locks.request(
      name,
      { signal: lifetime.signal },
      async () => {
        // Ask the preceding reader, but also queue for its result lock. A living
        // reader replies; a crashed/failed one releases the lock so we can load.
        channel.postMessage({ kind: "request" });
        const controller = new AbortController();
        cancel = controller;
        return new Promise<T>((resolve, reject) => {
          accept = resolve;
          rejectWait = reject;
          if (received) {
            keep(received.value);
            resolve(received.value);
          }
          void navigator.locks
            .request(
              `${name}:result`,
              { signal: controller.signal },
              async () => {
                if (received) {
                  resolve(received.value);
                  if (keep(received.value)) await alive;
                  return;
                }
                const value = await new Promise<T>((done, fail) => {
                  rejectRead = fail;
                  void load().then(done, fail);
                });
                rejectRead = undefined;
                served = { value };
                channel.postMessage({ kind: "value", value });
                // Queue cleanup behind the main-lock readers already waiting. Keep
                // answering requests until they have collected the successful result.
                if (keep(value)) {
                  resolve(value);
                  await alive;
                  return;
                }
                retained = true;
                const released = new Promise<void>((release) => {
                  releaseResult = release;
                  void navigator.locks
                    .request(name, async () => cleanup())
                    .catch(cleanup);
                });
                resolve(value);
                await released;
              },
            )
            .catch((error: unknown) => {
              if (
                !(
                  controller.signal.aborted &&
                  error instanceof DOMException &&
                  error.name === "AbortError"
                )
              )
                reject(error);
            });
        });
      },
    );
  } finally {
    if (!retained) cleanup();
  }
}
