import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { type DispatchLoop, startDispatchLoop } from "./dispatch-loop.js";
import { installShutdownHandlers } from "./lifecycle.js";

let loop: DispatchLoop | undefined;
afterEach(async () => {
  await loop?.stop().catch(() => {});
  loop = undefined;
  vi.useRealTimers();
});
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("the loop serializes slow ticks, reconciles subscriptions and cancels its timer on stop", async () => {
  vi.useFakeTimers();
  const hold = deferred(),
    tick = vi.fn(async () => {}),
    monitor = { reconcile: vi.fn(), stop: vi.fn(async () => {}) };
  tick.mockImplementationOnce(() => hold.promise);
  loop = startDispatchLoop({
    dispatcher: { tick },
    monitor,
    onError: (error) => {
      throw error;
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(10000);
    expect(tick).toHaveBeenCalledOnce();
    hold.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(tick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(loop.stop()).toBe(loop.done);
    await loop.done;
    expect(monitor.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);
    expect(tick).toHaveBeenCalledTimes(2);
  } finally {
    hold.resolve();
  }
});

test("SIGTERM stops scheduling but host resources stay open until the in-flight delivery and subscriptions drain", async () => {
  const hold = deferred(),
    host = new EventEmitter(),
    order: string[] = [];
  loop = startDispatchLoop({
    dispatcher: {
      tick: async () => {
        await hold.promise;
        order.push("settled");
      },
    },
    monitor: {
      reconcile() {},
      stop: async () => {
        order.push("unsubscribed");
      },
    },
    onError: (error) => {
      throw error;
    },
  });
  const active = loop;
  let closing: Promise<void> | undefined;
  const remove = installShutdownHandlers(host, () => {
    closing = active.stop().then(() => {
      order.push("store_closed");
    });
  });
  try {
    host.emit("SIGTERM");
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(host.listenerCount("SIGTERM")).toBe(0);
    hold.resolve();
    await closing;
    expect(order).toEqual(["settled", "unsubscribed", "store_closed"]);
    await active.stop();
    expect(order).toHaveLength(3);
  } finally {
    remove();
    hold.resolve();
  }
});

test("a failed tick reports its error and the next interval continues; AbortSignal drains the loop", async () => {
  vi.useFakeTimers();
  const error = new Error("store temporarily unavailable"),
    tick = vi.fn(async () => {}),
    onError = vi.fn(),
    abort = new AbortController();
  tick.mockRejectedValueOnce(error);
  loop = startDispatchLoop({
    dispatcher: { tick },
    intervalMs: 20,
    signal: abort.signal,
    onError,
  });
  await vi.advanceTimersByTimeAsync(19);
  expect(onError).toHaveBeenCalledWith(error);
  expect(tick).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(tick).toHaveBeenCalledTimes(2);
  abort.abort();
  await loop.done;
  await vi.advanceTimersByTimeAsync(100);
  expect(tick).toHaveBeenCalledTimes(2);
});

test("fatal error policy still cleans subscriptions and exposes shutdown failure", async () => {
  const error = new Error("fatal"),
    stop = vi.fn(async () => {});
  loop = startDispatchLoop({
    dispatcher: {
      tick: async () => {
        throw error;
      },
    },
    monitor: { reconcile() {}, stop },
    onError: (e) => {
      throw e;
    },
  });
  await expect(loop.done).rejects.toBe(error);
  expect(stop).toHaveBeenCalledOnce();
});

test("an already-aborted signal starts no delivery; invalid intervals fail before starting", async () => {
  const tick = vi.fn(async () => {}),
    onError = vi.fn();
  loop = startDispatchLoop({
    dispatcher: { tick },
    onError,
    signal: AbortSignal.abort(),
  });
  await loop.done;
  expect(tick).not.toHaveBeenCalled();
  for (const intervalMs of [0, -1, Number.NaN, 0.5, 2147483648])
    expect(() =>
      startDispatchLoop({ dispatcher: { tick }, onError, intervalMs }),
    ).toThrow("Invalid dispatcher interval");
});
