// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { StreamCallbacks } from "./stream.js";
import { fakeClient } from "./testing/fixtures.js";
import { useProjectStream } from "./useProjectStream.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test("shared Needs You keys represent complete stream versions across batches and reconnects", () => {
  vi.useFakeTimers();
  const subscriptions: StreamCallbacks[] = [];
  const client = fakeClient({
    subscribe: (_project, callbacks) => {
      subscriptions.push(callbacks);
      return () => {};
    },
  });
  const expired = () => {};
  const a = renderHook(
    ({ project }) => useProjectStream(client, project, expired),
    { initialProps: { project: "p" } },
  );
  const b = renderHook(() => useProjectStream(client, "p", expired));
  const first = subscriptions[0],
    second = subscriptions[1];
  if (!first || !second) throw new Error("missing subscriptions");
  const emit = (s: StreamCallbacks, stream: string, seq = 100) =>
    s.change({ stream, seq, type: "decision_requested" });
  act(() => {
    emit(first, "C-2");
    vi.advanceTimersByTime(100);
  });
  const old = a.result.current.needsKey;
  act(() => {
    emit(second, "C-1");
    emit(second, "C-2");
    vi.advanceTimersByTime(100);
  });
  expect(b.result.current.needsKey).not.toBe(old);
  act(() => {
    emit(first, "C-1");
    vi.advanceTimersByTime(100);
  });
  expect(a.result.current.needsKey).toBe(b.result.current.needsKey);
  const current = a.result.current.needsKey;
  act(() => {
    emit(first, "C-1", 99);
    vi.advanceTimersByTime(100);
  });
  expect(a.result.current.needsKey).toBe(current);
  act(() => {
    first.ready();
    vi.advanceTimersByTime(100);
  });
  expect(a.result.current.needsKey).not.toBe(current);
  act(() => {
    second.ready();
    vi.advanceTimersByTime(100);
  });
  expect(a.result.current.needsKey).toBe(b.result.current.needsKey);
  a.rerender({ project: "other" });
  expect(a.result.current.needsKey).toBe("initial");
});
