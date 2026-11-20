// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RunLine } from "./ExecutionPage.js";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test("queue warning appears at the configured threshold without a new server event", () => {
  vi.useFakeTimers();
  const run = {
    id: "R-1",
    assignment_id: "A-1",
    status: "queued",
    kind: "initial",
    model: "test",
    role_version: 1,
    agent_cli_version: "test",
    summary: "",
    queue_ahead: 1,
    queue_warning: { after_minutes: 10, waited_ms: 9 * 60_000 },
  };
  const view = render(<RunLine run={run} />);
  fireEvent.focus(screen.getByRole("button"));
  act(() => vi.advanceTimersByTime(0));
  expect(screen.getByRole("tooltip").textContent).not.toContain("超过 10 分钟");
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("tooltip").textContent).toContain("超过 10 分钟");
  view.rerender(<RunLine run={{ ...run, status: "running" }} />);
  expect(screen.getByRole("tooltip").textContent).not.toContain("超过 10 分钟");
});

test("C-499: the execution badge distinguishes a failed startup and a paused profile from inactivity", () => {
  const run = {
    id: "R-8",
    assignment_id: "A-2",
    status: "cancelled",
    kind: "initial",
    model: "test",
    role_version: 1,
    agent_cli_version: "test",
    summary: "",
    outcome: "failed",
  };
  const view = render(
    <RunLine run={{ ...run, failure_reason: "provider_unavailable" }} />,
  );
  expect(screen.getByRole("button").textContent).toContain("模型服务不可用");
  view.rerender(
    <RunLine
      run={{
        ...run,
        status: "queued",
        outcome: null,
        queue_reason: "provider_unavailable",
      }}
    />,
  );
  expect(screen.getByRole("button").textContent).toContain("模型服务不可用");
});
