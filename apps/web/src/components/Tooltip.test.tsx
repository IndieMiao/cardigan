// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Tooltip } from "./Tooltip.js";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("hover waits 1000ms, leaving cancels it and reopening never skips the delay", () => {
  vi.useFakeTimers();
  render(
    <Tooltip content="查看详情">
      <button type="button">详情</button>
    </Tooltip>,
  );
  const trigger = screen.getByRole("button", { name: "详情" });
  fireEvent.pointerMove(trigger);
  act(() => vi.advanceTimersByTime(999));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.pointerLeave(trigger);
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.pointerMove(trigger);
  act(() => vi.advanceTimersByTime(999));
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("tooltip").textContent).toBe("查看详情");
  fireEvent.keyDown(trigger, { key: "Escape" });
  fireEvent.pointerLeave(trigger);
  fireEvent.pointerMove(trigger);
  act(() => vi.advanceTimersByTime(999));
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("tooltip")).toBeTruthy();
});

test("keyboard focus reveals the hint immediately and blur dismisses it", () => {
  vi.useFakeTimers();
  render(
    <Tooltip content="查看详情">
      <button type="button">详情</button>
    </Tooltip>,
  );
  const trigger = screen.getByRole("button", { name: "详情" });
  fireEvent.focus(trigger);
  expect(screen.getByRole("tooltip").textContent).toBe("查看详情");
  fireEvent.blur(trigger);
  expect(screen.queryByRole("tooltip")).toBeNull();
});
