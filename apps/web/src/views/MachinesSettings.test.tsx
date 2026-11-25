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
  ApiError,
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

afterEach(() => {
  cleanup();
  // Settings tabs live in the URL (C-518), so one test's panel must not open the next one's.
  window.location.hash = "";
});

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

test("settings navigation lists 机器 right after 员工; 并发与容量 is gone (C-576)", () => {
  render(<SettingsPage projectId="p-1" client={client()} />);
  const nav = screen.getByRole("navigation", { name: "设置分栏" });
  expect(
    within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual([
    "偏好",
    "授权",
    "飞书绑定",
    "角色",
    "卡片模板",
    "员工",
    "机器",
    "模型",
  ]);
});

test("the list shows name, platform, status, occupied/limit and the latest check with its time, read only", async () => {
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
  // C-576: no 最近心跳 (the registry's last_seen is not a heartbeat); the
  // latest check carries its time instead, and the count is named 占用.
  expect(
    within(table())
      .getAllByRole("columnheader")
      .map((h) => h.textContent),
  ).toEqual(["名称", "系统", "占用 / 上限", "最近检查", "状态", "操作"]);
  await waitFor(() => expect(rows[0]?.textContent).toMatch(/通过 · \S/u));
  // The name and a row-end 详情 open the detail; nothing on the page writes.
  expect(
    within(table())
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["本机", "详情", "构建机", "详情", "Mac mini", "详情"]);
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(c.setRunLimit).not.toHaveBeenCalled();
});

test("the detail shows capabilities, limits, bindings with the current project, runs and checks; no actions without them", async () => {
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
  // C-511: the limit is a field here; this client has no machine actions.
  expect(limitField(view).value).toBe("6");
  expect(view.getByText("最多可设 16 个")).toBeTruthy();
  // All active Runs (with the exempt standing one) apart from the limited pair.
  const facts = (label: string) =>
    view.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
  expect(facts("全部在跑")).toBe("3");
  expect(facts("占用 / 上限")).toBe("2 / 6");
  expect(facts("排队")).toBe("1");
  expect(view.getByText("browser.chromium", { selector: "dt" })).toBeTruthy();
  // Capabilities per project, this one first: verified, expired, never
  // verified; the peer project's own evidence stays labelled as its own.
  const capabilities = view.getByRole("table", { name: "能力" });
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
  // A client without machine actions: the header has only the close button.
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
  // C-576: the check's time sits between its result and its project.
  expect(rows[1]?.textContent).toMatch(/失败 · [^·]+ · 示例项目/u);
  expect(rows[1]?.textContent).not.toContain("通过");
  expect(rows[2]?.textContent).toMatch(/失败 · [^·]+ · 示例项目/u);
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

test("C-511/C-576: the machine row's 详情 opens the detail, where the limit is edited", async () => {
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
    merge_checks: [{ machine_id: "ci", running: 0, limit: 2, queued: 0 }],
    merge_config_invalid: false,
  };
  const c = client({ executionCapacity: async () => capacity });
  render(
    <CapacityProvider client={c} projectId="p-1" revision={0} canEdit>
      <SettingsPage projectId="p-1" client={c} />
    </CapacityProvider>,
  );
  expect(screen.queryByRole("button", { name: "并发与容量" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("table", { name: "机器列表" });
  expect(window.location.hash).toContain("tab=machines");
  expect(
    screen.getByRole("button", { name: "机器" }).getAttribute("aria-current"),
  ).toBe("page");
  // The panel itself has no limit field; merge check targets stay listed.
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.getByRole("heading", { name: "合并检查" })).toBeTruthy();
  const detail = screen.getByRole("button", { name: "本机 详情" });
  expect(detail.textContent).toBe("详情");
  expect(detail.getAttribute("aria-haspopup")).toBe("dialog");
  fireEvent.click(detail);
  const dialog = within(await screen.findByRole("dialog"));
  await waitFor(() => expect(limitField(dialog).value).toBe("6"));
  expect(dialog.getByText("最多可设 16 个")).toBeTruthy();
  // A machine this project has no binding for shows its limit read only.
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Mac mini" }));
  const other = within(await screen.findByRole("dialog"));
  await other.findByText("概况");
  expect(other.queryByRole("spinbutton")).toBeNull();
  expect(
    other.getByText("Agent 并发", { selector: "dt" }).nextElementSibling
      ?.textContent,
  ).toMatch(/最多可设/);
});

test("C-576: a limit at the host maximum says why it cannot go higher", async () => {
  const c = capacityClient({
    machine: vi.fn(async (_p: string, id: string) => ({
      machine: { ...byId(id), run_limit: byId(id).run_limit_maximum },
    })),
  });
  await openMachines(c);
  fireEvent.click(screen.getByRole("button", { name: "本机 详情" }));
  const dialog = within(await screen.findByRole("dialog"));
  await waitFor(() => expect(limitField(dialog).value).toBe("16"));
  expect(
    dialog.getByText("主机配置的最大值为 16，如需更高请联系主机运维"),
  ).toBeTruthy();
  expect(dialog.queryByText("最多可设 16 个")).toBeNull();
});

test("C-576: 占用 counts this host's merge check slots, as the scheduler does", async () => {
  // The scheduler compares running + merge check slots with the limit: 5 + 2
  // fills a limit of 6, so ordinary work cannot start.
  const busy: ExecutionCapacity = {
    ...capacity,
    agents: capacity.agents.map((a) =>
      a.machine_id === "local" ? { ...a, running: 5, merge_check_slots: 2 } : a,
    ),
  };
  await openMachines(client({ executionCapacity: async () => busy }));
  const rows = within(table()).getAllByRole("row");
  await waitFor(() => expect(rows[1]?.textContent).toContain("7 / 6"));
  fireEvent.click(screen.getByRole("button", { name: "本机 详情" }));
  const dialog = within(await screen.findByRole("dialog"));
  await dialog.findByText("概况");
  expect(
    dialog.getByText("占用 / 上限", { selector: "dt" }).nextElementSibling
      ?.textContent,
  ).toBe("7 / 6");
});

test("C-576: an invalid host configuration shows its warning, not a maximum of 0", async () => {
  const c = capacityClient({
    machine: vi.fn(async (_p: string, id: string) => ({
      machine: { ...byId(id), run_limit: 0, run_limit_maximum: 0 },
    })),
  });
  await openMachines(c);
  fireEvent.click(screen.getByRole("button", { name: "本机 详情" }));
  const dialog = within(await screen.findByRole("dialog"));
  await dialog.findByText("主机并发配置无效，请联系主机管理员");
  expect(dialog.queryByText(/主机配置的最大值为 0/u)).toBeNull();
});

test("C-511: an old ?tab=capacity link lands on the machine page and replaces itself", async () => {
  window.location.hash = "#/p/p-1/settings?tab=capacity";
  render(<App client={client()} />);
  await screen.findByRole("table", { name: "机器列表" });
  expect(window.location.hash).toBe("#/p/p-1/settings?tab=machines");
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
    await waitFor(() => expect(facts("占用 / 上限")).toBe("1 / 6"));
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
  let gate: Promise<void> | undefined;
  const executionCapacity = vi.fn(async () => {
    if (gate) await gate;
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
  await waitFor(() => expect(facts("占用 / 上限")).toBe("2 / 6"));
  // The limit changes to 3: the machine read succeeds, the capacity read fails.
  fail = true;
  limit = 3;
  view.rerender(
    <CapacityProvider client={c} projectId="p-1" revision={1} canEdit>
      <SettingsPage projectId="p-1" client={c} revision={1} />
    </CapacityProvider>,
  );
  // C-511: the detail edits the limit its own machine read shows.
  await waitFor(() => expect(limitField(dialog).value).toBe("3"));
  await waitFor(() => expect(facts("占用 / 上限")).toBe("— / 3"));
  expect(facts("排队")).toBe("—");
  const alert = await dialog.findByText(/并发读数未能更新/);
  const retry = within(alert.closest("[role=alert]") as HTMLElement).getByRole(
    "button",
    { name: "重试" },
  );
  expect(retry.closest("[data-feedback-host]")).not.toBeNull();
  // V-2441: while the retry is in flight the failed snapshot (2 / 6, 排队 1)
  // must not come back as current; it waits for a read that succeeds.
  fail = false;
  const held = Promise.withResolvers<void>();
  gate = held.promise;
  fireEvent.click(retry);
  expect(await dialog.findByText("正在重新读取并发读数…")).toBeTruthy();
  expect(dialog.queryByText(/并发读数未能更新/)).toBeNull();
  expect(facts("占用 / 上限")).toBe("— / 3");
  expect(facts("排队")).toBe("—");
  expect(dialog.queryByText("2 / 6")).toBeNull();
  gate = undefined;
  await act(async () => held.resolve());
  await waitFor(() => expect(facts("占用 / 上限")).toBe("2 / 3"));
  expect(facts("排队")).toBe("1");
  expect(dialog.queryByText("正在重新读取并发读数…")).toBeNull();
  expect(dialog.queryByText(/并发读数未能更新/)).toBeNull();
});

/** Shared setup for the capacity cases (Q-1013): a controllable capacity read. */
function capacityCase(machineLimit: () => number) {
  const state = {
    fail: false,
    running: 2,
    queued: 1,
    capacityLimit: 6,
    gate: undefined as Promise<void> | undefined,
  };
  const executionCapacity = vi.fn(async () => {
    if (state.gate) await state.gate;
    if (state.fail) throw new Error("合成容量读取失败");
    return {
      ...capacity,
      agents: capacity.agents.map((a) =>
        a.machine_id === "local"
          ? {
              ...a,
              running: state.running,
              queued: state.queued,
              limit: state.capacityLimit,
            }
          : a,
      ),
    };
  });
  const local = () => ({ ...byId("local"), run_limit: machineLimit() });
  const c = client({
    executionCapacity,
    machines: vi.fn(async () => ({ machines: [local()] })),
    machine: vi.fn(async () => ({ machine: local() })),
  });
  const page = (revision: number) => (
    <CapacityProvider client={c} projectId="p-1" revision={revision} canEdit>
      <SettingsPage projectId="p-1" client={c} revision={revision} />
    </CapacityProvider>
  );
  // The list stays readable behind an open (modal) drawer.
  const listCell = () =>
    within(
      screen.getByRole("table", { name: "机器列表", hidden: true }),
    ).getAllByRole("row", { hidden: true })[1]?.textContent ?? "";
  return { state, executionCapacity, page, listCell };
}
/** C-511: the Agent limit field in the machine detail. */
const limitField = (dialog: ReturnType<typeof within>) =>
  dialog.getByRole<HTMLInputElement>("spinbutton", {
    name: "本机 Agent 并发上限",
  });
const drawerFacts = (dialog: ReturnType<typeof within>) => (label: string) =>
  dialog.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

test("Q-1013: a drawer opened while a retry is in flight agrees with the list and shows no failed snapshot", async () => {
  let limit = 6;
  const { state, page, listCell } = capacityCase(() => limit);
  const view = render(page(0));
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("table", { name: "机器列表" });
  await waitFor(() => expect(listCell()).toContain("2 / 6"));
  state.fail = true;
  limit = 3;
  view.rerender(page(1));
  await waitFor(() => expect(listCell()).toContain("— / 3"));
  // The panel's own notice (no drawer open) offers the retry.
  const alert = (await screen.findByText(/并发读数未能更新/)).closest(
    "[role=alert]",
  ) as HTMLElement;
  state.fail = false;
  const held = Promise.withResolvers<void>();
  state.gate = held.promise;
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  // Before the response: list and a freshly opened drawer both stay stale.
  await waitFor(() => expect(listCell()).toContain("— / 3"));
  fireEvent.click(screen.getByRole("button", { name: "本机" }));
  const dialog = within(await screen.findByRole("dialog"));
  const facts = drawerFacts(dialog);
  await waitFor(() => expect(facts("占用 / 上限")).toBe("— / 3"));
  expect(facts("排队")).toBe("—");
  expect(await dialog.findByText("正在重新读取并发读数…")).toBeTruthy();
  expect(document.body.textContent).not.toContain("2 / 6");
  // After the response: both show the new reading.
  state.gate = undefined;
  await act(async () => held.resolve());
  await waitFor(() => expect(facts("占用 / 上限")).toBe("2 / 3"));
  expect(facts("排队")).toBe("1");
  expect(listCell()).toContain("2 / 3");
});

test("Q-1013: the limit beside the count is the machine read's, even when the capacity read differs", async () => {
  const { state, page, listCell } = capacityCase(() => 3);
  state.capacityLimit = 6;
  render(page(0));
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("table", { name: "机器列表" });
  await waitFor(() => expect(listCell()).toContain("2 / 3"));
  expect(listCell()).not.toContain("/ 6");
  fireEvent.click(screen.getByRole("button", { name: "本机" }));
  const dialog = within(await screen.findByRole("dialog"));
  const facts = drawerFacts(dialog);
  await waitFor(() => expect(facts("占用 / 上限")).toBe("2 / 3"));
  expect(limitField(dialog).value).toBe("3");
});

test("Q-1013 guard: an ordinary background refresh keeps the last good reading until it returns", async () => {
  const { state, page, listCell } = capacityCase(() => 6);
  const view = render(page(0));
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("table", { name: "机器列表" });
  fireEvent.click(screen.getByRole("button", { name: "本机" }));
  const dialog = within(await screen.findByRole("dialog"));
  const facts = drawerFacts(dialog);
  await waitFor(() => expect(facts("占用 / 上限")).toBe("2 / 6"));
  const held = Promise.withResolvers<void>();
  state.gate = held.promise;
  state.running = 3;
  view.rerender(page(1));
  // In flight: still the last good reading, no placeholder, no notice.
  await new Promise((r) => setTimeout(r, 50));
  expect(facts("占用 / 上限")).toBe("2 / 6");
  expect(facts("排队")).toBe("1");
  expect(listCell()).toContain("2 / 6");
  expect(dialog.queryByText("正在重新读取并发读数…")).toBeNull();
  state.gate = undefined;
  await act(async () => held.resolve());
  await waitFor(() => expect(facts("占用 / 上限")).toBe("3 / 6"));
});

test("Q-1017: failed → slow retry → 偏好 → back to 机器 and its detail shows no failed snapshot until the reply", async () => {
  let limit = 6;
  const { state, page, listCell } = capacityCase(() => limit);
  const view = render(page(0));
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("table", { name: "机器列表" });
  await waitFor(() => expect(listCell()).toContain("2 / 6"));
  state.fail = true;
  limit = 3;
  view.rerender(page(1));
  await waitFor(() => expect(listCell()).toContain("— / 3"));
  const alert = (await screen.findByText(/并发读数未能更新/)).closest(
    "[role=alert]",
  ) as HTMLElement;
  state.fail = false;
  const held = Promise.withResolvers<void>();
  state.gate = held.promise;
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  // Leave the machine panel while the retry is still in flight, then return.
  fireEvent.click(screen.getByRole("button", { name: "偏好" }));
  expect(screen.queryByRole("table", { name: "机器列表" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("table", { name: "机器列表" });
  await waitFor(() => expect(listCell()).toContain("— / 3"));
  fireEvent.click(screen.getByRole("button", { name: "本机" }));
  const dialog = within(await screen.findByRole("dialog"));
  const facts = drawerFacts(dialog);
  await waitFor(() => expect(facts("占用 / 上限")).toBe("— / 3"));
  expect(facts("排队")).toBe("—");
  expect(await dialog.findByText("正在重新读取并发读数…")).toBeTruthy();
  expect(listCell()).toContain("— / 3");
  expect(document.body.textContent).not.toMatch(/2 \/ [36]/);
  // The reply brings the new reading to both at once.
  state.running = 0;
  state.queued = 0;
  state.gate = undefined;
  await act(async () => held.resolve());
  await waitFor(() => expect(facts("占用 / 上限")).toBe("0 / 3"));
  expect(facts("排队")).toBe("0");
  expect(listCell()).toContain("0 / 3");
  expect(dialog.queryByText("正在重新读取并发读数…")).toBeNull();
});

test("Q-1017: a retry that succeeds while the user is on another panel shows the new reading on return", async () => {
  let limit = 6;
  const { state, page, listCell } = capacityCase(() => limit);
  const view = render(page(0));
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("table", { name: "机器列表" });
  await waitFor(() => expect(listCell()).toContain("2 / 6"));
  state.fail = true;
  limit = 3;
  view.rerender(page(1));
  const alert = (await screen.findByText(/并发读数未能更新/)).closest(
    "[role=alert]",
  ) as HTMLElement;
  state.fail = false;
  const held = Promise.withResolvers<void>();
  state.gate = held.promise;
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  fireEvent.click(screen.getByRole("button", { name: "偏好" }));
  state.running = 0;
  state.queued = 0;
  state.gate = undefined;
  await act(async () => held.resolve());
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("table", { name: "机器列表" });
  await waitFor(() => expect(listCell()).toContain("0 / 3"));
  expect(listCell()).not.toContain("—");
  expect(screen.queryByText(/并发读数未能更新/)).toBeNull();
  expect(screen.queryByText("正在重新读取并发读数…")).toBeNull();
});

/** V-2475: the machine read can be refused (401/403) or no longer visible (404). */
function visibilityCase(status: number) {
  const machine = byId("local");
  const state = { allowed: true, gate: undefined as Promise<void> | undefined };
  const refused = () =>
    new ApiError(
      status,
      status === 404 ? "not_found" : "unauthorized",
      "合成：机器不再可见",
    );
  const c = client({
    machines: vi.fn(async () => {
      if (state.gate) await state.gate;
      if (state.allowed) return { machines: [machine] };
      if (status === 404) return { machines: [] };
      throw refused();
    }),
    machine: vi.fn(async () => {
      if (state.gate) await state.gate;
      if (!state.allowed) throw refused();
      return { machine };
    }),
  });
  const page = (revision: number) => (
    <SettingsPage projectId="p-1" client={c} revision={revision} />
  );
  return { machine, state, page };
}
const listed = () =>
  document.querySelector('table[aria-label="机器列表"]')?.textContent ?? "";
const drawerTable = (name: string) =>
  document.querySelector(`[role="dialog"] table[aria-label="${name}"]`);

test.each([401, 403, 404])(
  "V-2475: after a %s reply the earlier machine facts are taken down",
  async (status) => {
    const { machine, state, page } = visibilityCase(status);
    const view = render(page(0));
    fireEvent.click(screen.getByRole("button", { name: "机器" }));
    fireEvent.click(await screen.findByRole("button", { name: machine.label }));
    await within(await screen.findByRole("dialog")).findByRole("table", {
      name: "在跑任务",
    });
    state.allowed = false;
    view.rerender(page(1));
    if (status === 404) {
      // The list still reads, without it: its open detail goes (V-2482).
      expect(await screen.findByText("没有机器")).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } else {
      // A refused list takes its open detail down with it.
      expect(
        await screen.findByText(
          status === 401 ? "会话已失效，请重新登录。" : "没有权限执行此操作。",
        ),
      ).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(listed()).not.toContain(machine.label);
    expect(drawerTable("项目绑定")).toBeNull();
    expect(drawerTable("在跑任务")).toBeNull();
    expect(document.body.textContent).not.toContain("peer/cards");
    expect(document.querySelector('a[href="#/p/peer/cards/C-40"]')).toBeNull();
  },
);

test("V-2475: a retry in flight after a refusal keeps the facts down until a read succeeds", async () => {
  const { machine, state, page } = visibilityCase(403);
  const view = render(page(0));
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("table", { name: "机器列表" });
  state.allowed = false;
  view.rerender(page(1));
  const alert = (await screen.findByText("没有权限执行此操作。")).closest(
    "[role=alert]",
  ) as HTMLElement;
  expect(listed()).not.toContain(machine.label);
  state.allowed = true;
  const held = Promise.withResolvers<void>();
  state.gate = held.promise;
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  expect(await screen.findByText("正在加载机器…")).toBeTruthy();
  expect(listed()).not.toContain(machine.label);
  expect(screen.queryByRole("button", { name: machine.label })).toBeNull();
  state.gate = undefined;
  await act(async () => held.resolve());
  expect(
    await screen.findByRole("button", { name: machine.label }),
  ).toBeTruthy();
  expect(screen.queryByText("没有权限执行此操作。")).toBeNull();
});

test("V-2475 guard: any other failed refresh keeps the last good read beside the error", async () => {
  const machine = byId("local");
  let fail = false;
  const c = client({
    machines: vi.fn(async () => {
      if (fail) throw new ApiError(500, "internal", "合成：服务内部错误");
      return { machines: [machine] };
    }),
  });
  const view = render(<SettingsPage projectId="p-1" client={c} revision={0} />);
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  await screen.findByRole("button", { name: machine.label });
  fail = true;
  view.rerender(<SettingsPage projectId="p-1" client={c} revision={1} />);
  expect(await screen.findByText(/合成：服务内部错误/)).toBeTruthy();
  expect(screen.getByRole("button", { name: machine.label })).toBeTruthy();
});

test.each([false, true])(
  "V-2482: a failed detail refresh keeps the detail only while the list still has the machine (removed=%s)",
  async (removed) => {
    const item: MachineView = {
      ...byId("local"),
      id: "sample",
      label: "样机",
      bindings: [],
      resources: [],
    };
    let refreshing = false;
    const c = client({
      machines: async () => ({
        machines: refreshing && removed ? [] : [item],
      }),
      machine: async () => {
        if (refreshing) throw new Error("详情暂未更新");
        return { machine: item };
      },
    });
    const view = render(
      <SettingsPage projectId="p-1" client={c} revision={0} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "机器" }));
    const opener = await screen.findByRole("button", { name: "样机" });
    opener.focus();
    fireEvent.click(opener);
    await within(await screen.findByRole("dialog")).findByText("资源上限");
    refreshing = true;
    view.rerender(<SettingsPage projectId="p-1" client={c} revision={1} />);
    if (removed) {
      // The list read succeeded without it: its detail goes, whatever the
      // detail read said.
      expect(await screen.findByText("没有机器")).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.body.textContent).not.toContain("资源上限");
      expect(document.body.textContent).not.toContain("样机");
      // Its opener is gone with it: focus goes to the machine panel.
      await waitFor(() => expect(document.activeElement?.id).toBe("machines"));
    } else {
      const dialog = within(screen.getByRole("dialog"));
      expect(await dialog.findByText(/详情暂未更新/)).toBeTruthy();
      expect(dialog.getByText("资源上限")).toBeTruthy();
      expect(dialog.getByRole("heading", { level: 2 }).textContent).toBe(
        "样机",
      );
    }
  },
);

test("V-2475: a detail answered 404 while the list still has the machine takes its facts down in the drawer", async () => {
  const machine = byId("local");
  let gone = false;
  const c = client({
    machines: async () => ({ machines: [machine] }),
    machine: async () => {
      if (gone) throw new ApiError(404, "not_found", "合成：机器不再可见");
      return { machine };
    },
  });
  const view = render(<SettingsPage projectId="p-1" client={c} revision={0} />);
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  fireEvent.click(await screen.findByRole("button", { name: machine.label }));
  await within(await screen.findByRole("dialog")).findByRole("table", {
    name: "在跑任务",
  });
  gone = true;
  view.rerender(<SettingsPage projectId="p-1" client={c} revision={1} />);
  const dialog = within(screen.getByRole("dialog"));
  expect(await dialog.findByText(/合成：机器不再可见/)).toBeTruthy();
  expect(dialog.getByRole("heading", { level: 2 }).textContent).toBe("机器");
  expect(drawerTable("项目绑定")).toBeNull();
  expect(drawerTable("在跑任务")).toBeNull();
  expect(dialog.queryByText("资源上限")).toBeNull();
});
