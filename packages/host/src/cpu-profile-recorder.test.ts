import { url } from "node:inspector";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type CpuProfileLimits,
  CpuProfileRecorder,
  type CpuProfileSession,
} from "./cpu-profile-recorder.js";

// Synthetic test policy only; these are not proposed production defaults.
const limits: CpuProfileLimits = {
  minDurationMs: 5,
  maxDurationMs: 25,
  minSamplingIntervalUs: 100,
  maxSamplingIntervalUs: 200,
};
const request = { durationMs: 10, samplingIntervalUs: 100 };
const profile = { nodes: [], startTime: 1, endTime: 2, samples: [] };
const recorders: CpuProfileRecorder[] = [];
const releases: Array<() => void> = [];

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}

function fakeSession() {
  return {
    connect: vi.fn(),
    enable: vi.fn(async () => {}),
    setSamplingInterval: vi.fn(async (_interval: number) => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => profile),
    disable: vi.fn(async () => {}),
    disconnect: vi.fn(),
  } satisfies CpuProfileSession;
}

function recorder(session?: () => CpuProfileSession) {
  const instance = new CpuProfileRecorder(limits, session);
  recorders.push(instance);
  return instance;
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(recorders.splice(0).map((instance) => instance.close()));
  vi.useRealTimers();
});

test("construction and idle close do not create an inspector session", async () => {
  const factory = vi.fn(fakeSession);
  const instance = recorder(factory);
  expect(factory).not.toHaveBeenCalled();
  await instance.close();
  expect(factory).not.toHaveBeenCalled();
  expect(await instance.record(request)).toEqual({ status: "closed" });
});

test.each([
  { ...limits, minDurationMs: 0 },
  { ...limits, maxDurationMs: 4 },
  { ...limits, minSamplingIntervalUs: 201 },
  { ...limits, maxSamplingIntervalUs: Number.NaN },
  { ...limits, maxDurationMs: 2 ** 31 },
])(
  "rejects invalid injected limits before creating a Session (%j)",
  (policy) => {
    const factory = vi.fn(fakeSession);
    expect(() => new CpuProfileRecorder(policy, factory)).toThrow(
      "Invalid CPU profile limits",
    );
    expect(factory).not.toHaveBeenCalled();
  },
);

test.each([
  { ...request, durationMs: 4 },
  { ...request, durationMs: 26 },
  { ...request, durationMs: 10.5 },
  { ...request, durationMs: Number.POSITIVE_INFINITY },
  { ...request, samplingIntervalUs: 99 },
  { ...request, samplingIntervalUs: 201 },
  { ...request, samplingIntervalUs: Number.NaN },
])("invalid requests never connect inspector (%j)", async (input) => {
  const factory = vi.fn(fakeSession);
  expect(await recorder(factory).record(input)).toEqual({
    status: "invalid_request",
  });
  expect(factory).not.toHaveBeenCalled();
});

test.each([5, 25])(
  "accepts duration boundary %i with an explicit interval",
  async (durationMs) => {
    const session = fakeSession();
    const result = recorder(() => session).record({
      durationMs,
      samplingIntervalUs: 200,
    });
    await vi.advanceTimersByTimeAsync(durationMs);
    expect(await result).toEqual({
      status: "completed",
      profile,
      reason: "duration",
    });
    expect(session.setSamplingInterval).toHaveBeenCalledWith(200);
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(session.disable).toHaveBeenCalledTimes(1);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
  },
);

test("mutex spans startup and cleanup across recorder instances", async () => {
  const enabled = deferred();
  const disabled = deferred();
  const session = fakeSession();
  session.enable.mockImplementation(() => enabled.promise);
  session.disable.mockImplementation(() => disabled.promise);
  const first = recorder(() => session);
  const secondFactory = vi.fn(fakeSession);
  const second = recorder(secondFactory);
  const result = first.record(request);
  expect(await second.record(request)).toEqual({ status: "busy" });
  expect(await first.record(request)).toEqual({ status: "busy" });
  expect(secondFactory).not.toHaveBeenCalled();
  enabled.release();
  await vi.advanceTimersByTimeAsync(request.durationMs);
  expect(session.stop).toHaveBeenCalledTimes(1);
  expect(await second.record(request)).toEqual({ status: "busy" });
  disabled.release();
  expect((await result).status).toBe("completed");
  const retry = second.record(request);
  await vi.advanceTimersByTimeAsync(request.durationMs);
  expect((await retry).status).toBe("completed");
});

test("pre-cancelled requests create no session", async () => {
  const factory = vi.fn(fakeSession);
  expect(
    await recorder(factory).record({
      ...request,
      signal: AbortSignal.abort(),
    }),
  ).toEqual({ status: "cancelled" });
  expect(factory).not.toHaveBeenCalled();
});

test("close during enable waits for cleanup and never starts sampling", async () => {
  const enabled = deferred();
  const session = fakeSession();
  session.enable.mockImplementation(() => enabled.promise);
  const instance = recorder(() => session);
  const result = instance.record(request);
  const closed = vi.fn();
  const closing = instance.close().then(closed);
  await Promise.resolve();
  expect(closed).not.toHaveBeenCalled();
  enabled.release();
  await closing;
  expect(await result).toEqual({ status: "cancelled" });
  expect(session.start).not.toHaveBeenCalled();
  expect(session.disable).toHaveBeenCalledTimes(1);
  expect(session.disconnect).toHaveBeenCalledTimes(1);
});

test("cancellation during sampling stops promptly and discards the profile", async () => {
  const session = fakeSession();
  const cancel = new AbortController();
  const instance = recorder(() => session);
  const result = instance.record({ ...request, signal: cancel.signal });
  await vi.advanceTimersByTimeAsync(1);
  expect(session.start).toHaveBeenCalledTimes(1);
  cancel.abort();
  expect(await result).toEqual({ status: "cancelled" });
  expect(session.stop).toHaveBeenCalledTimes(1);
  expect(session.disconnect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  await instance.close();
  await instance.close();
  expect(session.disconnect).toHaveBeenCalledTimes(1);
});

test("close during disable preserves complete data and marks the early stop", async () => {
  const disabled = deferred();
  const session = fakeSession();
  session.disable.mockImplementation(() => disabled.promise);
  const instance = recorder(() => session);
  const result = instance.record(request);
  await vi.advanceTimersByTimeAsync(request.durationMs);
  const closing = instance.close();
  disabled.release();
  await closing;
  expect(await result).toEqual({
    status: "completed",
    profile,
    reason: "stopped",
  });
});

test("graceful shutdown stops sampling promptly and returns data for atomic publication", async () => {
  const session = fakeSession();
  const instance = recorder(() => session);
  const result = instance.record(request);
  await vi.advanceTimersByTimeAsync(1);
  expect(await instance.close()).toEqual({
    status: "completed",
    profile,
    reason: "stopped",
  });
  expect(await result).toEqual({
    status: "completed",
    profile,
    reason: "stopped",
  });
  expect(session.stop).toHaveBeenCalledTimes(1);
  expect(session.disconnect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(await instance.record(request)).toEqual({ status: "closed" });
});

test("shutdown during start waits for stop and preserves complete data", async () => {
  const started = deferred();
  const session = fakeSession();
  session.start.mockImplementation(() => started.promise);
  const instance = recorder(() => session);
  const result = instance.record(request);
  await vi.advanceTimersByTimeAsync(1);
  expect(session.start).toHaveBeenCalledTimes(1);
  const closing = instance.close();
  expect(session.disconnect).not.toHaveBeenCalled();
  started.release();
  expect(await closing).toEqual({
    status: "completed",
    profile,
    reason: "stopped",
  });
  expect((await result).status).toBe("completed");
  expect(session.stop).toHaveBeenCalledTimes(1);
});

test("a normal manual stop allows a later capture", async () => {
  const instance = recorder(fakeSession);
  const first = instance.record(request);
  await vi.advanceTimersByTimeAsync(1);
  expect((await instance.stop())?.status).toBe("completed");
  expect((await first).status).toBe("completed");
  const second = instance.record(request);
  await vi.advanceTimersByTimeAsync(request.durationMs);
  expect(await second).toEqual({
    status: "completed",
    profile,
    reason: "duration",
  });
});

test("explicit cancellation during disable discards successfully stopped data", async () => {
  const disabled = deferred();
  const session = fakeSession();
  session.disable.mockImplementation(() => disabled.promise);
  const instance = recorder(() => session);
  const cancel = new AbortController();
  const result = instance.record({ ...request, signal: cancel.signal });
  await vi.advanceTimersByTimeAsync(request.durationMs);
  cancel.abort();
  disabled.release();
  expect(await result).toEqual({ status: "cancelled" });
});

test.each([
  "enable",
  "setSamplingInterval",
  "start",
  "stop",
  "disable",
] as const)(
  "%s failure disconnects and releases ownership without exposing errors",
  async (stage) => {
    const session = fakeSession();
    session[stage].mockRejectedValueOnce(new Error("synthetic-private-value"));
    const instance = recorder(() => session);
    const result = instance.record(request);
    await vi.advanceTimersByTimeAsync(request.durationMs);
    expect(await result).toEqual({ status: "failed" });
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    const retry = instance.record(request);
    await vi.advanceTimersByTimeAsync(request.durationMs);
    expect((await retry).status).toBe("completed");
  },
);

test("Session factory and connect errors also release ownership", async () => {
  const factory = vi.fn(() => {
    throw new Error("synthetic-private-value");
  });
  expect(await recorder(factory).record(request)).toEqual({ status: "failed" });
  const session = fakeSession();
  session.connect.mockImplementation(() => {
    throw new Error("synthetic-private-value");
  });
  expect(await recorder(() => session).record(request)).toEqual({
    status: "failed",
  });
  expect(session.disconnect).toHaveBeenCalledTimes(1);
});

test("a real in-process Session captures without opening a debug port", async () => {
  vi.useRealTimers();
  const before = url();
  const instance = recorder();
  const result = await instance.record(request);
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw new Error("Capture failed");
  expect(result.profile.nodes.length).toBeGreaterThan(0);
  expect(result.profile.endTime).toBeGreaterThan(result.profile.startTime);
  expect(url()).toBe(before);
  await instance.close();
});

test("an unconfirmed disconnect fails closed instead of admitting another Session", async () => {
  // Isolate this module's permanent guard from other cases, including shuffle.
  vi.resetModules();
  const { CpuProfileRecorder: IsolatedRecorder } = await import(
    "./cpu-profile-recorder.js"
  );
  const session = fakeSession();
  session.disconnect.mockImplementation(() => {
    throw new Error("synthetic-private-value");
  });
  const first = new IsolatedRecorder(limits, () => session);
  recorders.push(first);
  const result = first.record(request);
  await vi.advanceTimersByTimeAsync(request.durationMs);
  expect(await result).toEqual({ status: "failed" });
  const next = vi.fn(fakeSession);
  const second = new IsolatedRecorder(limits, next);
  recorders.push(second);
  expect(await second.record(request)).toEqual({ status: "busy" });
  expect(next).not.toHaveBeenCalled();
});
