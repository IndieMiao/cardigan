import { afterEach, expect, test, vi } from "vitest";
import { createListenRetry } from "./listen-retry.js";

const occupied = () =>
  Object.assign(new Error("in use"), { code: "EADDRINUSE" });

afterEach(() => vi.useRealTimers());

test("retries every second for at most 30 seconds and preserves the bind failure", async () => {
  vi.useFakeTimers();
  const warn = vi.fn();
  const error = occupied();
  const start = vi.fn().mockRejectedValue(error);
  const listen = createListenRetry({
    intervalMs: 1_000,
    timeoutMs: 30_000,
    warn,
  });
  const failed = expect(listen(3004, start)).rejects.toMatchObject({
    code: "EADDRINUSE",
    port: 3004,
    cause: error,
    message: "启动失败：等待 30000 毫秒后，端口 3004 仍被占用（EADDRINUSE）。",
  });
  await vi.advanceTimersByTimeAsync(999);
  expect(start).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(start).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(29_000);
  await failed;
  expect(start).toHaveBeenCalledTimes(31);
  expect(warn).toHaveBeenCalledTimes(30);
  expect(warn).toHaveBeenLastCalledWith(
    "端口 3004 被占用（EADDRINUSE），1000 毫秒后重试，剩余等待时间 1000 毫秒。",
  );
  expect(vi.getTimerCount()).toBe(0);
});

test("listeners share one budget and the final wait is capped by the remaining time", async () => {
  vi.useFakeTimers();
  const warn = vi.fn();
  const listen = createListenRetry({ intervalMs: 10, timeoutMs: 25, warn });
  const first = vi
    .fn()
    .mockRejectedValueOnce(occupied())
    .mockResolvedValue("up");
  const ready = listen(3004, first);
  await vi.advanceTimersByTimeAsync(10);
  expect(await ready).toBe("up");
  const second = vi.fn().mockRejectedValue(occupied());
  const failed = expect(listen(7781, second)).rejects.toMatchObject({
    port: 7781,
  });
  await vi.advanceTimersByTimeAsync(15);
  await failed;
  expect(first).toHaveBeenCalledTimes(2);
  expect(second).toHaveBeenCalledTimes(3);
  expect(warn).toHaveBeenLastCalledWith(
    "端口 7781 被占用（EADDRINUSE），5 毫秒后重试，剩余等待时间 5 毫秒。",
  );
  expect(vi.getTimerCount()).toBe(0);
});

test.each([false, true])(
  "other errors stop immediately (after conflict: %s)",
  async (afterConflict) => {
    vi.useFakeTimers();
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    const warn = vi.fn();
    const start = vi.fn().mockRejectedValue(error);
    if (afterConflict) start.mockRejectedValueOnce(occupied());
    const listen = createListenRetry({ intervalMs: 10, timeoutMs: 30, warn });
    const failed = expect(listen(3004, start)).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(afterConflict ? 10 : 0);
    await failed;
    expect(start).toHaveBeenCalledTimes(afterConflict ? 2 : 1);
    expect(warn).toHaveBeenCalledTimes(afterConflict ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  },
);
