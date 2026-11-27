// @vitest-environment jsdom
import {
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
  type MachineDeviceView,
} from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { fixtureMachines } from "../testing/machines-fixture.js";
import { deviceStatus, MachineDevices } from "./MachineDevices.js";

afterEach(cleanup);

const TABLET: MachineDeviceView = {
  machine: "local",
  type: "android.device",
  id: "WGC6R21609003324",
  status: "enabled",
  projects: ["p-1"],
  choices: ["p-1", "peer"],
  model: "MRR-W39",
  state: "in_use",
  holder: {
    project: "p-1",
    run_id: "R-31",
    assignment_id: "A-12",
    since: "2026-01-01T00:00:00.000Z",
    card_id: "C-1",
  },
};
const PHONE: MachineDeviceView = {
  machine: "local",
  type: "android.device",
  id: "R5CT1234567",
  status: "pending",
  projects: [],
  choices: ["p-1", "peer"],
  model: "SM-S9180",
  state: "unauthorized",
};
const BUILDER: MachineDeviceView = {
  machine: "builder",
  type: "android.device",
  id: "EMU0001",
  status: "enabled",
  projects: ["p-1"],
  choices: ["p-1"],
  state: "missing",
  holder: {
    project: "peer",
    run_id: "R-9",
    assignment_id: "A-9",
    since: "2026-01-01T00:00:00.000Z",
  },
};

function setup(overrides: Partial<CardiganClient> = {}, canEdit = true) {
  const machineDevices = vi.fn<NonNullable<CardiganClient["machineDevices"]>>(
    async (_p, machine) => ({
      devices: [TABLET, PHONE, BUILDER].filter((d) => d.machine === machine),
    }),
  );
  const requestMachineDevice = vi.fn<
    NonNullable<CardiganClient["requestMachineDevice"]>
  >(async () => ({ device: { ...PHONE, status: "initializing" } }));
  const client = fakeClient({
    machineDevices,
    requestMachineDevice,
    ...overrides,
  });
  render(
    <MachineDevices
      client={client}
      projectId="p-1"
      machines={fixtureMachines}
      canEdit={canEdit}
    />,
  );
  return { client, machineDevices, requestMachineDevice };
}
const row = (name: string) => screen.getByRole("row", { name });

test("C-818: each machine of this project lists its devices: model, id, status, holder and projects", async () => {
  const { machineDevices } = setup();
  const local = await screen.findByRole("table", { name: "本机 的设备" });
  // Only machines this project registers are read (not the peer's Mac mini).
  expect(machineDevices.mock.calls.map((c) => c[1])).toEqual([
    "local",
    "builder",
  ]);
  const tablet = within(local).getByRole("row", {
    name: "MRR-W39（WGC6R21609003324）",
  });
  expect(tablet.textContent).toContain("WGC6R21609003324");
  expect(within(tablet).getByText("可用")).toBeTruthy();
  // The holding Run's card can be opened.
  expect(
    within(tablet).getByRole("link", { name: /C-1/ }).getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-1");
  expect(tablet.textContent).toContain("R-31");
  expect(tablet.textContent).toContain("p-1");
  const phone = row("SM-S9180（R5CT1234567）");
  expect(within(phone).getByText("待启用")).toBeTruthy();
  expect(phone.textContent).toContain("—");
  const builder = within(
    screen.getByRole("table", { name: "构建机 的设备" }),
  ).getByRole("row", { name: "EMU0001" });
  expect(within(builder).getByText("离线")).toBeTruthy();
  // Another project's Run: only that project, no card of it.
  expect(builder.textContent).toContain("peer");
  expect(within(builder).queryByRole("link")).toBeNull();
});

test("C-818: the status combines enabling and what the check saw", () => {
  const label = (d: Partial<MachineDeviceView>) =>
    deviceStatus({ ...TABLET, ...d }).label;
  expect(label({ status: "pending" })).toBe("待启用");
  expect(label({ status: "initializing" })).toBe("初始化中");
  expect(label({ status: "failed" })).toBe("初始化失败");
  expect(label({ status: "disabled" })).toBe("已停用");
  expect(label({ state: "available" })).toBe("可用");
  expect(label({ state: "unauthorized" })).toBe("未授权");
  expect(label({ state: "offline" })).toBe("离线");
  expect(label({ state: "missing" })).toBe("离线");
  expect(label({ state: "unavailable" })).toBe("不可用");
  const { state: _, ...unknown } = TABLET;
  expect(deviceStatus(unknown).label).toBe("状态未知");
});

test("C-818: disabling sends at once and the row shows the record the server returned", async () => {
  const requestMachineDevice = vi.fn<
    NonNullable<CardiganClient["requestMachineDevice"]>
  >(async () => ({ device: { ...TABLET, status: "disabled" } }));
  setup({ requestMachineDevice });
  const tablet = await screen.findByRole("row", {
    name: "MRR-W39（WGC6R21609003324）",
  });
  fireEvent.click(
    within(tablet).getByRole("button", {
      name: "停用MRR-W39（WGC6R21609003324）",
    }),
  );
  await waitFor(() => expect(within(tablet).getByText("已停用")).toBeTruthy());
  expect(requestMachineDevice.mock.calls).toEqual([
    ["p-1", "local", "android.device", TABLET.id, { request: "disable" }],
  ]);
  expect(within(tablet).getByRole("button", { name: /^启用/ })).toBeTruthy();
});

test("C-818: enabling a device of a shared machine asks for the projects; changing projects sends assign", async () => {
  const requestMachineDevice = vi.fn<
    NonNullable<CardiganClient["requestMachineDevice"]>
  >(async (_p, _m, _t, id, body) => ({
    device: {
      ...(id === PHONE.id ? PHONE : TABLET),
      status: body.request === "enable" ? "initializing" : "enabled",
      projects: "projects" in body ? (body.projects ?? []) : [],
    },
  }));
  setup({ requestMachineDevice });
  const phone = await screen.findByRole("row", {
    name: "SM-S9180（R5CT1234567）",
  });
  fireEvent.click(
    within(phone).getByRole("button", { name: "启用SM-S9180（R5CT1234567）" }),
  );
  let dialog = await screen.findByRole("dialog", { name: "给哪些项目用？" });
  expect(requestMachineDevice).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "peer" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "启用" }));
  await waitFor(() => expect(within(phone).getByText("初始化中")).toBeTruthy());
  expect(requestMachineDevice.mock.calls[0]).toEqual([
    "p-1",
    "local",
    "android.device",
    PHONE.id,
    { request: "enable", projects: ["peer"] },
  ]);
  expect(phone.textContent).toContain("peer");

  const tablet = row("MRR-W39（WGC6R21609003324）");
  fireEvent.click(
    within(tablet).getByRole("button", {
      name: "修改MRR-W39（WGC6R21609003324）的项目",
    }),
  );
  dialog = await screen.findByRole("dialog", { name: "修改设备的项目" });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "peer" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "保存项目" }));
  await waitFor(() => expect(requestMachineDevice).toHaveBeenCalledTimes(2));
  expect(requestMachineDevice.mock.calls[1]?.[4]).toEqual({
    request: "assign",
    projects: ["p-1", "peer"],
  });
  await waitFor(() => expect(tablet.textContent).toContain("p-1、peer"));
});

test("C-818: a failed request keeps the row as it was and retries from the feedback", async () => {
  const requestMachineDevice = vi
    .fn<NonNullable<CardiganClient["requestMachineDevice"]>>()
    .mockRejectedValueOnce(
      new ApiError(409, "illegal_transition", "设备状态刚刚变化，请刷新后重试"),
    )
    .mockResolvedValueOnce({ device: { ...TABLET, status: "disabled" } });
  setup({ requestMachineDevice });
  const tablet = await screen.findByRole("row", {
    name: "MRR-W39（WGC6R21609003324）",
  });
  fireEvent.click(
    within(tablet).getByRole("button", {
      name: "停用MRR-W39（WGC6R21609003324）",
    }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("未能停用MRR-W39（WGC6R21609003324）");
  expect(alert.textContent).toContain("设备状态刚刚变化，请刷新后重试");
  expect(within(tablet).getByText("可用")).toBeTruthy();
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  await waitFor(() => expect(within(tablet).getByText("已停用")).toBeTruthy());
  expect(requestMachineDevice).toHaveBeenCalledTimes(2);
  expect(requestMachineDevice.mock.calls[1]?.[4]).toEqual({
    request: "disable",
  });
});

test("C-818: a read-only session sees the list without actions", async () => {
  setup({}, false);
  await screen.findByRole("table", { name: "本机 的设备" });
  expect(screen.queryByRole("columnheader", { name: "操作" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^停用/ })).toBeNull();
});

test("C-818: machines without devices show one short empty state", async () => {
  setup({ machineDevices: vi.fn(async () => ({ devices: [] })) });
  expect(await screen.findByText("没有设备")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
});
