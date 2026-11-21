// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExecutionAssignment, ExecutionData } from "../api.js";
import { changeControl } from "../testing/controls.js";
import { fakeClient } from "../testing/fixtures.js";
import { ExecutionPage } from "./ExecutionPage.js";

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
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

const base: ExecutionAssignment = {
  id: "A-1",
  role_id: "coder",
  role_version: 1,
  status: "active",
  runtime_state: "idle",
  machine_id: "local",
  standing_mode: null,
  card_id: "C-1",
  card_status: "in_progress",
  work_item_id: "W-1",
  worktree_path: null,
  branch: null,
  session_ref: null,
  runtime_ref: null,
  last_mcp_activity_at: null,
  cursors: [],
};
const employee = (id: string, name: string) => ({
  id,
  name,
  title: "开发工程师",
  avatar: null,
});

/** C-518: A-2 belongs to 八戒 but its card title names 悟空. */
const data: ExecutionData = {
  machines: [],
  runs: [],
  assignments: [
    {
      ...base,
      employee: employee("E-3", "悟空"),
      card_title: "整理模型页",
    },
    {
      ...base,
      id: "A-2",
      card_id: "C-2",
      work_item_id: "W-2",
      employee: employee("E-4", "八戒"),
      card_title: "给悟空核对配置",
    },
  ],
};

const rowIds = () =>
  screen
    .queryAllByRole("button", { name: /查看 A-\d+ 详情$/ })
    .map(
      (button) => /A-\d+/.exec(button.getAttribute("aria-label") ?? "")?.[0],
    );

const show = () =>
  render(
    <ExecutionPage
      projectId="p-1"
      client={fakeClient({ execution: async () => data })}
    />,
  );

test("an employee link shows only that employee's records, not text matches", async () => {
  window.location.hash = "#/p/p-1/execution?view=all&employee=E-3";
  show();
  await waitFor(() => expect(rowIds()).toEqual(["A-1"]));
  // The narrowing is visible and clearable in its own control.
  const select = screen.getByRole("combobox", { name: "员工：悟空" });
  expect(select.textContent).toBe("员工：悟空");
  changeControl(select, { target: { value: "" } });
  await waitFor(() => expect(rowIds().sort()).toEqual(["A-1", "A-2"]));
  expect(window.location.hash).toBe("#/p/p-1/execution?view=all");
  expect(screen.queryByRole("combobox", { name: /^员工：/ })).toBeNull();
});

test("an employee without records reads as empty", async () => {
  window.location.hash = "#/p/p-1/execution?view=all&employee=E-9";
  show();
  expect(await screen.findByText("没有匹配的执行记录")).toBeTruthy();
  expect(rowIds()).toEqual([]);
});

test("without an employee link the toolbar has no employee control", async () => {
  window.location.hash = "#/p/p-1/execution?view=all";
  show();
  await waitFor(() => expect(rowIds()).toHaveLength(2));
  expect(screen.queryByRole("combobox", { name: /^员工：/ })).toBeNull();
});
