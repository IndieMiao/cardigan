import { expect, test } from "vitest";
import { InFlightCalls, settleWithin } from "./in-flight.js";

test("C-847: one running call per key; settled calls, including failures, are dropped", async () => {
  const calls = new InFlightCalls();
  let starts = 0;
  let fail: (error: Error) => void = () => undefined;
  const start = () => {
    starts++;
    return new Promise<string>((_resolve, reject) => {
      fail = reject;
    });
  };
  const first = calls.run("k", start);
  const joined = calls.run("k", start);
  expect(joined).toBe(first);
  expect(starts).toBe(1);
  expect(calls.size).toBe(1);
  // Nobody awaits the failure here: it must not surface as unhandled.
  fail(new Error("verification failed"));
  await expect(first).rejects.toThrow("verification failed");
  expect(calls.size).toBe(0);
  const next = calls.run("k", async () => "fresh");
  expect(await next).toBe("fresh");
  expect(starts).toBe(1);
});

test("C-847: settleWithin answers within the budget or leaves the call running", async () => {
  expect(await settleWithin(Promise.resolve(1), 1000)).toEqual({ value: 1 });
  await expect(
    settleWithin(Promise.reject(new Error("refused")), 1000),
  ).rejects.toThrow("refused");
  let finish: (value: number) => void = () => undefined;
  const slow = new Promise<number>((resolve) => {
    finish = resolve;
  });
  expect(await settleWithin(slow, 5)).toBeUndefined();
  finish(2);
  expect(await slow).toBe(2);
});
