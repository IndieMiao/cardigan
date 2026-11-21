// @vitest-environment jsdom
// C-511: 立即检查, 排空/恢复 and the Agent limit in the machine detail.
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
  ApiError,
  type CardiganClient,
  type ExecutionCapacity,
  HttpCardiganClient,
  type MachineCheckJob,
  type MachineView,
} from "../api.js";
import { CapacityProvider } from "../components/Capacity.js";
import { fakeClient } from "../testing/fixtures.js";
import { fixtureMachines } from "../testing/machines-fixture.js";
import { MachinesSettings } from "./MachinesSettings.js";
import { resetMachineActions } from "./machine-actions.js";
import { resetSettingWrites } from "./useSettingWrite.js";

afterEach(() => {
  cleanup();
  resetSettingWrites();
  resetMachineActions();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.location.hash = "";
});

const byId = (id: string) =>
  fixtureMachines.find((m) => m.id === id) as MachineView;
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
  ],
  merge_checks: [],
  merge_config_invalid: false,
};
const job = (patch: Partial<MachineCheckJob> = {}): MachineCheckJob => ({
  id: "chk-1",
  project_id: "p-1",
  machine_id: "local",
  kind: "machine",
  status: "running",
  step: "queued",
  started_at: "2026-01-01T00:00:00.000Z",
  checked_at: "2026-01-01T00:00:00.000Z",
  failed_steps: [],
  ...patch,
});
function client(overrides: Partial<CardiganClient> = {}) {
  const machines = new Map(fixtureMachines.map((m) => [m.id, m]));
  const c = fakeClient({
    executionCapacity: vi.fn(async () => capacity),
    machines: vi.fn(async () => ({ machines: [...machines.values()] })),
    machine: vi.fn(async (_p: string, id: string) => ({
      machine: machines.get(id) as MachineView,
    })),
    setRunLimit: vi.fn(async () => {}),
    checkMachine: vi.fn(async () => ({ check: job() })),
    machineCheck: vi.fn(async () => ({ check: job({ status: "passed" }) })),
    setMachineDrain: vi.fn(async (_p: string, id: string, drain: boolean) => {
      const m = machines.get(id) as MachineView;
      machines.set(id, { ...m, status: drain ? "draining" : "online" });
      return { machine_id: id, status: drain ? "draining" : "online" };
    }),
    ...overrides,
  });
  return c;
}
function Page({
  c,
  canEdit = true,
  revision = 0,
}: {
  c: CardiganClient;
  canEdit?: boolean;
  revision?: number;
}) {
  return (
    <CapacityProvider
      client={c}
      projectId="p-1"
      revision={revision}
      canEdit={canEdit}
    >
      <MachinesSettings
        client={c}
        projectId="p-1"
        pollMs={5}
        revision={revision}
      />
    </CapacityProvider>
  );
}
async function openDetail(c: CardiganClient, name = "本机", canEdit = true) {
  render(<Page c={c} canEdit={canEdit} />);
  const table = await screen.findByRole("table", { name: "机器列表" });
  fireEvent.click(within(table).getByRole("button", { name }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("概况");
  return within(dialog);
}
const header = (dialog: ReturnType<typeof within>) =>
  dialog
    .getAllByRole("button")
    .filter((b) => b.closest(".drawer-actions"))
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);

test("立即检查 shows its progress, cannot start twice, and rereads the machine when it ends", async () => {
  const progress = Promise.withResolvers<void>();
  let reads = 0;
  const c = client({
    machineCheck: vi.fn(async () => {
      reads += 1;
      if (reads === 1) return { check: job({ step: "ssh" }) };
      await progress.promise;
      return { check: job({ status: "passed", step: "finished" }) };
    }),
  });
  const dialog = await openDetail(c);
  expect(header(dialog)).toEqual(["排空", "立即检查", "关闭抽屉"]);
  const machineReads = vi.mocked(c.machine).mock.calls.length;
  const listReads = vi.mocked(c.machines).mock.calls.length;
  fireEvent.click(dialog.getByRole("button", { name: "立即检查" }));
  const running = await dialog.findByRole("button", { name: "检查中…" });
  expect(running.getAttribute("aria-disabled")).toBe("true");
  expect(c.checkMachine).toHaveBeenCalledWith(
    "p-1",
    "local",
    expect.any(String),
  );
  await dialog.findByText("正在检查：SSH…");
  // A second press while it runs starts nothing.
  fireEvent.click(running);
  expect(c.checkMachine).toHaveBeenCalledOnce();
  await act(async () => progress.resolve());
  await dialog.findByText("检查通过");
  expect(dialog.getByRole("button", { name: "立即检查" })).toBeTruthy();
  await waitFor(() =>
    expect(vi.mocked(c.machine).mock.calls.length).toBeGreaterThan(
      machineReads,
    ),
  );
  expect(vi.mocked(c.machines).mock.calls.length).toBeGreaterThan(listReads);
  expect(c.checkMachine).toHaveBeenCalledOnce();
});

test("a failed check names its failed steps; a check already running is followed, not started", async () => {
  const c = client({
    machineCheck: vi.fn(async () => ({
      check: job({ status: "failed", step: "finished", failed_steps: ["ssh"] }),
    })),
  });
  const dialog = await openDetail(c);
  fireEvent.click(dialog.getByRole("button", { name: "立即检查" }));
  await dialog.findByText("检查未通过：SSH");
  cleanup();
  // Reopened while the binding records a running check: it is followed.
  const local = byId("local");
  const running: MachineView = {
    ...local,
    bindings: local.bindings.map((b) =>
      b.is_current
        ? {
            ...b,
            last_requested_check: {
              id: "chk-9",
              kind: "machine",
              status: "running",
              step: "runtime",
              checked_at: "2026-01-01T00:00:00.000Z",
              failed_steps: [],
            },
          }
        : b,
    ),
  };
  const hold = Promise.withResolvers<void>();
  const c2 = client({
    machine: vi.fn(async () => ({ machine: running })),
    machineCheck: vi.fn(async () => {
      await hold.promise;
      return { check: job({ id: "chk-9", status: "passed" }) };
    }),
  });
  const again = await openDetail(c2);
  expect(
    (await again.findByRole("button", { name: "检查中…" })).getAttribute(
      "aria-disabled",
    ),
  ).toBe("true");
  await again.findByText("正在检查：运行环境…");
  await waitFor(() =>
    expect(c2.machineCheck).toHaveBeenCalledWith("p-1", "local", "chk-9"),
  );
  expect(c2.checkMachine).not.toHaveBeenCalled();
  await act(async () => hold.resolve());
});

test("排空 and 恢复 submit at once, report the result and reread list, detail and capacity", async () => {
  const c = client();
  const dialog = await openDetail(c);
  const capacityReads = vi.mocked(c.executionCapacity).mock.calls.length;
  fireEvent.click(dialog.getByRole("button", { name: "排空" }));
  expect(c.setMachineDrain).toHaveBeenCalledWith(
    "p-1",
    "local",
    true,
    expect.any(String),
  );
  await dialog.findByText("已排空，不再接收新任务");
  // The reread detail is draining now, so the action turns into 恢复.
  const resume = await dialog.findByRole("button", { name: "恢复" });
  expect(vi.mocked(c.executionCapacity).mock.calls.length).toBeGreaterThan(
    capacityReads,
  );
  fireEvent.click(resume);
  expect(c.setMachineDrain).toHaveBeenLastCalledWith(
    "p-1",
    "local",
    false,
    expect.any(String),
  );
  await dialog.findByText("已恢复接收新任务");
  await dialog.findByRole("button", { name: "排空" });
});

test("a refused drain says so and still rereads; a busy action cannot be repeated", async () => {
  const held = Promise.withResolvers<never>();
  const c = client({ setMachineDrain: vi.fn(() => held.promise) });
  const dialog = await openDetail(c);
  const drain = dialog.getByRole("button", { name: "排空" });
  fireEvent.click(drain);
  expect(drain.getAttribute("aria-disabled")).toBe("true");
  expect(
    dialog
      .getByRole("button", { name: "立即检查" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(drain);
  fireEvent.click(dialog.getByRole("button", { name: "立即检查" }));
  expect(c.setMachineDrain).toHaveBeenCalledOnce();
  expect(c.checkMachine).not.toHaveBeenCalled();
  const reads = vi.mocked(c.machine).mock.calls.length;
  await act(async () =>
    held.reject(new ApiError(403, "unauthorized", "需要有效的人成员身份")),
  );
  await dialog.findByText("未能排空：没有权限执行此操作。");
  await waitFor(() =>
    expect(vi.mocked(c.machine).mock.calls.length).toBeGreaterThan(reads),
  );
});

test("machines without this project's binding cannot be checked; offline ones have no drain", async () => {
  const c = client();
  // Mac mini: draining, bound only to another project.
  const mac = await openDetail(c, "Mac mini");
  expect(header(mac)).toEqual(["恢复", "关闭抽屉"]);
  cleanup();
  // 构建机: degraded (neither online nor draining) but bound here.
  const builder = await openDetail(client(), "构建机");
  expect(header(builder)).toEqual(["立即检查", "关闭抽屉"]);
});

test("the Agent limit saves in the detail; a failed save keeps the edit and says why", async () => {
  const setRunLimit = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(409, "conflict", "上限冲突"))
    .mockResolvedValue(undefined);
  const c = client({ setRunLimit });
  const dialog = await openDetail(c);
  const input = dialog.getByRole<HTMLInputElement>("spinbutton", {
    name: "本机 Agent 并发上限",
  });
  expect(input.value).toBe("6");
  fireEvent.change(input, { target: { value: "8" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(setRunLimit).toHaveBeenCalledWith(
    "p-1",
    "local",
    8,
    expect.any(String),
  );
  await dialog.findByText(/未能保存“本机 Agent 并发上限”/);
  expect(input.value).toBe("8");
  await waitFor(() => expect(input.readOnly).toBe(false));
  fireEvent.keyDown(input, { key: "Enter" });
  await dialog.findByText("并发上限已保存，下一轮调度生效");
  // The same pending edit is retried with the same key.
  expect(setRunLimit.mock.calls[1]?.[3]).toBe(setRunLimit.mock.calls[0]?.[3]);
});

test("a read-only session gets no action, no wizard and a read-only limit", async () => {
  const c = client();
  const dialog = await openDetail(c, "本机", false);
  expect(header(dialog)).toEqual(["关闭抽屉"]);
  expect(dialog.queryByRole("spinbutton")).toBeNull();
  // The reason is in the row's help, not a line under it.
  expect(dialog.queryByText("仅人类登录会话可修改并发上限。")).toBeNull();
  expect(
    dialog.getByRole("button", { name: "Agent 并发上限说明" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /添加 worker/, hidden: true }),
  ).toBeNull();
});

test("the machine actions are same-origin JSON posts that carry an operation key but are never resent (V-2540)", async () => {
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ check: job() })),
  );
  const http = new HttpCardiganClient(fetcher);
  await http.checkMachine("a b", "mac mini", "k-1");
  await http.machineCheck("a b", "mac mini", "chk 1");
  await http.setMachineDrain("a b", "mac mini", true, "k-2");
  await http.setMachineDrain("a b", "mac mini", false, "k-3");
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
    ["/api/projects/a%20b/machines/mac%20mini/check", "POST", "{}"],
    [
      "/api/projects/a%20b/machines/mac%20mini/checks/chk%201",
      "GET",
      undefined,
    ],
    ["/api/projects/a%20b/machines/mac%20mini/drain", "POST", "{}"],
    ["/api/projects/a%20b/machines/mac%20mini/resume", "POST", "{}"],
  ]);
  for (const [, init] of calls) {
    const headers = new Headers(init.headers);
    expect(init.credentials).toBe("same-origin");
    expect(headers.get("authorization")).toBeNull();
    if (init.method === "POST")
      expect(headers.get("idempotency-key")).toMatch(/^k-\d$/);
  }
});

test("V-2530: a machine write whose reply is lost (503) is sent once, not retried by the client", async () => {
  let calls = 0;
  const fetcher = vi.fn(async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: "x", message: "" } }), {
      status: 503,
    });
  });
  const http = new HttpCardiganClient(fetcher);
  await expect(http.checkMachine("p", "local", "k")).rejects.toBeTruthy();
  await expect(
    http.setMachineDrain("p", "local", true, "k2"),
  ).rejects.toBeTruthy();
  // Keyed, yet each was sent once: the server does not dedupe them.
  expect(calls).toBe(2);
});

test("V-2530: draining while a check's progress read failed keeps that retry, which resumes the check", async () => {
  let reads = 0;
  const c = client({
    machineCheck: vi.fn(async () => {
      reads += 1;
      if (reads === 1) throw new TypeError("network");
      return { check: job({ status: "passed", step: "finished" }) };
    }),
  });
  const dialog = await openDetail(c);
  fireEvent.click(dialog.getByRole("button", { name: "立即检查" }));
  await dialog.findByText(/未能读取检查进度/);
  fireEvent.click(dialog.getByRole("button", { name: "排空" }));
  await dialog.findByText("已排空，不再接收新任务");
  await dialog.findByRole("button", { name: "恢复" });
  // The check's error and its retry are still there.
  expect(dialog.getByText(/未能读取检查进度/)).toBeTruthy();
  expect(
    dialog
      .getByRole("button", { name: "检查中…" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(dialog.getByRole("button", { name: "重试" }));
  await dialog.findByText("检查通过");
  expect(reads).toBe(2);
  expect(dialog.getByRole("button", { name: "立即检查" })).toBeTruthy();
});

test("V-2530: merge check counts follow the shared stale state", async () => {
  let fail = false;
  const hold: { gate?: Promise<void> } = {};
  const withTarget = (running: number, queued: number) => ({
    ...capacity,
    merge_checks: [{ machine_id: "ci", running, limit: 3, queued }],
  });
  const c = client({
    executionCapacity: vi.fn(async () => {
      if (hold.gate) await hold.gate;
      if (fail) throw new Error("合成容量读取失败");
      return withTarget(fail ? 0 : 11, 12);
    }),
  });
  const view = render(<Page c={c} />);
  const group = () =>
    screen.getByRole("heading", { name: "合并检查" }).closest("section");
  await waitFor(() =>
    expect(group()?.textContent).toContain("运行中 11 / 排队 12"),
  );
  fail = true;
  view.rerender(<Page c={c} revision={1} />);
  await screen.findByText(/并发读数未能更新/);
  expect(group()?.textContent).toContain("运行中 — / 排队 —");
  expect(group()?.textContent).toContain("上限 —");
  // A slow retry does not bring the old figures back; a success does.
  fail = false;
  const slow = Promise.withResolvers<void>();
  hold.gate = slow.promise;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(group()?.textContent).toContain("运行中 — / 排队 —");
  hold.gate = undefined;
  await act(async () => slow.resolve());
  await waitFor(() =>
    expect(group()?.textContent).toContain("运行中 11 / 排队 12"),
  );
  expect(group()?.textContent).toContain("上限 3");
});

/** 本机 with one binding's records replaced (peer project by default). */
const withBinding = (
  patch: Partial<MachineView["bindings"][number]>,
  project = "peer",
  base: MachineView = byId("local"),
): MachineView => ({
  ...base,
  bindings: base.bindings.map((b) =>
    b.project_id === project ? { ...b, ...patch } : b,
  ),
});
const requested = (
  id: string,
  status: "running" | "passed" | "failed",
  patch: Partial<
    NonNullable<MachineView["bindings"][number]["last_requested_check"]>
  > = {},
) => ({
  id,
  kind: "machine" as const,
  status,
  step: status === "running" ? "ssh" : "finished",
  checked_at: "2026-01-01T00:00:05.000Z",
  failed_steps: [],
  ...patch,
});
/**
 * Q-1048 fixture: the machine read answers `state.machine` (or throws
 * `state.fail`), and the check request's reply is lost.
 */
function lostReply(overrides: Partial<CardiganClient> = {}) {
  const state: { machine: MachineView; fail?: unknown } = {
    machine: byId("local"),
  };
  const c = client({
    machine: vi.fn(async () => {
      if (state.fail) throw state.fail;
      return { machine: state.machine };
    }),
    checkMachine: vi.fn(async () => {
      throw new TypeError("fixture lost reply");
    }),
    ...overrides,
  });
  return { c, state };
}
const disabled = (d: ReturnType<typeof within>, name: string) =>
  d.getByRole("button", { name }).getAttribute("aria-disabled") === "true";
async function reopen(name = "本机") {
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const table = screen.getByRole("table", { name: "机器列表" });
  fireEvent.click(within(table).getByRole("button", { name }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("概况");
  return within(dialog);
}

test("Q-1048: a lost check reply stays unknown; it never says the check did not start and sends nothing more", async () => {
  const { c } = lostReply();
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("上次检查请求结果未知");
  expect(d.queryByText(/没有开始|可以再试|不会重复/)).toBeNull();
  // The read answered and shows nothing running: only a new check the user
  // confirms (5b) is offered; 立即检查 itself is gone.
  expect(d.queryByRole("button", { name: "立即检查" })).toBeNull();
  expect(d.getByRole("button", { name: "仍要重新检查" })).toBeTruthy();
  for (let i = 0; i < 3; i++) {
    fireEvent.click(d.getByRole("button", { name: "重新读取" }));
    await d.findByText(/上次检查请求结果未知/);
  }
  expect(c.checkMachine).toHaveBeenCalledOnce();
});

test("Q-1048: GET first answers the old machine, the check appears later and is followed as the machine's", async () => {
  const hold = Promise.withResolvers<void>();
  const { c, state } = lostReply({
    machineCheck: vi.fn(async () => {
      await hold.promise;
      return { check: job({ id: "chk-late", status: "passed" }) };
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  // The read-back raced the host: same records as before the click.
  await d.findByText(/上次检查请求结果未知/);
  expect(c.checkMachine).toHaveBeenCalledOnce();
  // The job shows up on a later read.
  state.machine = withBinding(
    { last_requested_check: requested("chk-late", "running") },
    "p-1",
  );
  fireEvent.click(d.getByRole("button", { name: "重新读取" }));
  await d.findByText("这台机器正在检查：SSH…");
  expect(disabled(d, "检查中…")).toBe(true);
  expect(d.queryByRole("button", { name: "仍要重新检查" })).toBeNull();
  fireEvent.click(d.getByRole("button", { name: "检查中…" }));
  await waitFor(() =>
    expect(c.machineCheck).toHaveBeenCalledWith("p-1", "local", "chk-late"),
  );
  await act(async () => hold.resolve());
  // Its result is the machine's, not "this check's".
  await d.findByText("这台机器最近一次检查：通过");
  expect(d.queryByText("检查通过")).toBeNull();
  await waitFor(() => expect(disabled(d, "立即检查")).toBe(false));
  expect(c.checkMachine).toHaveBeenCalledOnce();
});

test("Q-1048: records changed only by other sources settle nothing", async () => {
  const { c, state } = lostReply();
  const d = await openDetail(c);
  // Another project's check ended and a scheduled health check moved, both
  // without ever being seen running.
  state.machine = withBinding({
    last_requested_check: requested("chk-peer", "failed", {
      failed_steps: ["mcp"],
    }),
    machine_check: {
      status: "failed",
      checked_at: "2026-01-01T00:00:09.000Z",
      blockers: [],
      available: true,
    },
  });
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText(/上次检查请求结果未知/);
  // The list of recent checks shows the records; no result is claimed.
  await d.findByRole("table", { name: "最近检查" });
  expect(
    d.queryByText(/最近一次检查：|检查未通过|检查通过|检查已完成/),
  ).toBeNull();
  expect(d.queryByRole("button", { name: "立即检查" })).toBeNull();
  fireEvent.click(d.getByRole("button", { name: "重新读取" }));
  await d.findByText(/上次检查请求结果未知/);
  expect(c.checkMachine).toHaveBeenCalledOnce();
});

test("Q-1048: closing and reopening, another machine, rereading or reloading the page keep it unknown; only a confirmed new check sends again", async () => {
  const { c } = lostReply();
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText(/上次检查请求结果未知/);
  // Close and reopen.
  let again = await reopen();
  await again.findByText("上次检查请求结果未知");
  expect(again.queryByRole("button", { name: "立即检查" })).toBeNull();
  // Another machine, then back.
  await reopen("构建机");
  again = await reopen();
  await again.findByText("上次检查请求结果未知");
  fireEvent.click(again.getByRole("button", { name: "重新读取" }));
  await again.findByText("上次检查请求结果未知");
  // A reload of the page (same tab): only session storage remains.
  cleanup();
  resetMachineActions();
  const reloaded = await openDetail(c);
  await reloaded.findByText("上次检查请求结果未知");
  expect(reloaded.queryByRole("button", { name: "立即检查" })).toBeNull();
  expect(c.checkMachine).toHaveBeenCalledOnce();
  // 5b: opening and cancelling the question sends nothing.
  fireEvent.click(reloaded.getByRole("button", { name: "仍要重新检查" }));
  const question = await screen.findByRole("dialog", {
    name: "仍要重新检查？",
  });
  expect(
    within(question).getByText(
      "上次请求结果未知，再次检查可能让这台机器多检查一次。",
    ),
  ).toBeTruthy();
  fireEvent.click(within(question).getByRole("button", { name: "取消" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "仍要重新检查？" })).toBeNull(),
  );
  expect(c.checkMachine).toHaveBeenCalledOnce();
  // Confirming is a new check: sent once more.
  fireEvent.click(reloaded.getByRole("button", { name: "仍要重新检查" }));
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "仍要重新检查？" }),
    ).getByRole("button", { name: "重新检查" }),
  );
  await waitFor(() => expect(c.checkMachine).toHaveBeenCalledTimes(2));
  // Its reply was lost too: unknown again, nothing more is sent.
  await reloaded.findByText("上次检查请求结果未知");
  expect(c.checkMachine).toHaveBeenCalledTimes(2);
});

test("Q-1048: a reply lost after the drawer closed is still unknown when it reopens", async () => {
  const lost = Promise.withResolvers<never>();
  const { c } = lostReply({ checkMachine: vi.fn(() => lost.promise) });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () => lost.reject(new TypeError("fixture lost reply")));
  const table = screen.getByRole("table", { name: "机器列表" });
  fireEvent.click(within(table).getByRole("button", { name: "本机" }));
  const again = within(await screen.findByRole("dialog"));
  await again.findByText("上次检查请求结果未知");
  expect(again.queryByRole("button", { name: "立即检查" })).toBeNull();
  expect(c.checkMachine).toHaveBeenCalledOnce();
});

test("Q-1048: a check seen running that ended while the drawer was closed shows the machine's result on reopen", async () => {
  const hold = Promise.withResolvers<void>();
  const { c, state } = lostReply({
    machineCheck: vi.fn(async () => {
      await hold.promise;
      return { check: job({ id: "chk-peer", status: "running" }) };
    }),
  });
  state.machine = withBinding({
    last_requested_check: requested("chk-peer", "running"),
  });
  // Opened while another project's check runs: it is followed.
  const d = await openDetail(c);
  await d.findByText("正在检查：SSH…");
  // A reloaded page; its read shows that check running when 立即检查 is
  // pressed, and the reply is lost.
  cleanup();
  resetMachineActions();
  state.machine = byId("local");
  const d2 = await openDetail(c);
  state.machine = withBinding({
    last_requested_check: requested("chk-peer", "running"),
  });
  fireEvent.click(d2.getByRole("button", { name: "立即检查" }));
  await d2.findByText("这台机器正在检查：SSH…");
  // Closed before it ends; by the reopen it has ended.
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  state.machine = withBinding({
    last_requested_check: requested("chk-peer", "failed", {
      failed_steps: ["mcp"],
    }),
  });
  const table = screen.getByRole("table", { name: "机器列表" });
  fireEvent.click(within(table).getByRole("button", { name: "本机" }));
  const again = within(await screen.findByRole("dialog"));
  await again.findByText("这台机器最近一次检查：未通过（MCP）");
  await waitFor(() => expect(disabled(again, "立即检查")).toBe(false));
  expect(c.checkMachine).toHaveBeenCalledOnce();
  await act(async () => hold.resolve());
});

test.each([401, 403, 404])(
  "V-2549 / Q-1048: a read-back refused with %s takes facts and controls down, also through a refused retry; allowed again it is still unknown",
  async (status) => {
    const { c, state } = lostReply();
    const d = await openDetail(c);
    expect(d.getByRole("table", { name: "项目绑定" })).toBeTruthy();
    const listReads = vi.mocked(c.machines).mock.calls.length;
    state.fail = new ApiError(status, "refused", "拒绝");
    fireEvent.click(d.getByRole("button", { name: "立即检查" }));
    await d.findByText("上次检查请求结果未知");
    // Down at once: no bindings, no editable limit, no actions.
    await waitFor(() =>
      expect(d.queryByRole("table", { name: "项目绑定" })).toBeNull(),
    );
    expect(d.queryByRole("spinbutton")).toBeNull();
    expect(
      d.queryByRole("button", { name: /立即检查|仍要重新检查|排空/ }),
    ).toBeNull();
    await waitFor(() =>
      expect(vi.mocked(c.machines).mock.calls.length).toBeGreaterThan(
        listReads,
      ),
    );
    // A retry that is refused again keeps it down.
    fireEvent.click(d.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(vi.mocked(c.machine).mock.calls.length).toBeGreaterThan(2),
    );
    expect(d.queryByRole("table", { name: "项目绑定" })).toBeNull();
    expect(d.queryByRole("spinbutton")).toBeNull();
    // Allowed again: the facts return, the write stays unknown, unsent.
    state.fail = undefined;
    fireEvent.click(await d.findByRole("button", { name: "重试" }));
    await d.findByRole("table", { name: "项目绑定" });
    await d.findByText(/上次检查请求结果未知/);
    expect(d.queryByRole("button", { name: "立即检查" })).toBeNull();
    expect(c.checkMachine).toHaveBeenCalledOnce();
  },
);

test("Q-1048: an ordinary failed read-back keeps the last detail, locks both actions and offers no new check", async () => {
  const { c, state } = lostReply();
  const d = await openDetail(c);
  state.fail = new TypeError("read lost");
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  // The detail read reports the failure and retries; the write stays unknown.
  await d.findByText("连不上 Workbench 服务，可能正在更新，请几秒后再试。");
  await d.findByText("上次检查请求结果未知");
  await waitFor(() =>
    expect(d.getAllByRole("button", { name: "重试" })).toHaveLength(1),
  );
  expect(d.getByRole("table", { name: "项目绑定" })).toBeTruthy();
  expect(disabled(d, "立即检查")).toBe(true);
  expect(disabled(d, "排空")).toBe(true);
  expect(d.queryByRole("button", { name: "仍要重新检查" })).toBeNull();
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  fireEvent.click(d.getByRole("button", { name: "排空" }));
  // Retrying reads again, never resends.
  state.fail = undefined;
  fireEvent.click(d.getByRole("button", { name: "重试" }));
  await d.findByRole("button", { name: "仍要重新检查" });
  expect(c.checkMachine).toHaveBeenCalledOnce();
  expect(c.setMachineDrain).not.toHaveBeenCalled();
});

test("V-2549 / Q-1048: a lost reply beside another project's running check follows it as the machine's check", async () => {
  const hold = Promise.withResolvers<void>();
  const { c, state } = lostReply({
    machineCheck: vi.fn(async () => {
      await hold.promise;
      return { check: job({ id: "chk-peer", status: "passed" }) };
    }),
    checkMachine: vi.fn(async () => {
      state.machine = withBinding({
        last_requested_check: requested("chk-peer", "running"),
      });
      throw new TypeError("fixture lost reply");
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("这台机器正在检查：SSH…");
  expect(d.queryByText(/你的检查|已开始/)).toBeNull();
  fireEvent.click(d.getByRole("button", { name: "检查中…" }));
  await waitFor(() =>
    expect(c.machineCheck).toHaveBeenCalledWith("p-1", "local", "chk-peer"),
  );
  await act(async () => hold.resolve());
  await d.findByText("这台机器最近一次检查：通过");
  expect(c.checkMachine).toHaveBeenCalledOnce();
});

test("Q-1048: a health check running without an id locks the action, is read again, and settles nothing when it ends", async () => {
  let reads = 0;
  const checking = withBinding({
    machine_check: {
      status: "checking",
      checked_at: "2026-01-01T00:00:02.000Z",
      blockers: [],
      available: true,
    },
  });
  const done = withBinding({
    machine_check: {
      status: "passed",
      checked_at: "2026-01-01T00:00:12.000Z",
      blockers: [],
      available: true,
    },
  });
  let sent = false;
  const c = client({
    machine: vi.fn(async () => {
      if (!sent) return { machine: byId("local") };
      reads += 1;
      return { machine: reads < 3 ? checking : done };
    }),
    checkMachine: vi.fn(async () => {
      sent = true;
      throw new TypeError("fixture lost reply");
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("这台机器正在检查，正在等待结果…");
  expect(disabled(d, "立即检查")).toBe(true);
  expect(d.queryByRole("button", { name: "仍要重新检查" })).toBeNull();
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  // It ended, but it had no id this view followed: still unknown.
  await d.findByRole("button", { name: "仍要重新检查" });
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(d.getByText(/上次检查请求结果未知/)).toBeTruthy();
  expect(d.queryByText(/检查已完成|最近一次检查：/)).toBeNull();
  expect(c.checkMachine).toHaveBeenCalledOnce();
});

test("Q-1048: a lost drain reply reads the state back: at the target it says so", async () => {
  const local = byId("local");
  let applied = false;
  const c = client({
    machine: vi.fn(async () => ({
      machine: applied ? { ...local, status: "draining" } : local,
    })),
    setMachineDrain: vi.fn(async () => {
      applied = true;
      throw new TypeError("reply lost");
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "排空" }));
  await d.findByText("当前已排空，不再接收新任务");
  await d.findByRole("button", { name: "恢复" });
  expect(disabled(d, "恢复")).toBe(false);
  expect(c.setMachineDrain).toHaveBeenCalledOnce();
});

test("Q-1048: a lost drain reply still at the old state allows only the same direction, across a reopen", async () => {
  const local = byId("local");
  let replies = 0;
  const c = client({
    machine: vi.fn(async () => ({ machine: local })),
    setMachineDrain: vi.fn(async () => {
      replies += 1;
      if (replies === 1) throw new TypeError("reply lost");
      return { machine_id: "local", status: "draining" };
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "排空" }));
  await d.findByText("当前仍为“在线”，排空结果未知");
  expect(d.queryByRole("button", { name: "恢复" })).toBeNull();
  const again = await reopen();
  await again.findByText("当前仍为“在线”，排空结果未知");
  expect(disabled(again, "排空")).toBe(false);
  fireEvent.click(again.getByRole("button", { name: "排空" }));
  await again.findByText("已排空，不再接收新任务");
  expect(c.setMachineDrain).toHaveBeenCalledTimes(2);
  expect(
    vi.mocked(c.setMachineDrain).mock.calls.map((call) => call[2]),
  ).toEqual([true, true]);
});

test("Q-1048: a lost drain reply that reads back neither state offers no action, only a reread", async () => {
  const local = byId("local");
  let sent = false;
  const c = client({
    machine: vi.fn(async () => ({
      machine: sent ? { ...local, status: "offline" } : local,
    })),
    setMachineDrain: vi.fn(async () => {
      sent = true;
      throw new ApiError(502, "bad_gateway", "lost");
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "排空" }));
  await d.findByText("排空结果未知，当前为“离线”");
  expect(d.queryByRole("button", { name: /排空|恢复/ })).toBeNull();
  fireEvent.click(d.getByRole("button", { name: "重新读取" }));
  await d.findByText("排空结果未知，当前为“离线”");
  expect(c.setMachineDrain).toHaveBeenCalledOnce();
});

test("Q-1048: a failed drain read-back retries the read, not the drain", async () => {
  const local = byId("local");
  let applied = false;
  let failRead = false;
  const c = client({
    machine: vi.fn(async () => {
      if (failRead) {
        failRead = false;
        throw new TypeError("read lost");
      }
      return { machine: applied ? { ...local, status: "draining" } : local };
    }),
    setMachineDrain: vi.fn(async () => {
      applied = true;
      failRead = true;
      throw new TypeError("reply lost");
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "排空" }));
  await d.findByText("排空结果未知");
  expect(disabled(d, "立即检查")).toBe(true);
  expect(disabled(d, "排空")).toBe(true);
  fireEvent.click(d.getByRole("button", { name: "重试" }));
  await d.findByText("当前已排空，不再接收新任务");
  await d.findByRole("button", { name: "恢复" });
  expect(c.setMachineDrain).toHaveBeenCalledOnce();
});

// V-2647 (attachment-8166): the reviewer's three interleavings, kept as
// written apart from the logging, plus the states the Q-1074 plan expects.
test("review: reopen before the first check response is lost", async () => {
  const lost = Promise.withResolvers<never>();
  const c = client({ checkMachine: vi.fn(() => lost.promise) });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  expect(c.checkMachine).toHaveBeenCalledTimes(1);
  const next = await reopen();
  // Still in flight in the reopened drawer: nothing more may be sent.
  await next.findByText("正在开始检查…");
  expect(disabled(next, "立即检查")).toBe(true);
  fireEvent.click(next.getByRole("button", { name: "立即检查" }));
  await act(async () => lost.reject(new TypeError("fixture lost reply")));
  await next.findByText("上次检查请求结果未知");
  const button = next.queryByRole("button", { name: "立即检查" });
  if (button) await act(async () => fireEvent.click(button));
  expect(c.checkMachine).toHaveBeenCalledTimes(1);
  // After a read answered since, only the confirmed new check (5b).
  fireEvent.click(await next.findByRole("button", { name: "仍要重新检查" }));
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "仍要重新检查？" }),
    ).getByRole("button", { name: "重新检查" }),
  );
  await waitFor(() => expect(c.checkMachine).toHaveBeenCalledTimes(2));
});

test("review: terminal detail clears a failed progress retry", async () => {
  const { c, state } = lostReply({
    machineCheck: vi.fn(async () => {
      throw new TypeError("fixture poll failed");
    }),
  });
  const d = await openDetail(c);
  state.machine = withBinding({
    last_requested_check: requested("chk-peer", "running"),
  });
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText(/未能读取检查进度/);
  state.machine = withBinding({
    last_requested_check: requested("chk-peer", "passed"),
  });
  // A separate allowed action refreshes the same detail after the job ended.
  fireEvent.click(d.getByRole("button", { name: "排空" }));
  await d.findByText("这台机器最近一次检查：通过");
  const b = await d.findByRole("button", { name: "立即检查" });
  expect(b.getAttribute("aria-disabled")).toBeNull();
  expect(d.queryByRole("button", { name: "重试" })).toBeNull();
  expect(d.queryByText(/未能读取检查进度/)).toBeNull();
  fireEvent.click(b);
  expect(c.checkMachine).toHaveBeenCalledTimes(2);
});

test("review: a late read for the old check cannot end a new check", async () => {
  const oldPoll = Promise.withResolvers<{ check: MachineCheckJob }>();
  const newPoll = Promise.withResolvers<{ check: MachineCheckJob }>();
  let posted = 0;
  const { c, state } = lostReply({
    checkMachine: vi.fn(async () => {
      if (++posted === 1) throw new TypeError("fixture reply lost");
      return { check: job({ id: "chk-new", step: "queued" }) };
    }),
    machineCheck: vi.fn(async (_p: string, _m: string, id: string) =>
      id === "chk-old" ? oldPoll.promise : newPoll.promise,
    ),
  });
  const d = await openDetail(c);
  state.machine = withBinding({
    last_requested_check: requested("chk-old", "running"),
  });
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await waitFor(() =>
    expect(c.machineCheck).toHaveBeenCalledWith("p-1", "local", "chk-old"),
  );
  state.machine = withBinding({
    last_requested_check: requested("chk-old", "passed"),
  });
  fireEvent.click(d.getByRole("button", { name: "排空" }));
  await d.findByText("这台机器最近一次检查：通过");
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await waitFor(() =>
    expect(c.machineCheck).toHaveBeenCalledWith("p-1", "local", "chk-new"),
  );
  expect(d.getByRole("button", { name: "检查中…" })).toBeTruthy();
  await act(async () =>
    oldPoll.resolve({
      check: job({ id: "chk-old", status: "passed", step: "finished" }),
    }),
  );
  // The old reply is dropped: the new check is still running and locked.
  expect(d.queryByText("检查通过")).toBeNull();
  expect(d.queryByRole("button", { name: "立即检查" })).toBeNull();
  expect(disabled(d, "检查中…")).toBe(true);
  expect(d.getByText("正在检查：排队…")).toBeTruthy();
  fireEvent.click(d.getByRole("button", { name: "检查中…" }));
  expect(c.checkMachine).toHaveBeenCalledTimes(2);
  // Only the new check's own reply ends it.
  await act(async () =>
    newPoll.resolve({
      check: job({ id: "chk-new", status: "passed", step: "finished" }),
    }),
  );
  await d.findByText("检查通过");
  await waitFor(() => expect(disabled(d, "立即检查")).toBe(false));
});

test("Q-1074: an older seen check ending does not end, unlock or relabel the newer one followed", async () => {
  const hold = Promise.withResolvers<{ check: MachineCheckJob }>();
  const { c, state } = lostReply({
    machineCheck: vi.fn(async (_p: string, _m: string, id: string) =>
      id === "chk-b" ? hold.promise : { check: job({ id, step: "ssh" }) },
    ),
  });
  const d = await openDetail(c);
  // Unknown request; chk-a is seen running, then chk-b replaces it.
  state.machine = withBinding({
    last_requested_check: requested("chk-a", "running"),
  });
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("这台机器正在检查：SSH…");
  state.machine = withBinding(
    { last_requested_check: requested("chk-b", "running", { step: "mcp" }) },
    "p-1",
  );
  fireEvent.click(d.getByRole("button", { name: "检查中…" }));
  fireEvent.click(d.getByRole("button", { name: "排空" }));
  await waitFor(() =>
    expect(c.machineCheck).toHaveBeenCalledWith("p-1", "local", "chk-b"),
  );
  // Now a read shows chk-a ended (another binding) while chk-b runs.
  state.machine = withBinding(
    { last_requested_check: requested("chk-b", "running", { step: "mcp" }) },
    "p-1",
    withBinding({
      last_requested_check: requested("chk-a", "failed", {
        failed_steps: ["ssh"],
      }),
    }),
  );
  const reads = vi.mocked(c.machine).mock.calls.length;
  fireEvent.click(await d.findByRole("button", { name: "排空" }));
  await waitFor(() =>
    expect(vi.mocked(c.machine).mock.calls.length).toBeGreaterThan(reads),
  );
  await d.findByText("这台机器正在检查：MCP…");
  expect(d.queryByText(/最近一次检查/)).toBeNull();
  expect(disabled(d, "检查中…")).toBe(true);
  expect(c.checkMachine).toHaveBeenCalledOnce();
  await act(async () =>
    hold.resolve({
      check: job({ id: "chk-b", status: "passed", step: "finished" }),
    }),
  );
  await d.findByText("这台机器最近一次检查：通过");
});

test("Q-1074: a drain in flight locks both drain buttons in a reopened drawer, and its lost reply shows there", async () => {
  const lost = Promise.withResolvers<never>();
  const c = client({ setMachineDrain: vi.fn(() => lost.promise) });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "排空" }));
  const next = await reopen();
  await next.findByText("正在排空…");
  expect(disabled(next, "排空")).toBe(true);
  expect(disabled(next, "立即检查")).toBe(true);
  fireEvent.click(next.getByRole("button", { name: "排空" }));
  fireEvent.click(next.getByRole("button", { name: "立即检查" }));
  await act(async () => lost.reject(new TypeError("fixture lost reply")));
  await next.findByText("当前仍为“在线”，排空结果未知");
  expect(c.setMachineDrain).toHaveBeenCalledOnce();
  expect(c.checkMachine).not.toHaveBeenCalled();
});

test("Q-1074: a write in flight when the page reloads is unknown afterwards", async () => {
  const c = client({ checkMachine: vi.fn(() => new Promise<never>(() => {})) });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("正在开始检查…");
  cleanup();
  resetMachineActions();
  const reloaded = await openDetail(c);
  await reloaded.findByText("上次检查请求结果未知");
  expect(reloaded.queryByRole("button", { name: "立即检查" })).toBeNull();
  await reloaded.findByRole("button", { name: "仍要重新检查" });
  expect(c.checkMachine).toHaveBeenCalledOnce();
});

test("Q-1074: closing and reopening while a check is followed keeps one progress read at a time", async () => {
  let inFlight = 0;
  let most = 0;
  const c = client({
    machineCheck: vi.fn(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { check: job({ step: "ssh" }) };
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("正在检查：SSH…");
  for (let i = 0; i < 3; i++) {
    const again = await reopen();
    await again.findByText("正在检查：SSH…");
  }
  await waitFor(() =>
    expect(vi.mocked(c.machineCheck).mock.calls.length).toBeGreaterThan(4),
  );
  expect(most).toBe(1);
  expect(c.checkMachine).toHaveBeenCalledOnce();
});

test("Q-1074: the question returns focus to its opener, or to 立即检查 when it is gone", async () => {
  const { c } = lostReply();
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  const again = await d.findByRole("button", { name: "仍要重新检查" });
  again.focus();
  fireEvent.click(again);
  const question = await screen.findByRole("dialog", {
    name: "仍要重新检查？",
  });
  fireEvent.keyDown(question, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(again));
  // Confirmed: the entry turns into 立即检查, which takes the focus.
  fireEvent.click(again);
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "仍要重新检查？" }),
    ).getByRole("button", { name: "重新检查" }),
  );
  await waitFor(() =>
    expect(document.activeElement?.textContent).toMatch(
      /立即检查|仍要重新检查/,
    ),
  );
  expect(document.activeElement).not.toBe(document.body);
});

// V-2655 (attachment-8197), appended verbatim; uses this file's fixtures.
// Only the progress for A may end; B and the subsequent detail read remain pending.
async function assertNoStaleUnlock(
  drawer: ReturnType<typeof within>,
  c: CardiganClient,
) {
  // The fixture polls after 5 ms. Watch for an enabled button while B is still running.
  const exposed = await waitFor(
    () => {
      const b = drawer.getByRole("button", { name: "立即检查" });
      expect(b.getAttribute("aria-disabled")).not.toBe("true");
      return b;
    },
    { timeout: 500 },
  ).catch(() => undefined);
  if (exposed) fireEvent.click(exposed);
  expect(c.checkMachine).toHaveBeenCalledTimes(1);
  expect(drawer.queryByText("检查通过")).toBeNull();
}

test("D2071: an old start reply cannot replace the newer check already shown by a reopened drawer", async () => {
  const postA = Promise.withResolvers<{ check: MachineCheckJob }>();
  const pollB = Promise.withResolvers<{ check: MachineCheckJob }>();
  const refresh = Promise.withResolvers<{ machine: MachineView }>();
  let holdDetail = false;
  let machine = byId("local");
  const c = client({
    checkMachine: vi.fn(() => postA.promise),
    machine: vi.fn(async () => (holdDetail ? refresh.promise : { machine })),
    machineCheck: vi.fn(async (_p, _m, id) =>
      id === "job-B"
        ? pollB.promise
        : { check: job({ id, status: "passed", step: "finished" }) },
    ),
  });
  const first = await openDetail(c);
  fireEvent.click(first.getByRole("button", { name: "立即检查" }));
  // The first start was accepted as A; while its HTTP reply is still on the wire, A ends and B starts on the same binding.
  machine = withBinding(
    { last_requested_check: requested("job-B", "running", { step: "mcp" }) },
    "p-1",
  );
  const next = await reopen();
  await next.findByText("正在检查：MCP…");
  await waitFor(() =>
    expect(c.machineCheck).toHaveBeenCalledWith("p-1", "local", "job-B"),
  );
  holdDetail = true; // No immediate fresh detail to hide the state reached by this branch.
  await act(async () =>
    postA.resolve({
      check: job({ id: "job-A", status: "running", step: "queued" }),
    }),
  );
  await assertNoStaleUnlock(next, c);
});

test("D2071: a detail snapshot taken before starting B cannot replace it with completed job A", async () => {
  const earlierDetail = Promise.withResolvers<{ machine: MachineView }>();
  const nextDetail = Promise.withResolvers<{ machine: MachineView }>();
  const pollB = Promise.withResolvers<{ check: MachineCheckJob }>();
  let detailCount = 0;
  const c = client({
    machine: vi.fn(async () =>
      ++detailCount === 1
        ? { machine: byId("local") }
        : detailCount === 2
          ? earlierDetail.promise
          : nextDetail.promise,
    ),
    checkMachine: vi.fn(async () => ({
      check: job({ id: "job-B", step: "mcp" }),
    })),
    machineCheck: vi.fn(async (_p, _m, id) =>
      id === "job-B"
        ? pollB.promise
        : { check: job({ id, status: "passed", step: "finished" }) },
    ),
  });
  const { rerender } = render(<Page c={c} />);
  const table = await screen.findByRole("table", { name: "机器列表" });
  fireEvent.click(within(table).getByRole("button", { name: "本机" }));
  const drawer = within(await screen.findByRole("dialog"));
  await drawer.findByText("概况");
  rerender(<Page c={c} revision={1} />);
  await waitFor(() => expect(c.machine).toHaveBeenCalledTimes(2));
  // A was running when this background GET took its snapshot, and has ended before B is requested.
  fireEvent.click(drawer.getByRole("button", { name: "立即检查" }));
  await waitFor(() =>
    expect(c.machineCheck).toHaveBeenCalledWith("p-1", "local", "job-B"),
  );
  await act(async () =>
    earlierDetail.resolve({
      machine: withBinding(
        { last_requested_check: requested("job-A", "running") },
        "p-1",
      ),
    }),
  );
  await assertNoStaleUnlock(drawer, c);
});

/**
 * Q-1076: host start times never decide which check is current. A starts
 * before B; each case runs with A's time later (clock stepped back), equal,
 * and missing, and must behave the same.
 */
const clocks = [
  [
    "A later than B (clock stepped back)",
    "2026-01-01T00:00:09.000Z",
    "2026-01-01T00:00:01.000Z",
  ],
  [
    "the same millisecond",
    "2026-01-01T00:00:01.000Z",
    "2026-01-01T00:00:01.000Z",
  ],
  ["missing", undefined, undefined],
] as const;
/** A check record or job carrying `started_at` only when given. */
const startedAt = (time: string | undefined) =>
  (time === undefined ? {} : { started_at: time }) as object;
const runningJob = (id: string, time: string | undefined, step = "queued") => {
  const { started_at: _drop, ...rest } = job({ id, step });
  return { ...rest, ...startedAt(time) } as MachineCheckJob;
};
const runningRecord = (id: string, time: string | undefined, step = "ssh") =>
  ({ ...requested(id, "running", { step }), ...startedAt(time) }) as ReturnType<
    typeof requested
  >;
/** Ids the progress loop asked for, in order. */
const progressIds = (c: CardiganClient) =>
  vi
    .mocked(c.machineCheck as NonNullable<CardiganClient["machineCheck"]>)
    .mock.calls.map((call) => call[2]);
/**
 * A detail read that answers the current machine, or (while `hold`) waits
 * for the test to answer it; every held read gets its own resolver.
 */
function heldDetails() {
  const state = { machine: byId("local"), hold: false };
  const held: PromiseWithResolvers<{ machine: MachineView }>[] = [];
  const machine = vi.fn(async () => {
    if (!state.hold) return { machine: state.machine };
    const read = Promise.withResolvers<{ machine: MachineView }>();
    held.push(read);
    return read.promise;
  });
  return { state, held, machine };
}
const onBinding = (record: ReturnType<typeof requested> | null) =>
  withBinding({ last_requested_check: record }, "p-1");

test.each(clocks)(
  "Q-1076 ①: a late start reply for A, with A's start time %s, keeps B followed and locked; the check adds a read, not a POST",
  async (_name, timeA, timeB) => {
    const postA = Promise.withResolvers<{ check: MachineCheckJob }>();
    const pollB = Promise.withResolvers<{ check: MachineCheckJob }>();
    const details = heldDetails();
    let posts = 0;
    const c = client({
      machine: details.machine,
      checkMachine: vi.fn(async () =>
        ++posts === 1 ? postA.promise : { check: job({ id: "job-C" }) },
      ),
      machineCheck: vi.fn(async (_p: string, _m: string, id: string) =>
        id === "job-B"
          ? pollB.promise
          : { check: job({ id, status: "passed", step: "finished" }) },
      ),
    });
    const first = await openDetail(c);
    fireEvent.click(first.getByRole("button", { name: "立即检查" }));
    details.state.machine = onBinding(runningRecord("job-B", timeB, "mcp"));
    const d = await reopen();
    await d.findByText("正在检查：MCP…");
    await waitFor(() => expect(progressIds(c)).toEqual(["job-B"]));
    details.state.hold = true;
    const reads = vi.mocked(c.machine).mock.calls.length;
    await act(async () => postA.resolve({ check: runningJob("job-A", timeA) }));
    // One read-only check of the machine; B stays followed and locked.
    await waitFor(() => expect(details.held).toHaveLength(1));
    expect(vi.mocked(c.machine).mock.calls.length).toBe(reads + 1);
    expect(disabled(d, "检查中…")).toBe(true);
    expect(d.getByText("正在检查：MCP…")).toBeTruthy();
    fireEvent.click(d.getByRole("button", { name: "检查中…" }));
    expect(c.checkMachine).toHaveBeenCalledTimes(1);
    // The check confirms B: still B, never A, no second look.
    await act(async () =>
      details.held[0]?.resolve({
        machine: onBinding(runningRecord("job-B", timeB, "mcp")),
      }),
    );
    expect(disabled(d, "检查中…")).toBe(true);
    expect(d.queryByText("检查通过")).toBeNull();
    expect(details.held).toHaveLength(1);
    // B ends by its own progress; then a new check may be asked for.
    details.state.hold = false;
    details.state.machine = onBinding(requested("job-B", "passed"));
    await act(async () =>
      pollB.resolve({
        check: job({ id: "job-B", status: "passed", step: "finished" }),
      }),
    );
    await d.findByText("检查通过");
    await waitFor(() => expect(disabled(d, "立即检查")).toBe(false));
    expect(progressIds(c).every((id) => id === "job-B")).toBe(true);
    fireEvent.click(d.getByRole("button", { name: "立即检查" }));
    await waitFor(() => expect(c.checkMachine).toHaveBeenCalledTimes(2));
  },
);

test.each(clocks)(
  "Q-1076 ②: an old detail snapshot of A, with A's start time %s, keeps B followed and locked",
  async (_name, timeA, timeB) => {
    const pollB = Promise.withResolvers<{ check: MachineCheckJob }>();
    const details = heldDetails();
    const c = client({
      machine: details.machine,
      checkMachine: vi.fn(async () => ({
        check: runningJob("job-B", timeB, "mcp"),
      })),
      machineCheck: vi.fn(async (_p: string, _m: string, id: string) =>
        id === "job-B"
          ? pollB.promise
          : { check: job({ id, status: "passed", step: "finished" }) },
      ),
    });
    const { rerender } = render(<Page c={c} />);
    const table = await screen.findByRole("table", { name: "机器列表" });
    fireEvent.click(within(table).getByRole("button", { name: "本机" }));
    const d = within(await screen.findByRole("dialog"));
    await d.findByText("概况");
    details.state.hold = true;
    rerender(<Page c={c} revision={1} />);
    await waitFor(() => expect(details.held).toHaveLength(1));
    fireEvent.click(d.getByRole("button", { name: "立即检查" }));
    await waitFor(() => expect(progressIds(c)).toEqual(["job-B"]));
    // The snapshot was taken while A still ran, before B was requested.
    await act(async () =>
      details.held[0]?.resolve({
        machine: onBinding(runningRecord("job-A", timeA)),
      }),
    );
    await waitFor(() => expect(details.held).toHaveLength(2));
    expect(disabled(d, "检查中…")).toBe(true);
    expect(d.getByText("正在检查：MCP…")).toBeTruthy();
    expect(d.queryByText("检查通过")).toBeNull();
    fireEvent.click(d.getByRole("button", { name: "检查中…" }));
    expect(c.checkMachine).toHaveBeenCalledTimes(1);
    await act(async () =>
      details.held[1]?.resolve({
        machine: onBinding(runningRecord("job-B", timeB, "mcp")),
      }),
    );
    expect(disabled(d, "检查中…")).toBe(true);
    details.state.hold = false;
    details.state.machine = onBinding(requested("job-B", "passed"));
    await act(async () =>
      pollB.resolve({
        check: job({ id: "job-B", status: "passed", step: "finished" }),
      }),
    );
    await d.findByText("检查通过");
    await waitFor(() => expect(disabled(d, "立即检查")).toBe(false));
    expect(progressIds(c)).not.toContain("job-A");
    expect(c.checkMachine).toHaveBeenCalledTimes(1);
  },
);

test.each(clocks)(
  "Q-1076 P1: a read sent after following A that finds B running (start times %s) takes B up; A's late progress is void",
  async (_name, timeA, timeB) => {
    const pollA = Promise.withResolvers<{ check: MachineCheckJob }>();
    const pollB = Promise.withResolvers<{ check: MachineCheckJob }>();
    const details = heldDetails();
    const c = client({
      machine: details.machine,
      checkMachine: vi.fn(async () => ({ check: runningJob("job-A", timeA) })),
      machineCheck: vi.fn(async (_p: string, _m: string, id: string) =>
        id === "job-A" ? pollA.promise : pollB.promise,
      ),
    });
    const { rerender } = render(<Page c={c} />);
    const table = await screen.findByRole("table", { name: "机器列表" });
    fireEvent.click(within(table).getByRole("button", { name: "本机" }));
    const d = within(await screen.findByRole("dialog"));
    await d.findByText("概况");
    fireEvent.click(d.getByRole("button", { name: "立即检查" }));
    await waitFor(() => expect(progressIds(c)).toEqual(["job-A"]));
    // A ended on the host and the CLI started B; a new read finds B.
    details.state.machine = onBinding(runningRecord("job-B", timeB, "mcp"));
    rerender(<Page c={c} revision={1} />);
    await d.findByText("正在检查：MCP…");
    await waitFor(() => expect(progressIds(c)).toEqual(["job-A", "job-B"]));
    expect(disabled(d, "检查中…")).toBe(true);
    // A's progress, still on the wire, is no longer the followed check's.
    await act(async () =>
      pollA.resolve({
        check: job({ id: "job-A", status: "passed", step: "finished" }),
      }),
    );
    expect(d.queryByText("检查通过")).toBeNull();
    expect(disabled(d, "检查中…")).toBe(true);
    details.state.machine = onBinding(requested("job-B", "passed"));
    await act(async () =>
      pollB.resolve({
        check: job({ id: "job-B", status: "passed", step: "finished" }),
      }),
    );
    await d.findByText("检查通过");
    await waitFor(() => expect(disabled(d, "立即检查")).toBe(false));
    expect(c.checkMachine).toHaveBeenCalledTimes(1);
  },
);

test("Q-1076 P1: after A ends, the reread finding B running follows B without a POST", async () => {
  const pollB = Promise.withResolvers<{ check: MachineCheckJob }>();
  const details = heldDetails();
  const c = client({
    machine: details.machine,
    checkMachine: vi.fn(async () => ({ check: job({ id: "job-A" }) })),
    machineCheck: vi.fn(async (_p: string, _m: string, id: string) =>
      id === "job-A"
        ? { check: job({ id, status: "passed", step: "finished" }) }
        : pollB.promise,
    ),
  });
  const d = await openDetail(c);
  details.state.machine = onBinding(
    requested("job-B", "running", { step: "mcp" }),
  );
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("正在检查：MCP…");
  expect(progressIds(c)).toEqual(["job-A", "job-B"]);
  expect(disabled(d, "检查中…")).toBe(true);
  expect(c.checkMachine).toHaveBeenCalledTimes(1);
});

test("Q-1076 P3: a start reply for A after B was followed and ended is checked by a read, which takes A up", async () => {
  const postA = Promise.withResolvers<{ check: MachineCheckJob }>();
  const pollA = Promise.withResolvers<{ check: MachineCheckJob }>();
  const details = heldDetails();
  const c = client({
    machine: details.machine,
    checkMachine: vi.fn(() => postA.promise),
    machineCheck: vi.fn(async (_p: string, _m: string, id: string) =>
      id === "job-B"
        ? { check: job({ id, status: "passed", step: "finished" }) }
        : pollA.promise,
    ),
  });
  const first = await openDetail(c);
  fireEvent.click(first.getByRole("button", { name: "立即检查" }));
  details.state.machine = onBinding(requested("job-B", "running"));
  const d = await reopen();
  // B ended by its progress; the start request is still out.
  await d.findByText("正在开始检查…");
  expect(progressIds(c)).toEqual(["job-B"]);
  details.state.hold = true;
  const reads = vi.mocked(c.machine).mock.calls.length;
  await act(async () => postA.resolve({ check: job({ id: "job-A" }) }));
  await waitFor(() => expect(details.held.length).toBeGreaterThan(0));
  // B's result stays readable while the read is out; nothing may be sent.
  expect(disabled(d, "立即检查")).toBe(true);
  expect(d.getByText("检查通过")).toBeTruthy();
  const check = details.held.at(-1);
  await act(async () =>
    check?.resolve({
      machine: onBinding(requested("job-A", "running", { step: "mcp" })),
    }),
  );
  await d.findByText("正在检查：MCP…");
  await waitFor(() => expect(progressIds(c)).toEqual(["job-B", "job-A"]));
  expect(vi.mocked(c.machine).mock.calls.length).toBeGreaterThan(reads);
  expect(c.checkMachine).toHaveBeenCalledTimes(1);
});

test("Q-1076 P3: when the check read finds nothing running, 立即检查 opens again", async () => {
  const postA = Promise.withResolvers<{ check: MachineCheckJob }>();
  const details = heldDetails();
  const c = client({
    machine: details.machine,
    checkMachine: vi.fn(() => postA.promise),
    machineCheck: vi.fn(async (_p: string, _m: string, id: string) => ({
      check: job({ id, status: "passed", step: "finished" }),
    })),
  });
  const first = await openDetail(c);
  fireEvent.click(first.getByRole("button", { name: "立即检查" }));
  details.state.machine = onBinding(requested("job-B", "running"));
  const d = await reopen();
  // B ended by its progress; the start request is still out.
  await d.findByText("正在开始检查…");
  expect(progressIds(c)).toEqual(["job-B"]);
  details.state.hold = true;
  await act(async () => postA.resolve({ check: job({ id: "job-A" }) }));
  await waitFor(() => expect(details.held.length).toBeGreaterThan(0));
  expect(disabled(d, "立即检查")).toBe(true);
  for (const read of details.held)
    await act(async () =>
      read.resolve({ machine: onBinding(requested("job-A", "passed")) }),
    );
  await waitFor(() => expect(disabled(d, "立即检查")).toBe(false));
  expect(progressIds(c)).toEqual(["job-B"]);
  expect(c.checkMachine).toHaveBeenCalledTimes(1);
});

test("Q-1076 P4: a start reply joining the check already followed only updates its step", async () => {
  const postB = Promise.withResolvers<{ check: MachineCheckJob }>();
  const pollB = Promise.withResolvers<{ check: MachineCheckJob }>();
  const details = heldDetails();
  const c = client({
    machine: details.machine,
    checkMachine: vi.fn(() => postB.promise),
    machineCheck: vi.fn(() => pollB.promise),
  });
  const first = await openDetail(c);
  fireEvent.click(first.getByRole("button", { name: "立即检查" }));
  details.state.machine = onBinding(requested("job-B", "running"));
  const d = await reopen();
  await d.findByText("正在检查：SSH…");
  const reads = vi.mocked(c.machine).mock.calls.length;
  await act(async () =>
    postB.resolve({ check: job({ id: "job-B", step: "mcp" }) }),
  );
  await d.findByText("正在检查：MCP…");
  expect(vi.mocked(c.machine).mock.calls.length).toBe(reads);
  expect(progressIds(c)).toEqual(["job-B"]);
  expect(disabled(d, "检查中…")).toBe(true);
});

test("Q-1076 P5: a late snapshot cannot bring back A, which this page saw end", async () => {
  const details = heldDetails();
  let posts = 0;
  const c = client({
    machine: details.machine,
    checkMachine: vi.fn(async () => ({
      check: job({ id: ++posts === 1 ? "job-A" : "job-B" }),
    })),
    machineCheck: vi.fn(async (_p: string, _m: string, id: string) => ({
      check: job({ id, status: "passed", step: "finished" }),
    })),
  });
  const { rerender } = render(<Page c={c} />);
  const table = await screen.findByRole("table", { name: "机器列表" });
  fireEvent.click(within(table).getByRole("button", { name: "本机" }));
  const d = within(await screen.findByRole("dialog"));
  await d.findByText("概况");
  details.state.hold = true;
  rerender(<Page c={c} revision={1} />); // a snapshot taken while A runs
  await waitFor(() => expect(details.held).toHaveLength(1));
  details.state.hold = false;
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("检查通过");
  await waitFor(() => expect(disabled(d, "立即检查")).toBe(false));
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await waitFor(() => expect(progressIds(c)).toEqual(["job-A", "job-B"]));
  await waitFor(() => expect(disabled(d, "立即检查")).toBe(false));
  await act(async () =>
    details.held[0]?.resolve({
      machine: onBinding(requested("job-A", "running")),
    }),
  );
  expect(d.queryByText("正在检查：SSH…")).toBeNull();
  await waitFor(() => expect(disabled(d, "立即检查")).toBe(false));
  expect(progressIds(c)).toEqual(["job-A", "job-B"]);
  expect(c.checkMachine).toHaveBeenCalledTimes(2);
});

test("Q-1076 R3: a failed check read keeps 立即检查 locked and offers only a reread", async () => {
  const postA = Promise.withResolvers<{ check: MachineCheckJob }>();
  const pollB = Promise.withResolvers<{ check: MachineCheckJob }>();
  const details = heldDetails();
  const c = client({
    machine: details.machine,
    checkMachine: vi.fn(() => postA.promise),
    machineCheck: vi.fn(() => pollB.promise),
  });
  const first = await openDetail(c);
  fireEvent.click(first.getByRole("button", { name: "立即检查" }));
  details.state.machine = onBinding(requested("job-B", "running"));
  const d = await reopen();
  await d.findByText("正在检查：SSH…");
  details.state.hold = true;
  await act(async () => postA.resolve({ check: job({ id: "job-A" }) }));
  await waitFor(() => expect(details.held).toHaveLength(1));
  await act(async () =>
    details.held[0]?.reject(new ApiError(500, "fixture", "fixture failure")),
  );
  await d.findByText("未能确认正在进行的检查");
  expect(disabled(d, "检查中…")).toBe(true);
  const posts = vi.mocked(
    c.checkMachine as NonNullable<CardiganClient["checkMachine"]>,
  ).mock.calls.length;
  // The only way on is to read again; nothing is sent.
  details.state.hold = false;
  const retry = d.getAllByRole("button", { name: "重新读取" });
  for (const button of retry) fireEvent.click(button);
  await waitFor(() =>
    expect(d.queryByText("未能确认正在进行的检查")).toBeNull(),
  );
  await d.findByText("正在检查：SSH…");
  expect(disabled(d, "检查中…")).toBe(true);
  expect(c.checkMachine).toHaveBeenCalledTimes(posts);
  expect(progressIds(c).every((id) => id === "job-B")).toBe(true);
});

test("Q-1076 R3: when the followed check ends while a check read is out, only a later read can open 立即检查", async () => {
  const postA = Promise.withResolvers<{ check: MachineCheckJob }>();
  const pollB = Promise.withResolvers<{ check: MachineCheckJob }>();
  const details = heldDetails();
  const c = client({
    machine: details.machine,
    checkMachine: vi.fn(() => postA.promise),
    machineCheck: vi.fn(() => pollB.promise),
  });
  const first = await openDetail(c);
  fireEvent.click(first.getByRole("button", { name: "立即检查" }));
  details.state.machine = onBinding(requested("job-B", "running"));
  const d = await reopen();
  await d.findByText("正在检查：SSH…");
  details.state.hold = true;
  await act(async () => postA.resolve({ check: job({ id: "job-A" }) }));
  await waitFor(() => expect(details.held).toHaveLength(1));
  // B ends by its progress while that read is out: the mark moves on.
  await act(async () =>
    pollB.resolve({
      check: job({ id: "job-B", status: "passed", step: "finished" }),
    }),
  );
  await d.findByText("检查通过");
  await waitFor(() => expect(details.held.length).toBeGreaterThan(1));
  expect(disabled(d, "立即检查")).toBe(true);
  // The earlier read finds nothing running: it was sent before the change.
  await act(async () =>
    details.held[0]?.resolve({
      machine: onBinding(requested("job-B", "passed")),
    }),
  );
  expect(disabled(d, "立即检查")).toBe(true);
  await act(async () =>
    details.held.at(-1)?.resolve({
      machine: onBinding(requested("job-B", "passed")),
    }),
  );
  await waitFor(() => expect(disabled(d, "立即检查")).toBe(false));
  expect(c.checkMachine).toHaveBeenCalledTimes(1);
});
