// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { fakeClient } from "../testing/fixtures.js";
import { ExecutionDiagnostics } from "./ExecutionDiagnostics.js";

afterEach(cleanup);
test("configuration, waiting, unknown and exit remain separate with explicit recovery paths", async () => {
  const onOpen = vi.fn();
  const client = fakeClient({
    executionDiagnostics: async () => ({
      configuration: [
        {
          profile: "synthetic-long-profile".repeat(3),
          code: "codex_approval",
          message: "审批策略可能等待交互确认；请由主机管理员核对生效配置。",
        },
      ],
      sessions: [
        "waiting_confirmation",
        "waiting_interaction",
        "runtime_exited",
        "unknown",
      ].map((cause, i) => ({
        assignment_id: `A-${i + 1}`,
        cause,
        action: "wait",
        evidence: [],
      })),
    }),
  });
  render(
    <ExecutionDiagnostics
      client={client}
      projectId="fixture"
      onOpen={onOpen}
    />,
  );
  const summary = await screen.findByText("启动与运行诊断（5）");
  fireEvent.click(summary);
  summary.closest("details")?.setAttribute("open", "");
  expect(screen.getByText("等待交互确认")).toBeTruthy();
  expect(screen.getByText("运行原因未知")).toBeTruthy();
  expect(screen.getByText(/停止已完成的会话可手工恢复/)).toBeTruthy();
  expect(screen.queryByText("线路连接失败")).toBeNull();
  const button = screen.getByRole("button", { name: "查看 A-1" });
  fireEvent.click(button);
  expect(onOpen).toHaveBeenCalledWith("A-1", button);
});
test("unavailable observations are never shown as healthy; refresh retries", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("synthetic-secret"))
    .mockResolvedValue({ configuration: [], sessions: [] });
  render(
    <ExecutionDiagnostics
      client={fakeClient({ executionDiagnostics: read })}
      projectId="fixture"
      onOpen={() => {}}
    />,
  );
  await screen.findByText("诊断不可用");
  screen
    .getByText("启动与运行诊断")
    .closest("details")
    ?.setAttribute("open", "");
  expect(screen.queryByText(/synthetic-secret/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "刷新诊断" }));
  await screen.findByText("没有告警");
});

test("expired runtime evidence disappears while configuration warnings remain", async () => {
  render(
    <ExecutionDiagnostics
      client={fakeClient({
        executionDiagnostics: async () => ({
          expires_at: "2000-01-01T00:00:00Z",
          configuration: [
            {
              profile: "fixture",
              code: "codex_approval",
              message: "审批策略待核对",
            },
          ],
          sessions: [
            {
              assignment_id: "A-1",
              cause: "waiting_confirmation",
              action: "wait",
              evidence: [],
            },
          ],
        }),
      })}
      projectId="fixture"
      onOpen={() => {}}
    />,
  );
  await screen.findByText("运行诊断已过期，请刷新");
  expect(screen.queryByText("等待交互确认")).toBeNull();
  expect(screen.getByText("审批策略待核对")).toBeTruthy();
});
test("an unconfigured reader never reports no warnings as a successful observation", async () => {
  render(
    <ExecutionDiagnostics
      client={fakeClient({
        executionDiagnostics: async () => ({
          available: false,
          configuration: [],
          sessions: [],
        }),
      })}
      projectId="fixture"
      onOpen={() => {}}
    />,
  );
  await screen.findByText("诊断不可用");
  expect(screen.queryByText("没有告警")).toBeNull();
});

test("legacy or malformed successful responses do not crash the execution page", async () => {
  render(
    <ExecutionDiagnostics
      client={fakeClient({
        executionDiagnostics: async () =>
          ({ assignments: [], runs: [] }) as never,
      })}
      projectId="fixture"
      onOpen={() => {}}
    />,
  );
  await screen.findByText("诊断不可用");
  expect(screen.queryByText("没有告警")).toBeNull();
});
