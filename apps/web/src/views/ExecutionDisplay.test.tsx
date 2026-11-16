// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  executionDisplayKey,
  readExecutionDisplay,
} from "../execution-display.js";
import { executionStateRank } from "../execution-sort.js";
import { executionDisplayFixture } from "../testing/execution-display-fixture.js";
import { fakeClient } from "../testing/fixtures.js";
import { ExecutionPage } from "./ExecutionPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
const fixture = executionDisplayFixture();
const client = fakeClient({
  execution: async () => fixture,
  executionRuns: async () => ({ runs: [], total: 0, next_cursor: null }),
});
const show = (projectId = "p-1") =>
  render(<ExecutionPage client={client} projectId={projectId} />);
const ids = () =>
  screen
    .getAllByRole("button", { name: /查看 A-\d+ 详情/ })
    .map((b) => b.textContent);
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));

test("state buckets cover existing runtime values without treating historical success as termination", () => {
  const base = fixture.assignments[0];
  if (!base) throw new Error("Missing fixture");
  expect(
    [
      "running",
      "provisioning",
      "unknown",
      "lost",
      "idle",
      "not_provisioned",
      "released",
    ].map((runtime_state) => executionStateRank({ ...base, runtime_state })),
  ).toEqual([0, 1, 2, 2, 3, 3, 4]);
  expect(executionStateRank({ ...base, status: "released" })).toBe(4);
  expect(executionStateRank({ ...base, external: true })).toBe(3);
  expect(
    executionStateRank({ ...base, runtime_state: "idle" }, fixture.runs[3]),
  ).toBe(3);
});

test("status order is stable, reversible, exclusive with activity, and includes missing Runs", async () => {
  window.location.hash = "#/p/p-1/execution?view=all";
  show();
  await screen.findByRole("table");
  click(/运行状态未排序/);
  expect(ids()).toEqual([
    "A-1",
    "A-2",
    "A-7",
    "A-3",
    "A-8",
    "A-5",
    "A-4",
    "A-6",
  ]);
  expect(
    screen
      .getByRole("columnheader", { name: /运行状态/ })
      .getAttribute("aria-sort"),
  ).toBe("ascending");
  expect(
    screen
      .getByRole("columnheader", { name: /最近活动/ })
      .getAttribute("aria-sort"),
  ).toBe("none");
  expect(screen.getByText("状态未知")).toBeTruthy();
  click(/运行状态升序/);
  expect(ids()).toEqual([
    "A-6",
    "A-8",
    "A-5",
    "A-4",
    "A-7",
    "A-3",
    "A-2",
    "A-1",
  ]);
  click(/最近活动未排序/);
  expect(ids()).toEqual([
    "A-8",
    "A-7",
    "A-6",
    "A-5",
    "A-4",
    "A-3",
    "A-2",
    "A-1",
  ]);
});

test.each([false, true])(
  "employee grouping/collapse and lanes share filters; narrow=%s",
  async (narrow) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: narrow,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const view = show();
    await screen.findByRole("button", { name: "查看 A-1 详情" });
    // Working excludes lost/released but retains standing and external identities.
    expect(ids()).toEqual(["A-8", "A-7", "A-5", "A-4", "A-2", "A-1"]);
    click("按员工分组");
    expect(screen.getByText("2 个 Assignment · 1 个运行中")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "折叠赵云分组" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "查看 A-1 详情" })).toBeNull();
    click("展开赵云分组");
    expect(ids().slice(-2)).toEqual(["A-2", "A-1"]);
    click("卡片");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("region", { name: /泳道$/ })).toHaveLength(6);
    const lane = screen.getByRole("region", { name: "赵云泳道" });
    expect(within(lane).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(lane).getAllByText("codex / fixture-model / high").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("主机运维（常驻）")).toBeTruthy();
    expect(screen.getByText("常驻 PM · 后台")).toBeTruthy();
    click("查看 A-1 详情");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("尚无 Run。")).toBeTruthy();
    view.unmount();
    show();
    await screen.findByRole("region", { name: "员工泳道" });
    click("表格");
    expect(
      screen
        .getByRole("button", { name: "按员工分组" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  },
);

test("equal employee names stay separate, absent identities get a fallback, and empty filters have no lanes", async () => {
  window.location.hash = "#/p/p-1/execution?view=all";
  const view = show();
  await screen.findByRole("table");
  click("卡片");
  expect(screen.getAllByRole("region", { name: "赵云泳道" })).toHaveLength(2);
  expect(screen.getByRole("region", { name: "未分配员工泳道" })).toBeTruthy();
  view.unmount();
  render(
    <ExecutionPage
      projectId="p-1"
      client={fakeClient({
        execution: async () => ({ assignments: [], runs: [], machines: [] }),
      })}
    />,
  );
  expect(await screen.findByText(/没有符合条件的 Assignment/)).toBeTruthy();
  expect(screen.queryByRole("region", { name: "员工泳道" })).toBeNull();
});

test("display and sort survive remount, are project/browser local, and ignore broken storage", async () => {
  window.location.hash = "#/p/p-1/execution?view=all";
  const view = show();
  await screen.findByRole("table");
  click("按员工分组");
  click(/运行状态未排序/);
  click("卡片");
  view.unmount();
  const again = show();
  await screen.findByRole("region", { name: "员工泳道" });
  expect(screen.getByRole("button", { name: /运行状态升序/ })).toBeTruthy();
  again.unmount();
  const other = show("p-2");
  await screen.findByRole("table");
  expect(
    screen
      .getByRole("button", { name: "按员工分组" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  other.unmount();
  // A separate browser user's storage namespace has no preferences.
  vi.spyOn(Storage.prototype, "getItem").mockReturnValue(null);
  const separate = show();
  await screen.findByRole("table");
  expect(
    screen
      .getByRole("columnheader", { name: /最近活动/ })
      .getAttribute("aria-sort"),
  ).toBe("descending");
  separate.unmount();
  vi.restoreAllMocks();
  localStorage.setItem(executionDisplayKey("p-1"), "{");
  expect(readExecutionDisplay("p-1")).toEqual({
    mode: "table",
    grouped: false,
  });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  show();
  await screen.findByRole("table");
  click("卡片");
  expect(screen.getByRole("region", { name: "员工泳道" })).toBeTruthy();
});
