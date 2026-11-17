// @vitest-environment jsdom
import { sessionMaintenanceReasons } from "@cardigan/domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { fakeClient } from "../testing/fixtures.js";
import { sessionMaintenanceFixture } from "../testing/session-maintenance-fixture.js";
import { ExecutionPage } from "./ExecutionPage.js";

afterEach(cleanup);
test("maintenance reasons are readable in rows and drawer without claiming retirement", async () => {
  const data = sessionMaintenanceFixture();
  render(
    <ExecutionPage
      projectId="p-1"
      client={fakeClient({
        execution: async () => data,
        executionRuns: async () => ({ runs: [], total: 0, next_cursor: null }),
      })}
    />,
  );
  for (const a of data.assignments)
    expect(
      (
        await screen.findAllByText(
          sessionMaintenanceReasons[a.session_maintenance!.reason],
        )
      ).length,
    ).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole("button", { name: "查看 A-3 详情" })[0]!);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("当前运行时不支持会话回收")).toBeTruthy();
  expect(within(dialog).getByText("最近评估")).toBeTruthy();
  expect(within(dialog).getByText("60 分钟")).toBeTruthy();
  expect(within(dialog).getByText("空闲候选")).toBeTruthy();
  expect(dialog.textContent).not.toContain("已回收");
});
