// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunLine } from "./ExecutionPage.js";

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
  expect(screen.queryByRole("note")).toBeNull();
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("note").textContent).toContain("超过 10 分钟");
  view.rerender(<RunLine run={{ ...run, status: "running" }} />);
  expect(screen.queryByRole("note")).toBeNull();
});
