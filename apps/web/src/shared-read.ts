/**
 * Share overlapping reads only, scoped by a freshly validated session, project
 * and invalidation. No storage, TTL or timers. The result lock keeps a successful
 * reader available until the readers already queued on the main lock can collect
 * its reply. If that tab exits, releasing the result lock lets a waiter fetch.
 */
export async function sharePendingRead<T>(
  scope: string,
  project: string,
  invalidation: string,
  load: () => Promise<T>,
): Promise<T> {
  if (typeof BroadcastChannel === "undefined" || !navigator.locks)
    return load();
  const name = JSON.stringify(["cardigan-needs", scope, project, invalidation]);
  const channel = new BroadcastChannel(name);
  const lifetime = new AbortController();
  let rejectRead: ((reason: unknown) => void) | undefined;
  let rejectWait: ((reason: unknown) => void) | undefined;
  let releaseResult: (() => void) | undefined;
  const cleanup = () => {
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
  channel.onmessage = (event: MessageEvent<{ kind: string; value: T }>) => {
    if (lifetime.signal.aborted) return;
    if (event.data.kind === "request") {
      if (served) channel.postMessage({ kind: "value", ...served });
    } else if (event.data.kind === "value") {
      received = { value: event.data.value };
      accept?.(received.value);
      cancel?.abort();
    }
  };
  try {
    if (document.hidden) abandon();
    return await navigator.locks.request(
      name,
      { signal: lifetime.signal },
      async () => {
        if (received) return received.value;
        // Ask the preceding reader, but also queue for its result lock. A living
        // reader replies; a crashed/failed one releases the lock so we can load.
        channel.postMessage({ kind: "request" });
        const controller = new AbortController();
        cancel = controller;
        return new Promise<T>((resolve, reject) => {
          accept = resolve;
          rejectWait = reject;
          void navigator.locks
            .request(
              `${name}:result`,
              { signal: controller.signal },
              async () => {
                if (received) {
                  resolve(received.value);
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
