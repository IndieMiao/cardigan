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

test("C-499: the execution badge distinguishes a failed startup and a paused profile from inactivity", async () => {
  const run = {
    id: "R-8",
    launch_profile_ref: "relay",
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
  fireEvent.focus(screen.getByRole("button"));
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toContain("最近执行：模型服务不可用");
  expect(tip.textContent).toContain("启动配置：relay");
  expect(tip.textContent).not.toContain("自动重派");
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
  expect(tip.textContent).toContain("等待模型服务恢复后自动重派");
  expect(tip.textContent).not.toContain("最近执行：");
});

test("C-736: the Run details say whether admission reserved resources and why", async () => {
  const run = {
    id: "R-9",
    assignment_id: "A-3",
    status: "running",
    kind: "followup",
    model: "test",
    role_version: 1,
    agent_cli_version: "test",
    summary: "",
    resource_keys: ["godot"],
    resource_reason: "PM 评论，工作项处于 in_progress",
  };
  const view = render(<RunLine run={run} />);
  fireEvent.focus(screen.getByRole("button"));
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toContain(
    "已预留 godot：PM 评论，工作项处于 in_progress",
  );
  view.rerender(
    <RunLine
      run={{ ...run, resource_keys: [], resource_reason: "普通讨论评论" }}
    />,
  );
  expect(tip.textContent).toContain("未占用资源：普通讨论评论");
  view.rerender(
    <RunLine
      run={{ ...run, resource_keys: undefined, resource_reason: undefined }}
    />,
  );
  expect(tip.textContent).not.toContain("资源");
});
