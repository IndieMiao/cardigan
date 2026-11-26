// @vitest-environment jsdom
// C-800: the machine detail lists every project's reservations; the owner's
// session cancels one only after confirming with a reason.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type {
  CardiganClient,
  ExecutionCapacity,
  MachineReservationView,
  MachineView,
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

const capacity: ExecutionCapacity = {
  agents: [
    {
      machine_id: "local",
      label: "本机",
      running: 0,
      total_running: 0,
      limit: 6,
      max_limit: 16,
      queued: 0,
      merge_check_slots: 0,
    },
  ],
  merge_checks: [],
  merge_config_invalid: false,
};
const reservation: MachineReservationView = {
  reservation_id: "rsv-1",
  resource: "android.emulator",
  holder_project: "cardigan",
  source: "human",
  starts_at: "2026-11-26T11:45:00.000Z",
  ends_at: "2026-11-27T04:00:00.000Z",
};
function client(overrides: Partial<CardiganClient> = {}) {
  let reservations: readonly MachineReservationView[] = [reservation];
  const local = () =>
    ({
      ...(fixtureMachines.find((m) => m.id === "local") as MachineView),
      reservations,
    }) satisfies MachineView;
  return fakeClient({
    executionCapacity: vi.fn(async () => capacity),
    machines: vi.fn(async () => ({ machines: [local()] })),
    machine: vi.fn(async () => ({ machine: local() })),
    cancelMachineReservation: vi.fn(async () => {
      reservations = [];
      return { reservation_id: "rsv-1", released_runs: 2 };
    }),
    ...overrides,
  });
}
async function openDetail(c: CardiganClient, canEdit = true) {
  render(
    <CapacityProvider client={c} projectId="p-1" revision={0} canEdit={canEdit}>
      <MachinesSettings client={c} projectId="p-1" pollMs={5} revision={0} />
    </CapacityProvider>,
  );
  const table = await screen.findByRole("table", { name: "机器列表" });
  fireEvent.click(within(table).getByRole("button", { name: "本机" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("概况");
  return within(dialog);
}

test("the drawer lists the holder project, source, window and id of each reservation", async () => {
  const dialog = await openDetail(client());
  const table = await dialog.findByRole("table", { name: "资源预约" });
  const cells = within(table)
    .getAllByRole("cell")
    .map((c) => c.textContent);
  expect(cells.slice(0, 3)).toEqual(["android.emulator", "cardigan", "人工"]);
  expect(cells).toContain("rsv-1");
  expect(
    within(table).getByRole("button", { name: "取消预约 rsv-1" }),
  ).toBeTruthy();
});

test("cancel asks for a reason first, keeps the reservation when dismissed, then rereads after cancelling", async () => {
  const c = client();
  const dialog = await openDetail(c);
  const reads = vi.mocked(c.machine).mock.calls.length;
  fireEvent.click(
    await dialog.findByRole("button", { name: "取消预约 rsv-1" }),
  );
  let confirm = await screen.findByRole("dialog", { name: "取消这个预约？" });
  const confirmButton = () =>
    within(confirm).getByRole("button", { name: "取消预约" });
  // Without a reason the confirmation does nothing.
  expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(confirmButton());
  expect(c.cancelMachineReservation).not.toHaveBeenCalled();
  fireEvent.click(within(confirm).getByRole("button", { name: "保留预约" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "取消这个预约？" })).toBeNull(),
  );
  expect(c.cancelMachineReservation).not.toHaveBeenCalled();

  fireEvent.click(dialog.getByRole("button", { name: "取消预约 rsv-1" }));
  confirm = await screen.findByRole("dialog", { name: "取消这个预约？" });
  fireEvent.change(within(confirm).getByLabelText("取消原因"), {
    target: { value: "所有者要求恢复模拟器" },
  });
  fireEvent.click(confirmButton());
  await waitFor(() =>
    expect(c.cancelMachineReservation).toHaveBeenCalledWith(
      "p-1",
      "local",
      "rsv-1",
      "所有者要求恢复模拟器",
    ),
  );
  await screen.findByText("已取消预约 rsv-1");
  await dialog.findByText("没有预约");
  expect(vi.mocked(c.machine).mock.calls.length).toBeGreaterThan(reads);
});

test("without the owner's edit right the reservations are read-only; a refusal is reported", async () => {
  const readOnly = await openDetail(client(), false);
  await readOnly.findByRole("table", { name: "资源预约" });
  expect(readOnly.queryByRole("button", { name: "取消预约 rsv-1" })).toBeNull();
  cleanup();
  const c = client({
    cancelMachineReservation: vi.fn(async () => {
      throw new Error("预约已结束");
    }),
  });
  const dialog = await openDetail(c);
  fireEvent.click(
    await dialog.findByRole("button", { name: "取消预约 rsv-1" }),
  );
  const confirm = await screen.findByRole("dialog", { name: "取消这个预约？" });
  fireEvent.change(within(confirm).getByLabelText("取消原因"), {
    target: { value: "x" },
  });
  fireEvent.click(within(confirm).getByRole("button", { name: "取消预约" }));
  await screen.findByText(/预约已结束/);
});
