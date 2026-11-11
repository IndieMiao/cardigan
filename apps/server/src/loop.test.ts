import { afterEach, expect, test, vi } from "vitest";
import { startTimerLoop } from "./loop.js";

afterEach(() => vi.restoreAllMocks());

test.each([
  "merge",
  "merge-push",
  "cleanup",
  "reconcile",
  "backup",
  "attachments",
])("%s reports elapsed time on slow successes and failures", async (name) => {
  for (const failure of [false, true]) {
    const now = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1250);
    const onError = vi.fn();
    const loop = startTimerLoop({
      name,
      tick: async () => {
        if (failure) throw new Error("failed");
      },
      onError,
    });
    await loop.stop();
    expect(onError.mock.calls.at(-1)?.[0].message).toBe(
      `${name} slow tick: duration_ms=1250 threshold_ms=1000`,
    );
    expect(onError).toHaveBeenCalledTimes(failure ? 2 : 1);
    now.mockRestore();
  }
});

test("timer slow threshold is configurable and rejects invalid values", async () => {
  const onError = vi.fn();
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(100);
  const loop = startTimerLoop({
    name: "cleanup",
    tick: async () => {},
    slowTickMs: 50,
    onError,
  });
  await loop.stop();
  expect(onError.mock.calls[0]?.[0].message).toContain("threshold_ms=50");
  expect(() =>
    startTimerLoop({
      name: "cleanup",
      tick: async () => {},
      slowTickMs: 0,
      onError,
    }),
  ).toThrow("threshold");
});
