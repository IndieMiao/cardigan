// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { ExecutionCapacity, ExecutionMachine } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { CapacityProvider } from "./Capacity.js";
import { MachineDetail } from "./MachineDetail.js";

// MC-5 read-only machine facts; kept for the settings page (C-512) after the
// execution view stopped listing machines (C-522).
afterEach(cleanup);

const capacity: ExecutionCapacity = {
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
    {
      machine_id: "spare",
      label: "备用机",
      running: 0,
      total_running: 0,
      limit: 2,
      max_limit: 8,
      queued: 0,
      merge_check_slots: 0,
      resources: [],
    },
  ],
  merge_checks: [],
  merge_config_invalid: false,
};

function show(
  machine: ExecutionMachine,
  executionCapacity: () => Promise<ExecutionCapacity> = async () => capacity,
) {
  return render(
    <CapacityProvider
      client={fakeClient({ executionCapacity })}
      projectId="p-1"
      revision={0}
      canEdit={false}
    >
      <MachineDetail machine={machine} />
    </CapacityProvider>,
  );
}

test("MC-5 lists tags, resources and verified/expired/unverified capabilities", async () => {
  const { container } = show({
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
      {
        key: "godot",
        version: null,
        verified_at: null,
        available: false,
        state: "unverified",
      },
    ],
  });
  await waitFor(() =>
    expect(container.textContent).toContain(
      "非常驻 2 / 上限 4 · 全部 3 · 排队 1",
    ),
  );
  expect(screen.getByText("linux / x64")).toBeTruthy();
  expect(screen.getByText("fast-disk、office")).toBeTruthy();
  const resources = screen.getByRole("region", { name: "工作机 资源占用" });
  expect(resources.textContent).toContain("blender2/2");
  // A full slot reads as in use, not as an error.
  expect(
    within(resources).getByText("2/2").closest(".status")?.className,
  ).toContain("status-running");
  expect(resources.textContent).toContain("ios.simulator0/1");
  const capabilities = screen.getByRole("region", { name: "工作机 能力" });
  const items = within(capabilities).getAllByRole("listitem");
  // Verified first, then expired, then declared-but-never-verified; the last
  // two are greyed and only real checks carry a verification time.
  expect(capabilities.textContent).toContain("能力 1 / 3");
  expect(items[0]?.textContent).toContain("已验证node 24.22.2验证于");
  expect(items[1]?.textContent).toContain("已过期blender 4.2.0验证于");
  expect(items[2]?.textContent).toBe("未验证godot");
  for (const [item, label] of [
    [items[1], "已过期"],
    [items[2], "未验证"],
  ] as const)
    expect(
      within(item as HTMLElement)
        .getByText(label)
        .classList.contains("status-subdued"),
    ).toBe(true);
  // Read-only: no configuration controls.
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
});

test("MC-5 failed health lists blockers; a machine without a capacity row reads unknown", async () => {
  const { container } = show({
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
  });
  await waitFor(() =>
    expect(screen.getByText("机器未就绪、custom_code", { exact: false })),
  );
  expect(container.textContent).toContain("没有已验证能力");
  const unknown = screen.getByRole("region", { name: "远端构建机 资源占用" });
  expect(unknown.textContent).toBe("资源占用未知");
  expect(container.textContent).not.toContain("未配置资源上限");
});

test("MC-5 an explicit empty resource list reads as not configured", async () => {
  show({ id: "spare", label: "备用机", status: "online" });
  const region = screen.getByRole("region", { name: "备用机 资源占用" });
  await waitFor(() =>
    expect(region.textContent).toBe("资源占用未配置资源上限"),
  );
});

test("MC-5 does not claim no resource limits before or without capacity data", async () => {
  show({ id: "local", label: "工作机", status: "online" }, async () => {
    throw new Error("capacity unavailable");
  });
  const resources = screen.getByRole("region", { name: "工作机 资源占用" });
  expect(resources.textContent).toBe("资源占用未知");
  await waitFor(() => expect(resources.textContent).toBe("资源占用未知"));
});
