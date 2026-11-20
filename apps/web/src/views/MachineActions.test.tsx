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
import { resetSettingWrites } from "./useSettingWrite.js";

afterEach(() => {
  cleanup();
  resetSettingWrites();
  window.localStorage.clear();
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
function Page({ c, canEdit = true }: { c: CardiganClient; canEdit?: boolean }) {
  return (
    <CapacityProvider client={c} projectId="p-1" revision={0} canEdit={canEdit}>
      <MachinesSettings client={c} projectId="p-1" pollMs={5} />
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
  expect(dialog.getByText("仅人类登录会话可修改并发上限。")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /添加 worker/, hidden: true }),
  ).toBeNull();
});

test("the machine actions are same-origin JSON posts to the human-only routes", async () => {
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
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  }
});
