// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ExecutionAssignment, ExecutionData, RunView } from "../api.js";
import { executionSortKey } from "../execution-sort.js";
import { fakeClient } from "../testing/fixtures.js";
import { ExecutionPage } from "./ExecutionPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
const at = (minute: number) =>
  `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`;
const assignment = (
  n: number,
  extra: Partial<ExecutionAssignment> = {},
): ExecutionAssignment => ({
  ...base,
  id: `A-${n}`,
  card_id: `C-${n}`,
  work_item_id: `W-${n}`,
  ...extra,
});
const run = (n: number, extra: Partial<RunView>): RunView => ({
  id: `R-${n}`,
  assignment_id: `A-${n}`,
  status: "completed",
  kind: "initial",
  model: "m",
  role_version: 1,
  agent_cli_version: "1",
  summary: "",
  ...extra,
});

/**
 * A-1 oldest MCP activity; A-2 is running (started late); A-3 newest MCP
 * activity; A-4 is queued (queue time in the middle); A-5 never ran and is
 * released, so it only shows under "全部".
 */
const data: ExecutionData = {
  machines: [],
  assignments: [
    assignment(1, { last_mcp_activity_at: at(1) }),
    assignment(2, {
      runtime_state: "running",
      runtime_ref: { terminal_ref: "t", runtime_machine: "local" },
    }),
    assignment(3, { last_mcp_activity_at: at(9) }),
    assignment(4, { queue_ahead: 0 }),
    assignment(5, { status: "released" }),
  ],
  runs: [
    run(4, { status: "queued", queued_at: at(5) }),
    run(2, { status: "running", started_at: at(7) }),
    run(1, { finished_at: at(1) }),
  ],
};

const rowIds = () =>
  screen
    .getAllByRole("button", { name: /详情$/ })
    .map(
      (button) => /A-\d+/.exec(button.getAttribute("aria-label") ?? "")?.[0],
    );

const header = () => screen.getByRole("columnheader", { name: /最近活动/ });

function show(projectId = "p-1") {
  return render(
    <ExecutionPage
      projectId={projectId}
      client={fakeClient({ execution: async () => data })}
    />,
  );
}

test("C-73: newest activity first by default, running and queued work not pinned", async () => {
  window.location.hash = "#/p/p-1/execution?view=all";
  show();
  await screen.findByRole("table");
  expect(rowIds()).toEqual(["A-3", "A-2", "A-4", "A-1", "A-5"]);
  expect(header().getAttribute("aria-sort")).toBe("descending");
  // The queued Run shows its queue time as the activity time.
  const queuedRow = screen
    .getByRole("button", { name: "展开 A-4 详情" })
    .closest("tr");
  expect(within(queuedRow as HTMLElement).queryByText("尚无记录")).toBeNull();
});

test("C-73: the header toggles the direction and remembers it per project", async () => {
  window.location.hash = "#/p/p-1/execution?view=all";
  const view = show();
  await screen.findByRole("table");
  fireEvent.click(within(header()).getByRole("button", { name: /最近活动/ }));
  expect(header().getAttribute("aria-sort")).toBe("ascending");
  // Assignments without activity stay last in either direction.
  expect(rowIds()).toEqual(["A-1", "A-4", "A-2", "A-3", "A-5"]);
  expect(window.localStorage.getItem(executionSortKey("p-1"))).toBe("asc");
  view.unmount();

  show();
  await screen.findByRole("table");
  expect(header().getAttribute("aria-sort")).toBe("ascending");
  cleanup();

  // Another project keeps its own default.
  window.location.hash = "#/p/p-2/execution?view=all";
  show("p-2");
  await screen.findByRole("table");
  expect(header().getAttribute("aria-sort")).toBe("descending");
  fireEvent.click(within(header()).getByRole("button", { name: /最近活动/ }));
  fireEvent.click(within(header()).getByRole("button", { name: /最近活动/ }));
  expect(window.localStorage.getItem(executionSortKey("p-2"))).toBe("desc");
  expect(window.localStorage.getItem(executionSortKey("p-1"))).toBe("asc");
});

test("C-73: the working filter keeps the activity order", async () => {
  window.location.hash = "#/p/p-1/execution";
  show();
  await screen.findByRole("table");
  // 工作中: only the running and queued Assignments, still newest first.
  expect(rowIds()).toEqual(["A-2", "A-4"]);
  fireEvent.click(within(header()).getByRole("button", { name: /最近活动/ }));
  expect(rowIds()).toEqual(["A-4", "A-2"]);
});

test.each([
  [
    "unreadable storage",
    () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("denied");
      });
    },
  ],
  [
    "bad stored value",
    () => {
      window.localStorage.setItem(executionSortKey("p-1"), "sideways");
    },
  ],
])(
  "C-73: %s falls back to newest first and toggling still works",
  async (_, setup) => {
    setup();
    window.location.hash = "#/p/p-1/execution?view=all";
    show();
    await screen.findByRole("table");
    expect(header().getAttribute("aria-sort")).toBe("descending");
    expect(rowIds()[0]).toBe("A-3");
    fireEvent.click(within(header()).getByRole("button", { name: /最近活动/ }));
    expect(header().getAttribute("aria-sort")).toBe("ascending");
  },
);
