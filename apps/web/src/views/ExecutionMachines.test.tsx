// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExecutionAssignment, ExecutionData, RunView } from "../api.js";
import { CapacityProvider } from "../components/Capacity.js";
import {
  assignmentMachine,
  machineLabel,
  runMachine,
} from "../execution-machine.js";
import { changeControl } from "../testing/controls.js";
import { executionDisplayFixture } from "../testing/execution-display-fixture.js";
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
  window.location.hash = "#/p/p-1/execution?view=all";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  window.location.hash = "";
});
const fixture = (): ExecutionData => {
  const data = executionDisplayFixture();
  return {
    machines: [
      { id: "local", label: "工作机", status: "online" },
      { id: "remote", label: "远端构建机", status: "online" },
    ],
    assignments: data.assignments.map((a, i) => ({
      ...a,
      external: false,
      machine_id: "local",
      runtime_ref: {
        machine_id: i % 2 ? "remote" : "local",
        runtime_machine: "runtime-host",
        terminal_ref: `t-${i}`,
      },
    })),
    runs: data.runs.map((r) => ({
      ...r,
      recovery_runtime: { machine_id: "remote", runtime_machine: "old-host" },
    })),
  };
};
const ids = () =>
  screen
    .getAllByRole("button", { name: /查看 A-\d+ 详情/ })
    .map((b) => b.textContent);
function displayItem(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: "显示" }), {
    key: "ArrowDown",
  });
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
}
function show(data = fixture()) {
  return render(
    <ExecutionPage
      projectId="p-1"
      client={fakeClient({
        execution: async () => data,
        executionRuns: async (_project, id) => ({
          runs: data.runs.filter((r) => r.assignment_id === id),
          total: 1,
          next_cursor: null,
        }),
      })}
    />,
  );
}

test("runtime bindings take precedence for standing roles, unknown identifiers remain visible, history never borrows a current machine", () => {
  const data = fixture();
  const a = data.assignments[3] as ExecutionAssignment;
  expect(assignmentMachine(a, data.machines)).toBe("remote");
  expect(
    assignmentMachine(
      { ...a, runtime_ref: { terminal_ref: "t", runtime_machine: "remote" } },
      data.machines,
    ),
  ).toBe("remote");
  expect(assignmentMachine({ ...a, runtime_ref: null }, data.machines)).toBe(
    "local",
  );
  expect(machineLabel("removed-worker", data.machines)).toBe("removed-worker");
  const run = data.runs[0] as RunView;
  expect(runMachine(run)).toBe("remote");
  expect(runMachine({ ...run, recovery_runtime: undefined })).toBe("");
  expect(
    runMachine({
      ...run,
      recovery_runtime: undefined,
      launch_publication: {
        runtime_ref: { machine_id: "local", runtime_machine: "host" },
      },
    }),
  ).toBe("local");
});

test.each([false, true])(
  "machine filter, grouped tables/cards and identities agree; narrow=%s",
  async (narrow) => {
    vi.stubGlobal("matchMedia", () => ({
      matches: narrow,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    show();
    await screen.findByRole("button", { name: "查看 A-1 详情" });
    const pm = screen
      .getByRole("button", { name: "查看 A-4 详情" })
      .closest("tr,li") as HTMLElement;
    expect(within(pm).getAllByLabelText("机器：远端构建机")[0]).toBeTruthy();
    const ops = screen
      .getByRole("button", { name: "查看 A-5 详情" })
      .closest("tr,li") as HTMLElement;
    expect(within(ops).getByLabelText("机器：工作机")).toBeTruthy();
    changeControl(screen.getByRole("combobox", { name: /^机器：/ }), {
      target: { value: "remote" },
    });
    expect(ids()).toEqual(["A-8", "A-6", "A-4", "A-2"]);
    expect(location.hash).toContain("machine=remote");
    displayItem("分组字段：机器");
    const collapse = screen.getByRole("button", { name: "折叠远端构建机分组" });
    fireEvent.click(collapse);
    expect(screen.queryByRole("button", { name: "查看 A-4 详情" })).toBeNull();
    fireEvent.click(collapse);
    fireEvent.click(screen.getByRole("button", { name: "卡片" }));
    const lane = screen.getByRole("region", { name: "远端构建机泳道" });
    expect(within(lane).getAllByRole("listitem")).toHaveLength(4);
    const pmCard = within(lane).getByRole("listitem", { name: "王熙凤 A-4" });
    expect(within(pmCard).getByText("王熙凤")).toBeTruthy();
    changeControl(screen.getByRole("combobox", { name: /^机器：/ }), {
      target: { value: "" },
    });
    expect(screen.getByRole("region", { name: "工作机泳道" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "主机运维" },
    });
    // Search includes role ids; use the role's recorded identifier.
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "host_ops" },
    });
    expect(ids()).toEqual(["A-5"]);
  },
);

test("Run history uses its dispatch machine even after the Assignment moves; missing history stays explicit", async () => {
  const data = fixture();
  const first = data.runs[0] as RunView;
  show({
    ...data,
    runs: [first, { ...first, id: "R-9", recovery_runtime: undefined }],
  });
  fireEvent.click(await screen.findByRole("button", { name: "查看 A-1 详情" }));
  const history = await screen.findByRole("region", { name: "A-1 Run 历史" });
  expect(
    await within(history).findByLabelText("机器：远端构建机"),
  ).toBeTruthy();
  expect(within(history).getByLabelText("机器：未记录")).toBeTruthy();
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByLabelText("机器：工作机")).toBeTruthy();
  expect(within(dialog).getByText("t-0")).toBeTruthy();
  expect(dialog.textContent).not.toContain("runtime-host");
});

test("refresh defaults to 30 seconds, is remembered by project, and supports manual refresh", async () => {
  vi.useFakeTimers();
  const execution = vi.fn(async () => fixture());
  const client = fakeClient({ execution });
  const view = render(<ExecutionPage projectId="p-1" client={client} />);
  await act(async () => {});
  expect(screen.getByRole("combobox", { name: "自动刷新" }).textContent).toBe(
    "30 秒",
  );
  fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
  await act(async () => {});
  expect(execution).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(execution).toHaveBeenCalledTimes(3);
  changeControl(screen.getByRole("combobox", { name: "自动刷新" }), {
    target: { value: "10000" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(execution).toHaveBeenCalledTimes(4);
  view.unmount();
  render(<ExecutionPage projectId="p-2" client={client} />);
  await act(async () => {});
  expect(screen.getByRole("combobox", { name: "自动刷新" }).textContent).toBe(
    "30 秒",
  );
  expect(localStorage.getItem("cardigan.execution.refresh.p-1")).toBe("10000");
});

test("saved refresh-off survives remount and pending refresh keeps focus without duplicate requests", async () => {
  localStorage.setItem("cardigan.execution.refresh.p-1", "0");
  const request = Promise.withResolvers<ExecutionData>();
  const execution = vi
    .fn()
    .mockResolvedValueOnce(fixture())
    .mockReturnValue(request.promise);
  render(<ExecutionPage projectId="p-1" client={fakeClient({ execution })} />);
  await screen.findByRole("button", { name: "查看 A-1 详情" });
  expect(screen.getByRole("combobox", { name: "自动刷新" }).textContent).toBe(
    "关闭",
  );
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(execution).toHaveBeenCalledTimes(1);
  const refresh = screen.getByRole("button", { name: "立即刷新" });
  refresh.focus();
  fireEvent.click(refresh);
  expect(refresh.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(refresh);
  fireEvent.click(refresh);
  expect(execution).toHaveBeenCalledTimes(2);
  await act(async () => {
    request.resolve(fixture());
  });
  expect(refresh.getAttribute("aria-disabled")).toBe("false");
  expect(document.activeElement).toBe(refresh);
});

test("a retired machine from an old link stays visible in the machine dropdown and clears there", async () => {
  window.location.hash = "#/p/p-1/execution?view=all&machine=retired-worker";
  show();
  const machine = await screen.findByRole("combobox", {
    name: "机器：retired-worker",
  });
  await waitFor(() =>
    expect(document.querySelector(".ui-page-count")?.textContent).toBe("0 / 8"),
  );
  expect(machine.textContent).toContain("retired-worker");
  expect(screen.queryByRole("button", { name: /^移除/ })).toBeNull();
  changeControl(machine, { target: { value: "" } });
  await waitFor(() => expect(ids()).toHaveLength(8));
  expect(screen.getByRole("combobox", { name: "机器：全部" })).toBeTruthy();
  expect(location.hash).not.toContain("machine=");
});

test("MC-5 machine list shows health and capacity; the drawer lists tags, resources and verified/expired capabilities", async () => {
  const data = fixture();
  const machines: ExecutionData["machines"] = [
    {
      id: "local",
      label: "工作机",
      status: "online",
      os: "linux",
      arch: "x64",
      tags: ["fast-disk", "office"],
      health: {
        status: "passed",
        checked_at: "2026-01-01T00:00:00.000Z",
        blockers: [],
        available: true,
      },
      capabilities: [
        {
          key: "node",
          version: "24.22.2",
          verified_at: "2026-01-01T00:00:00.000Z",
          available: true,
        },
        {
          key: "blender",
          version: "4.2.0",
          verified_at: "2025-12-30T00:00:00.000Z",
          available: false,
        },
      ],
    },
    {
      id: "remote",
      label: "远端构建机",
      status: "draining",
      health: {
        status: "failed",
        checked_at: "2026-01-01T00:00:00.000Z",
        blockers: ["machine_not_ready", "custom_code"],
        available: false,
      },
      capabilities: [],
    },
  ];
  render(
    <CapacityProvider
      client={fakeClient({
        executionCapacity: async () => ({
          agents: [
            {
              machine_id: "local",
              label: "工作机",
              running: 2,
              total_running: 3,
              limit: 4,
              max_limit: 8,
              queued: 1,
              merge_check_slots: 0,
              resources: [
                { key: "blender", occupied: 2, limit: 2 },
                { key: "ios.simulator", occupied: 0, limit: 1 },
              ],
            },
          ],
          merge_checks: [],
          merge_config_invalid: false,
        }),
      })}
      projectId="p-1"
      revision={0}
      canEdit={false}
    >
      <ExecutionPage
        projectId="p-1"
        client={fakeClient({
          execution: async () => ({ ...data, machines }),
          executionRuns: async () => ({
            runs: [],
            total: 0,
            next_cursor: null,
          }),
        })}
      />
    </CapacityProvider>,
  );
  const open = await screen.findByRole("button", {
    name: "查看 工作机 机器详情",
  });
  const row = open.closest("li") as HTMLElement;
  expect(within(row).getByText("健康")).toBeTruthy();
  await waitFor(() => expect(row.textContent).toContain("容量 2/4"));
  expect(row.textContent).toContain("能力 1");
  const remote = screen
    .getByRole("button", { name: "查看 远端构建机 机器详情" })
    .closest("li") as HTMLElement;
  expect(within(remote).getByText("健康检查失败")).toBeTruthy();
  expect(within(remote).getByText("停止接收新任务")).toBeTruthy();

  open.focus();
  fireEvent.click(open);
  const drawer = await screen.findByRole("dialog", {
    name: "工作机 机器详情",
  });
  expect(open.getAttribute("aria-expanded")).toBe("true");
  expect(within(drawer).getByText("linux / x64")).toBeTruthy();
  expect(within(drawer).getByText("fast-disk、office")).toBeTruthy();
  expect(drawer.textContent).toContain("非常驻 2 / 上限 4 · 全部 3 · 排队 1");
  const resources = within(drawer).getByRole("region", {
    name: "工作机 资源占用",
  });
  expect(resources.textContent).toContain("blender2/2");
  expect(resources.textContent).toContain("ios.simulator0/1");
  const capabilities = within(drawer).getByRole("region", {
    name: "工作机 能力",
  });
  const items = within(capabilities).getAllByRole("listitem");
  // Verified first, then expired (greyed with the subdued status).
  expect(items[0]?.textContent).toContain("已验证node 24.22.2验证于");
  expect(items[1]?.textContent).toContain("已过期blender 4.2.0");
  expect(
    within(items[1] as HTMLElement)
      .getByText("已过期")
      .classList.contains("status-subdued"),
  ).toBe(true);
  // Read-only: the drawer offers no configuration controls.
  expect(within(drawer).queryByRole("textbox")).toBeNull();
  expect(within(drawer).queryByRole("combobox")).toBeNull();

  fireEvent.keyDown(drawer, { key: "Escape" });
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "工作机 机器详情" }),
    ).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(open));

  fireEvent.click(
    screen.getByRole("button", { name: "查看 远端构建机 机器详情" }),
  );
  const failed = await screen.findByRole("dialog", {
    name: "远端构建机 机器详情",
  });
  expect(failed.textContent).toContain("机器未就绪、custom_code");
  expect(failed.textContent).toContain("没有已验证能力");
  expect(failed.textContent).toContain("未配置资源上限");
});
