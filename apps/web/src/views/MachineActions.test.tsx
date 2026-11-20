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

test("V-2530: a check whose reply is lost (503) is sent once; the machine is reread", async () => {
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
  // In the page, the failed start reads the machine again; a check the
  // server did start is then followed instead of started again.
  const local = byId("local");
  let started = false;
  const running: MachineView = {
    ...local,
    bindings: local.bindings.map((b) =>
      b.is_current
        ? {
            ...b,
            last_requested_check: {
              id: "chk-2",
              kind: "machine",
              status: "running",
              step: "ssh",
              checked_at: "2026-01-01T00:00:00.000Z",
              failed_steps: [],
            },
          }
        : b,
    ),
  };
  const hold = Promise.withResolvers<void>();
  const c = client({
    machine: vi.fn(async () => ({ machine: started ? running : local })),
    checkMachine: vi.fn(async () => {
      started = true;
      throw new ApiError(503, "unavailable", "lost");
    }),
    machineCheck: vi.fn(async () => {
      await hold.promise;
      return { check: job({ id: "chk-2", status: "passed" }) };
    }),
  });
  const dialog = await openDetail(c);
  fireEvent.click(dialog.getByRole("button", { name: "立即检查" }));
  // The read-back shows it started: it is followed, not started again.
  await dialog.findByRole("button", { name: "检查中…" });
  await waitFor(() =>
    expect(c.machineCheck).toHaveBeenCalledWith("p-1", "local", "chk-2"),
  );
  expect(c.checkMachine).toHaveBeenCalledOnce();
  await act(async () => hold.resolve());
  await dialog.findByText("检查通过");
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

test("V-2540: a lost check reply is read back before another click may be sent, without claiming a retry is safe", async () => {
  const hold = Promise.withResolvers<void>();
  const local = byId("local");
  let sent = 0;
  const c = client({
    machine: vi.fn(async () => {
      if (sent) await hold.promise;
      return { machine: local };
    }),
    checkMachine: vi.fn(async () => {
      sent++;
      throw new TypeError("fixture lost reply");
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText(/未能确认检查是否已开始/);
  expect(d.queryByText(/不会重复/)).toBeNull();
  const button = d.getByRole("button", { name: "立即检查" });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(
    d.getByRole("button", { name: "排空" }).getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(button);
  fireEvent.click(d.getByRole("button", { name: "排空" }));
  expect(sent).toBe(1);
  expect(c.setMachineDrain).not.toHaveBeenCalled();
  // Read back: nothing started, so another click is allowed again.
  await act(async () => hold.resolve());
  await d.findByText(/检查没有开始/);
  await waitFor(() =>
    expect(
      d.getByRole("button", { name: "立即检查" }).getAttribute("aria-disabled"),
    ).toBeNull(),
  );
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  expect(sent).toBe(2);
});

test("V-2540: a lost check reply whose check already ended shows that result", async () => {
  const local = byId("local");
  let sent = false;
  const ended: MachineView = {
    ...local,
    bindings: local.bindings.map((b) =>
      b.is_current
        ? {
            ...b,
            last_requested_check: {
              id: "chk-new",
              kind: "machine",
              status: "failed",
              step: "finished",
              checked_at: "2026-01-01T00:00:05.000Z",
              failed_steps: ["ssh"],
            },
          }
        : b,
    ),
  };
  const c = client({
    machine: vi.fn(async () => ({ machine: sent ? ended : local })),
    checkMachine: vi.fn(async () => {
      sent = true;
      throw new ApiError(502, "bad_gateway", "lost");
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("检查未通过：SSH");
  expect(c.checkMachine).toHaveBeenCalledOnce();
  expect(c.machineCheck).not.toHaveBeenCalled();
});

test("V-2540: a lost drain reply is confirmed by the read-back; a failed read-back retries the read, not the drain", async () => {
  const local = byId("local");
  let applied = false;
  let failRead = false;
  const c = client({
    machine: vi.fn(async () => {
      if (failRead) {
        failRead = false;
        throw new TypeError("read lost");
      }
      return {
        machine: applied ? { ...local, status: "draining" } : local,
      };
    }),
    setMachineDrain: vi.fn(async () => {
      applied = true;
      failRead = true;
      throw new TypeError("reply lost");
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "排空" }));
  await d.findByText(/未能读回机器状态/);
  // Still unconfirmed: nothing else may be sent.
  expect(
    d.getByRole("button", { name: "立即检查" }).getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(d.getByRole("button", { name: "重试" }));
  await d.findByText("已排空，不再接收新任务");
  await d.findByRole("button", { name: "恢复" });
  expect(c.setMachineDrain).toHaveBeenCalledOnce();
});

/** 本机 with one binding's records replaced (peer project by default). */
const withBinding = (
  patch: Partial<MachineView["bindings"][number]>,
  project = "peer",
): MachineView => {
  const local = byId("local");
  return {
    ...local,
    bindings: local.bindings.map((b) =>
      b.project_id === project ? { ...b, ...patch } : b,
    ),
  };
};

test.each([401, 403, 404])(
  "V-2549: a read-back refused with %s takes the facts and the limit field down until a read succeeds",
  async (status) => {
    let refuse = false;
    const c = client({
      machine: vi.fn(async () => {
        if (refuse) throw new ApiError(status, "refused", "拒绝");
        return { machine: byId("local") };
      }),
      checkMachine: vi.fn(async () => {
        refuse = true;
        throw new TypeError("reply lost");
      }),
    });
    const d = await openDetail(c);
    expect(d.getByRole("table", { name: "项目绑定" })).toBeTruthy();
    const listReads = vi.mocked(c.machines).mock.calls.length;
    fireEvent.click(d.getByRole("button", { name: "立即检查" }));
    await d.findByText(/未能读回机器状态/);
    // Down at once: no bindings, no editable limit, no actions.
    expect(d.queryByRole("table", { name: "项目绑定" })).toBeNull();
    expect(d.queryByRole("spinbutton")).toBeNull();
    expect(d.queryByRole("button", { name: "立即检查" })).toBeNull();
    await waitFor(() =>
      expect(vi.mocked(c.machines).mock.calls.length).toBeGreaterThan(
        listReads,
      ),
    );
    // Allowed again: a detail read restores it; the write is not resent.
    refuse = false;
    const retry = d.getAllByRole("button", { name: "重试" });
    for (const button of retry) fireEvent.click(button);
    await d.findByRole("table", { name: "项目绑定" });
    expect(c.checkMachine).toHaveBeenCalledOnce();
  },
);

test("V-2549: a lost reply that joined another project's running check is followed, not sent again", async () => {
  let sent = false;
  const joined = withBinding({
    last_requested_check: {
      id: "chk-peer",
      kind: "machine",
      status: "running",
      step: "ssh",
      checked_at: "2026-01-01T00:00:01.000Z",
      failed_steps: [],
    },
  });
  const hold = Promise.withResolvers<void>();
  const c = client({
    machine: vi.fn(async () => ({ machine: sent ? joined : byId("local") })),
    checkMachine: vi.fn(async () => {
      sent = true;
      throw new TypeError("reply lost");
    }),
    machineCheck: vi.fn(async () => {
      await hold.promise;
      return { check: job({ id: "chk-peer", status: "passed" }) };
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  const running = await d.findByRole("button", { name: "检查中…" });
  await waitFor(() =>
    expect(c.machineCheck).toHaveBeenCalledWith("p-1", "local", "chk-peer"),
  );
  expect(d.queryByText(/检查没有开始/)).toBeNull();
  fireEvent.click(running);
  expect(c.checkMachine).toHaveBeenCalledOnce();
  await act(async () => hold.resolve());
  await d.findByText("检查通过");
});

test("V-2549: a joined check that already ended elsewhere shows its result; one never accepted allows another try", async () => {
  let sent = false;
  const ended = withBinding({
    last_requested_check: {
      id: "chk-peer-2",
      kind: "machine",
      status: "failed",
      step: "finished",
      checked_at: "2026-01-01T00:00:09.000Z",
      failed_steps: ["mcp"],
    },
  });
  const c = client({
    machine: vi.fn(async () => ({ machine: sent ? ended : byId("local") })),
    checkMachine: vi.fn(async () => {
      sent = true;
      throw new TypeError("reply lost");
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("检查未通过：MCP");
  expect(d.queryByText(/检查没有开始/)).toBeNull();
  cleanup();
  // Nothing of this machine moved anywhere: not accepted.
  const c2 = client({
    checkMachine: vi.fn(async () => {
      throw new TypeError("reply lost");
    }),
  });
  const d2 = await openDetail(c2);
  fireEvent.click(d2.getByRole("button", { name: "立即检查" }));
  await d2.findByText(/检查没有开始/);
});

test("V-2549: a health check running without an id keeps the action locked and is read again until it ends", async () => {
  let reads = 0;
  let sent = false;
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
  const c = client({
    machine: vi.fn(async () => {
      if (!sent) return { machine: byId("local") };
      reads += 1;
      return { machine: reads < 3 ? checking : done };
    }),
    checkMachine: vi.fn(async () => {
      sent = true;
      throw new TypeError("reply lost");
    }),
  });
  const d = await openDetail(c);
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("检查进行中，正在等待结果…");
  expect(
    d.getByRole("button", { name: "立即检查" }).getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(d.getByRole("button", { name: "立即检查" }));
  await d.findByText("检查已完成，结果见“最近检查”");
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(c.checkMachine).toHaveBeenCalledOnce();
});
