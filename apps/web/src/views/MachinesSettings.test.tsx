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
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../App.js";
import {
  type CardiganClient,
  type ExecutionCapacity,
  HttpCardiganClient,
  type MachineView,
} from "../api.js";
import { CapacityProvider } from "../components/Capacity.js";
import type { StreamCallbacks } from "../stream.js";
import { fakeClient } from "../testing/fixtures.js";
import { fixtureMachines } from "../testing/machines-fixture.js";
import { SettingsPage } from "./SettingsPage.js";

afterEach(cleanup);

const byId = (id: string) => {
  const machine = fixtureMachines.find((m) => m.id === id);
  if (!machine) throw new Error(id);
  return machine;
};
/** Every write a machine page could reach; none may be called (C-512). */
const writes = () => ({
  setRunLimit: vi.fn(async () => {}),
  setPreferences: vi.fn(async () => {}),
});
function client(overrides: Partial<CardiganClient> = {}) {
  return fakeClient({
    machines: vi.fn(async () => ({ machines: fixtureMachines })),
    machine: vi.fn(async (_p: string, id: string) => ({ machine: byId(id) })),
    ...writes(),
    ...overrides,
  });
}
/** The shared capacity read (same figures as 并发与容量); Mac mini has none. */
const capacity: ExecutionCapacity = {
  agents: [
    {
      machine_id: "local",
      label: "本机",
      running: 2,
      total_running: 3,
      limit: 6,
      max_limit: 16,
      queued: 1,
      merge_check_slots: 0,
    },
    {
      machine_id: "builder",
      label: "构建机",
      running: 0,
      total_running: 0,
      limit: 4,
      max_limit: 8,
      queued: 0,
      merge_check_slots: 0,
    },
  ],
  merge_checks: [],
  merge_config_invalid: false,
};
function Page({ c, revision = 0 }: { c: CardiganClient; revision?: number }) {
  return (
    <CapacityProvider client={c} projectId="p-1" revision={0} canEdit>
      <SettingsPage projectId="p-1" client={c} revision={revision} />
    </CapacityProvider>
  );
}
async function openMachines(c: CardiganClient) {
  const view = render(<Page c={c} />);
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("table", { name: "机器列表" });
  return view;
}
const table = () => screen.getByRole("table", { name: "机器列表" });
const capacityClient = (overrides: Partial<CardiganClient> = {}) =>
  client({ executionCapacity: async () => capacity, ...overrides });
/** One machine with the given bindings, everything else from 本机. */
const withBindings = (
  bindings: MachineView["bindings"],
  id = "local",
): MachineView => ({ ...byId(id), bindings });

test("settings navigation lists 机器 right after 员工 and keeps 并发与容量 in place", () => {
  render(<SettingsPage projectId="p-1" client={client()} />);
  const nav = screen.getByRole("navigation", { name: "设置分栏" });
  expect(
    within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["偏好", "并发与容量", "授权", "角色", "卡片模板", "员工", "机器"]);
});

test("the list shows name, platform, status, heartbeat, running/limit and the latest check, read only", async () => {
  const c = capacityClient();
  await openMachines(c);
  expect(c.machines).toHaveBeenCalledWith("p-1");
  const rows = within(table()).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(3);
  const text = rows.map((r) => r.textContent);
  // 本机: the limited count pairs with its limit as in 并发与容量 (the
  // standing PM's Run in the peer project is exempt).
  expect(text[0]).toContain("本机");
  expect(text[0]).toContain("linux / x64");
  await waitFor(() => expect(rows[0]?.textContent).toContain("2 / 6"));
  expect(text[0]).toContain("通过");
  expect(text[0]).toContain("在线");
  // 构建机: the newest of its checks is the failed worker check.
  expect(text[1]).toContain("linux / arm64");
  expect(text[1]).toContain("0 / 4");
  expect(text[1]).toContain("失败");
  expect(text[1]).toContain("运行异常");
  // Mac mini: its worker record could not be read, which is not "never
  // checked"; no capacity row, so only the limit is known.
  expect(text[2]).toContain("无法读取");
  expect(text[2]).not.toContain("未检查");
  expect(text[2]).toContain("— / 1");
  expect(text[2]).toContain("停止接收新任务");
  // Only the name opens a detail; nothing on the page writes.
  expect(
    within(table())
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["本机", "构建机", "Mac mini"]);
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(c.setRunLimit).not.toHaveBeenCalled();
});

test("the detail shows capabilities, limits, bindings with the current project, runs and checks, and no actions", async () => {
  const c = capacityClient();
  await openMachines(c);
  const opener = screen.getByRole("button", { name: "本机" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("概况");
  expect(c.machine).toHaveBeenCalledWith("p-1", "local");
  const view = within(dialog);
  expect(view.getByText("local")).toBeTruthy();
  expect(view.getByText("6（最多可设 16）")).toBeTruthy();
  // All active Runs (with the exempt standing one) apart from the limited pair.
  const facts = (label: string) =>
    view.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
  expect(facts("全部在跑")).toBe("3");
  expect(facts("非常驻 / 上限")).toBe("2 / 6");
  expect(facts("排队")).toBe("1");
  expect(view.getByText("browser.chromium", { selector: "dt" })).toBeTruthy();
  // Capabilities per project, this one first: verified, expired, never
  // verified; the peer project's own evidence stays labelled as its own.
  const capabilities = view.getByRole("table", { name: "已验证能力" });
  expect(
    within(capabilities)
      .getAllByRole("row")
      .slice(1)
      .map((r) =>
        within(r)
          .getAllByRole("cell")
          .map((cell) => cell.textContent)
          .filter((_, i) => i !== 2 && i !== 3)
          .join(" "),
      ),
  ).toEqual([
    "browser.chromium Cardigan 已验证",
    "harness.codex Cardigan 已验证",
    "harness.claude-code Cardigan 已过期",
    "harness.pi Cardigan 未验证",
    "node 示例项目 已验证",
  ]);
  // Bindings: this project first and marked; the peer project as served.
  const bindings = within(
    view.getByRole("table", { name: "项目绑定" }),
  ).getAllByRole("row");
  expect(bindings[1]?.textContent).toContain("Cardigan 当前项目");
  expect(bindings[1]?.getAttribute("aria-current")).toBe("true");
  expect(bindings[2]?.textContent).toContain("示例项目");
  expect(bindings[2]?.textContent).not.toContain("当前项目");
  // Runs across projects, linked to their own project's card.
  const runs = view.getByRole("table", { name: "在跑任务" });
  // Both projects have an R-31; they are different Runs.
  expect(within(runs).getAllByRole("row")).toHaveLength(4);
  expect(within(runs).getAllByText("R-31")).toHaveLength(2);
  expect(
    within(runs)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href")),
  ).toEqual(["#/p/p-1/cards/C-1", "#/p/p-1/cards/C-2", "#/p/peer/cards/C-40"]);
  // The requested check equals the health record, so it is not repeated;
  // `local` has no worker record, so none is reported unreadable.
  const checks = within(view.getByRole("table", { name: "最近检查" }));
  expect(checks.getAllByRole("row")).toHaveLength(3);
  expect(checks.queryByText("无法读取")).toBeNull();
  // Read only: the drawer header has the close button and nothing else.
  expect(
    view
      .getAllByRole("button")
      .filter((b) => b.closest(".drawer-actions") || b.closest("header"))
      .map((b) => b.getAttribute("aria-label") ?? b.textContent),
  ).toEqual(["关闭抽屉"]);
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

test("a failed worker binding shows its steps; an unreadable configuration says so; nothing secret is rendered", async () => {
  const leaky = {
    ...byId("builder"),
    // A field the page does not know must never reach the screen.
    identity_file: "/private/identity-SECRET",
    bindings: byId("builder").bindings.map((b) => ({
      ...b,
      mcp_token: "TOKEN-SECRET",
    })),
  } as MachineView;
  const c = client({
    machine: vi.fn(async (_p: string, id: string) => ({
      machine: id === "builder" ? leaky : byId(id),
    })),
  });
  await openMachines(c);
  fireEvent.click(screen.getByRole("button", { name: "构建机" }));
  const dialog = await screen.findByRole("dialog");
  const view = within(dialog);
  const checks = within(
    await view.findByRole("table", { name: "最近检查" }),
  ).getAllByRole("row");
  expect(checks[1]?.textContent).toContain("接入检查");
  expect(checks[1]?.textContent).toContain("ssh、helper");
  expect(checks[2]?.textContent).toContain("机器检查失败");
  expect(view.getByText("agent_builder")).toBeTruthy();
  expect(view.getByText("4 项")).toBeTruthy();
  expect(view.getByText("没有在跑任务")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/SECRET/);
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: "Mac mini" }));
  const other = within(await screen.findByRole("dialog"));
  expect(await other.findByText("配置不可读")).toBeTruthy();
  expect(other.getByText("没有能力记录")).toBeTruthy();
  // An unreadable worker record is shown as such, not as "no checks".
  expect(other.queryByText("没有检查记录")).toBeNull();
  const unreadable = within(
    other.getByRole("table", { name: "最近检查" }),
  ).getAllByRole("row");
  expect(unreadable).toHaveLength(2);
  expect(unreadable[1]?.textContent).toContain("接入检查");
  expect(unreadable[1]?.textContent).toContain("无法读取");
});

test("a machine whose records are readable and empty is 未检查; one unreadable record keeps the readable results", async () => {
  const [current] = byId("builder").bindings;
  if (!current) throw new Error("fixture");
  const none = withBindings(
    [
      {
        ...current,
        machine_check: null,
        worker_check: null,
        last_requested_check: null,
      },
    ],
    "builder",
  );
  const partial = withBindings(
    [{ ...current, worker_check: null, worker_record_readable: false }],
    "builder",
  );
  const machines = vi
    .fn<CardiganClient["machines"]>()
    .mockResolvedValueOnce({ machines: [none] })
    .mockResolvedValue({ machines: [partial] });
  const c = client({
    machines,
    machine: vi.fn(async () => ({ machine: partial })),
  });
  const { rerender } = await openMachines(c);
  expect(within(table()).getAllByRole("row")[1]?.textContent).toContain(
    "未检查",
  );
  rerender(<Page c={c} revision={1} />);
  // The readable worker check request (23:20, failed) stays the result.
  await waitFor(() =>
    expect(within(table()).getAllByRole("row")[1]?.textContent).toContain(
      "失败",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "构建机" }));
  const checks = within(
    await within(await screen.findByRole("dialog")).findByRole("table", {
      name: "最近检查",
    }),
  ).getAllByRole("row");
  expect(checks.map((r) => r.textContent?.includes("无法读取"))).toEqual([
    false,
    false,
    false,
    true,
  ]);
});

test("the list's latest check is the newest across all bindings, with its project", async () => {
  const [mine, peer] = byId("local").bindings;
  if (!mine || !peer) throw new Error("fixture");
  const newerElsewhere = withBindings([
    mine,
    {
      ...peer,
      machine_check: {
        status: "failed",
        checked_at: "2025-12-31T23:00:00.000Z",
        blockers: ["machine_not_ready"],
        available: false,
      },
    },
  ]);
  // Without a binding for this project, the order the server lists them in
  // does not decide the result either.
  const notMine = withBindings([
    { ...peer, project_id: "q", project_name: "乙项目" },
    {
      ...peer,
      machine_check: {
        status: "failed",
        checked_at: "2025-12-31T23:30:00.000Z",
        blockers: [],
        available: false,
      },
    },
  ]);
  await openMachines(
    client({
      machines: async () => ({
        machines: [newerElsewhere, { ...notMine, id: "other", label: "他机" }],
      }),
    }),
  );
  const rows = within(table()).getAllByRole("row");
  expect(rows[1]?.textContent).toContain("失败 示例项目");
  expect(rows[1]?.textContent).not.toContain("通过");
  expect(rows[2]?.textContent).toContain("失败 示例项目");
});

test("a refreshed detail drops finished Runs even when another project reuses the number", async () => {
  const [mine, peer] = byId("local").bindings;
  if (!mine || !peer) throw new Error("fixture");
  const run = (id: string, card: string) => ({
    assignment_id: `A-${id}`,
    role_id: "coder",
    employee_id: null,
    employee_name: null,
    card_id: card,
    runs: [{ id, status: "running", card_id: card }],
  });
  const before = withBindings([
    { ...mine, assignments: [run("R-31", "C-1"), run("R-32", "C-2")] },
    { ...peer, assignments: [run("R-31", "C-9")] },
  ]);
  const after = withBindings([
    { ...mine, assignments: [run("R-100", "C-3")] },
    { ...peer, assignments: [run("R-31", "C-9")] },
  ]);
  const machine = vi
    .fn<CardiganClient["machine"]>()
    .mockResolvedValueOnce({ machine: before })
    .mockResolvedValue({ machine: after });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const c = client({
      machines: async () => ({ machines: [before] }),
      machine,
    });
    const { rerender } = await openMachines(c);
    fireEvent.click(screen.getByRole("button", { name: "本机" }));
    const dialog = within(await screen.findByRole("dialog"));
    const rows = async () =>
      within(await dialog.findByRole("table", { name: "在跑任务" }))
        .getAllByRole("row")
        .slice(1)
        .map((r) =>
          within(r)
            .getAllByRole("link")
            .map((a) => a.getAttribute("href"))
            .concat(r.querySelector("[data-ui='id-badge']")?.textContent ?? ""),
        );
    expect(await rows()).toHaveLength(3);
    rerender(<Page c={c} revision={1} />);
    await waitFor(() => expect(machine).toHaveBeenCalledTimes(2));
    await waitFor(async () =>
      expect((await rows()).map((r) => r[0])).toEqual([
        "#/p/p-1/cards/C-3",
        "#/p/peer/cards/C-9",
      ]),
    );
    expect(
      errors.mock.calls.some((call) => String(call[0]).includes("same key")),
    ).toBe(false);
  } finally {
    errors.mockRestore();
  }
});

test("loading, an empty list and a failed read that can be retried", async () => {
  const first = Promise.withResolvers<{ machines: readonly MachineView[] }>();
  const machines = vi
    .fn<CardiganClient["machines"]>()
    .mockReturnValueOnce(first.promise)
    .mockRejectedValueOnce(new Error("读取失败"))
    .mockResolvedValue({ machines: fixtureMachines });
  render(<SettingsPage projectId="p-1" client={client({ machines })} />);
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  // An automatic read announces itself once it is slow (one second).
  expect(
    await screen.findByText("正在加载机器…", {}, { timeout: 3000 }),
  ).toBeTruthy();
  expect(screen.queryByRole("table", { name: "机器列表" })).toBeNull();
  await act(async () => first.resolve({ machines: [] }));
  expect(await screen.findByText("没有机器")).toBeTruthy();
  // Leaving and coming back reads again; this read fails.
  fireEvent.click(screen.getByRole("button", { name: "员工" }));
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  expect(await screen.findByText(/读取失败/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("table", { name: "机器列表" })).toBeTruthy();
  expect(machines).toHaveBeenCalledTimes(3);
});

test("a failed detail read keeps the drawer and retries", async () => {
  const machine = vi
    .fn<CardiganClient["machine"]>()
    .mockRejectedValueOnce(new Error("详情读取失败"))
    .mockResolvedValue({ machine: byId("local") });
  await openMachines(client({ machine }));
  fireEvent.click(screen.getByRole("button", { name: "本机" }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(await dialog.findByText(/详情读取失败/)).toBeTruthy();
  // The retry stays in the drawer body, not in a floating stack that the
  // page's own stack could cover (V-2396).
  const retry = dialog.getByRole("button", { name: "重试" });
  expect(retry.closest("[data-feedback-host]")).not.toBeNull();
  expect(
    retry.closest("[data-feedback-host]")?.closest("[role=dialog]"),
  ).not.toBeNull();
  fireEvent.click(retry);
  expect(await dialog.findByText("概况")).toBeTruthy();
  expect(machine).toHaveBeenCalledTimes(2);
});

test("并发与容量 keeps its editable limits; the machine page adds no capacity control", async () => {
  const capacity: ExecutionCapacity = {
    agents: [
      {
        machine_id: "local",
        label: "本机",
        running: 1,
        total_running: 2,
        limit: 6,
        max_limit: 16,
        queued: 0,
        merge_check_slots: 0,
      },
    ],
    merge_checks: [],
    merge_config_invalid: false,
  };
  const c = client({ executionCapacity: async () => capacity });
  render(
    <CapacityProvider client={c} projectId="p-1" revision={0} canEdit>
      <SettingsPage projectId="p-1" client={c} />
    </CapacityProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "并发与容量" }));
  expect(
    await screen.findByRole("spinbutton", { name: "本机 Agent 并发上限" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("table", { name: "机器列表" });
  expect(screen.queryByRole("spinbutton")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "并发与容量" }));
  expect(
    await screen.findByRole("spinbutton", { name: "本机 Agent 并发上限" }),
  ).toBeTruthy();
  expect(c.machines).toHaveBeenCalledTimes(1);
});

test("the machine read is a plain same-origin GET of the human-only routes", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify({ machines: [] })),
    );
  const http = new HttpCardiganClient(fetcher);
  await http.machines("a b");
  await http.machine("a b", "mac mini");
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "/api/projects/a%20b/machines",
    "/api/projects/a%20b/machines/mac%20mini",
  ]);
  for (const [, init] of fetcher.mock.calls) {
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin" });
    expect(init.body).toBeUndefined();
    // No bearer token (the server refuses one) and no write key.
    expect(Object.keys(init.headers)).toEqual(["accept"]);
  }
});

test("a machine linked by ?tab=machines opens its panel", async () => {
  window.location.hash = "#/p/p-1/settings?tab=machines";
  try {
    render(<SettingsPage projectId="p-1" client={client()} />);
    expect(await screen.findByRole("table", { name: "机器列表" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "机器" }).getAttribute("aria-current"),
    ).toBe("page");
  } finally {
    window.location.hash = "";
  }
});

test("a cross-project capacity notice rereads the open machine; other settings panels are not reread", async () => {
  const [mine, peer] = byId("local").bindings;
  if (!mine || !peer) throw new Error("fixture");
  let current = withBindings([
    { ...mine, assignments: [] },
    { ...peer, assignments: [] },
  ]);
  let agent = {
    ...(capacity.agents[0] as ExecutionCapacity["agents"][number]),
  };
  agent = { ...agent, running: 0, total_running: 0 };
  let stream: StreamCallbacks | undefined;
  const machines = vi.fn(async () => ({ machines: [current] }));
  const machine = vi.fn(async () => ({ machine: current }));
  const roles = vi.fn(fakeClient().roles);
  const c = client({
    machines,
    machine,
    roles,
    executionCapacity: async () => ({ ...capacity, agents: [agent] }),
    subscribe: (_p, callbacks) => {
      stream = callbacks;
      return () => {};
    },
  });
  window.location.hash = "#/p/p-1/settings?tab=machines";
  try {
    render(<App client={c} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "本机" }, { timeout: 6000 }),
    );
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("没有在跑任务")).toBeTruthy();
    const reads = {
      list: machines.mock.calls.length,
      detail: machine.mock.calls.length,
    };
    // Another project starts a Run; this project sees no event of its own,
    // only the global capacity notice.
    current = withBindings([
      { ...mine, assignments: [] },
      {
        ...peer,
        assignments: [
          {
            assignment_id: "A-70",
            role_id: "coder",
            employee_id: null,
            employee_name: null,
            card_id: "C-70",
            runs: [{ id: "R-17", status: "running", card_id: "C-70" }],
          },
        ],
      },
    ]);
    agent = { ...agent, running: 1, total_running: 1 };
    await act(async () => stream?.capacity?.());
    expect(await dialog.findByRole("table", { name: "在跑任务" })).toBeTruthy();
    const facts = (label: string) =>
      dialog.getByText(label, { selector: "dt" }).nextElementSibling
        ?.textContent;
    await waitFor(() => expect(facts("全部在跑")).toBe("1"));
    await waitFor(() => expect(facts("非常驻 / 上限")).toBe("1 / 6"));
    expect(machines.mock.calls.length).toBe(reads.list + 1);
    expect(machine.mock.calls.length).toBe(reads.detail + 1);
    expect(roles).not.toHaveBeenCalled();
  } finally {
    window.location.hash = "";
  }
});

test("a failed capacity refresh is not shown as current: only the machine's own limit, and a retry", async () => {
  let fail = false;
  let limit = 6;
  const executionCapacity = vi.fn(async () => {
    if (fail) throw new Error("合成容量读取失败");
    return {
      ...capacity,
      agents: capacity.agents.map((a) =>
        a.machine_id === "local" ? { ...a, limit } : a,
      ),
    };
  });
  const local = () => ({ ...byId("local"), run_limit: limit });
  const c = client({
    executionCapacity,
    machines: vi.fn(async () => ({ machines: [local()] })),
    machine: vi.fn(async () => ({ machine: local() })),
  });
  const view = render(
    <CapacityProvider client={c} projectId="p-1" revision={0} canEdit>
      <SettingsPage projectId="p-1" client={c} revision={0} />
    </CapacityProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  fireEvent.click(await screen.findByRole("button", { name: "本机" }));
  const dialog = within(await screen.findByRole("dialog"));
  const facts = (label: string) =>
    dialog.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
  await waitFor(() => expect(facts("非常驻 / 上限")).toBe("2 / 6"));
  // The limit changes to 3: the machine read succeeds, the capacity read fails.
  fail = true;
  limit = 3;
  view.rerender(
    <CapacityProvider client={c} projectId="p-1" revision={1} canEdit>
      <SettingsPage projectId="p-1" client={c} revision={1} />
    </CapacityProvider>,
  );
  await waitFor(() => expect(facts("Agent 并发")).toBe("3（最多可设 16）"));
  await waitFor(() => expect(facts("非常驻 / 上限")).toBe("— / 3"));
  expect(facts("排队")).toBe("—");
  const alert = await dialog.findByText(/并发读数未能更新/);
  const retry = within(alert.closest("[role=alert]") as HTMLElement).getByRole(
    "button",
    { name: "重试" },
  );
  expect(retry.closest("[data-feedback-host]")).not.toBeNull();
  fail = false;
  fireEvent.click(retry);
  await waitFor(() => expect(facts("非常驻 / 上限")).toBe("2 / 3"));
  expect(dialog.queryByText(/并发读数未能更新/)).toBeNull();
});
