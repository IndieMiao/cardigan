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
import {
  type CardiganClient,
  type ExecutionCapacity,
  HttpCardiganClient,
  type MachineView,
} from "../api.js";
import { CapacityProvider } from "../components/Capacity.js";
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
async function openMachines(c: CardiganClient) {
  render(<SettingsPage projectId="p-1" client={c} />);
  fireEvent.click(screen.getByRole("button", { name: "机器" }));
  return screen.findByRole("table", { name: "机器列表" });
}

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
  const c = client();
  const table = await openMachines(c);
  expect(c.machines).toHaveBeenCalledWith("p-1");
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(3);
  const text = rows.map((r) => r.textContent);
  // 本机: two runs here plus one in the peer project, against a limit of 6.
  expect(text[0]).toContain("本机");
  expect(text[0]).toContain("linux / x64");
  expect(text[0]).toContain("3 / 6");
  expect(text[0]).toContain("通过");
  expect(text[0]).toContain("在线");
  // 构建机: the newest of its checks is the failed worker check.
  expect(text[1]).toContain("linux / arm64");
  expect(text[1]).toContain("0 / 4");
  expect(text[1]).toContain("失败");
  expect(text[1]).toContain("运行异常");
  // Mac mini: bound to another project only and never checked.
  expect(text[2]).toContain("未检查");
  expect(text[2]).toContain("停止接收新任务");
  // Only the name opens a detail; nothing on the page writes.
  expect(
    within(table)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["本机", "构建机", "Mac mini"]);
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(c.setRunLimit).not.toHaveBeenCalled();
});

test("the detail shows capabilities, limits, bindings with the current project, runs and checks, and no actions", async () => {
  const c = client();
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
  expect(view.getByText("browser.chromium", { selector: "dt" })).toBeTruthy();
  // Capabilities: verified first, then expired and never verified.
  const capabilities = view.getByRole("table", { name: "已验证能力" });
  expect(
    within(capabilities)
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("cell")[3]?.textContent),
  ).toEqual(["已验证", "已验证", "已过期", "未验证"]);
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
  expect(within(runs).getAllByRole("row")).toHaveLength(4);
  expect(
    within(runs)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href")),
  ).toEqual(["#/p/p-1/cards/C-1", "#/p/p-1/cards/C-2", "#/p/peer/cards/C-40"]);
  // The requested check equals the health record, so it is not repeated.
  const checks = within(view.getByRole("table", { name: "最近检查" }));
  expect(checks.getAllByRole("row")).toHaveLength(3);
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
  expect(other.getByText("已验证能力（示例项目）")).toBeTruthy();
  expect(other.getByText("没有能力记录")).toBeTruthy();
  expect(other.getByText("没有检查记录")).toBeTruthy();
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
  fireEvent.click(dialog.getByRole("button", { name: "重试" }));
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
