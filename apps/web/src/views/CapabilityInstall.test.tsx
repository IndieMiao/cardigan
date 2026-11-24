// @vitest-environment jsdom
// C-708: a first-batch tool's install entry in the machine detail.
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
  MachineBindingView,
  MachineCheckJob,
  MachineView,
} from "../api.js";
import { CapacityProvider } from "../components/Capacity.js";
import { fakeClient } from "../testing/fixtures.js";
import { fixtureMachines } from "../testing/machines-fixture.js";
import { capabilityCheckResult } from "./CapabilityInstall.js";
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

const CHECKED = "2025-12-31T22:00:00.000Z";
const local = fixtureMachines.find((m) => m.id === "local") as MachineView;
const current = local.bindings.find((b) => b.is_current) as MachineBindingView;
const capability = (
  key: string,
  state: "verified" | "unverified",
  probe?: MachineBindingView["capabilities"][number]["probe"],
) => ({
  key,
  version: state === "verified" ? "24.11.0" : null,
  verified_at: state === "verified" ? CHECKED : null,
  available: state === "verified",
  state,
  ...(probe ? { probe } : {}),
});
/** 本机 with its current binding replaced: catalog keys, probes, failures. */
const machineWith = (
  patch: Partial<MachineBindingView>,
  machine: Partial<MachineView> = {},
): MachineView => ({
  ...local,
  ...machine,
  bindings: local.bindings.map((b) =>
    b.is_current
      ? {
          ...b,
          runtime: { ...(b.runtime as object), account: "worker-a" } as never,
          ...patch,
        }
      : b,
  ),
});
const NODE_PROBE = { kind: "command", argv: ["node", "--version"] } as const;
const SEARCH = {
  kind: "search",
  locations: ["PATH:chromium", "$HOME/.cache/ms-playwright"],
} as const;
const before = machineWith({
  capabilities: [
    capability("harness.codex", "verified"),
    capability("node", "unverified", NODE_PROBE),
    capability("browser.chromium", "unverified", SEARCH),
    capability("harness.pi", "unverified"),
  ],
  capability_failures: [
    {
      key: "browser.chromium",
      search_locations: ["PATH:chromium", "$HOME/.cache/ms-playwright"],
    },
  ],
});
const after = machineWith({
  capabilities: [
    capability("harness.codex", "verified"),
    capability("node", "verified", NODE_PROBE),
    capability("browser.chromium", "unverified", SEARCH),
    capability("harness.pi", "unverified"),
  ],
});
const capacity: ExecutionCapacity = {
  agents: [],
  merge_checks: [],
  merge_config_invalid: false,
};
const job = (patch: Partial<MachineCheckJob> = {}): MachineCheckJob => ({
  id: "chk-1",
  project_id: "p-1",
  machine_id: "local",
  kind: "machine",
  status: "running",
  step: "capabilities",
  started_at: "2026-01-01T00:00:00.000Z",
  checked_at: "2026-01-01T00:00:00.000Z",
  failed_steps: [],
  ...patch,
});
function client(state: { machine: MachineView }, overrides = {}) {
  return fakeClient({
    executionCapacity: vi.fn(async () => capacity),
    machines: vi.fn(async () => ({ machines: [state.machine] })),
    machine: vi.fn(async () => ({ machine: state.machine })),
    setRunLimit: vi.fn(async () => {}),
    checkMachine: vi.fn(async () => ({ check: job() })),
    machineCheck: vi.fn(async () => {
      // The host's check registered node before it reports the end.
      state.machine = after;
      return { check: job({ status: "passed", step: "finished" }) };
    }),
    ...overrides,
  });
}
async function openDetail(c: CardiganClient, canEdit = true) {
  render(
    <CapacityProvider client={c} projectId="p-1" revision={0} canEdit={canEdit}>
      <MachinesSettings client={c} projectId="p-1" pollMs={5} />
    </CapacityProvider>,
  );
  const table = await screen.findByRole("table", { name: "机器列表" });
  fireEvent.click(within(table).getByRole("button", { name: "本机" }));
  const drawer = await screen.findByRole("dialog");
  await within(drawer).findByText("概况");
  return within(drawer);
}
const fact = (dialog: HTMLElement, label: string) =>
  within(dialog).queryByText(label, { selector: "dt" })?.nextElementSibling
    ?.textContent;

test("unverified first-batch tools have 安装; commands per system; 复查 registers the tool", async () => {
  const state = { machine: before };
  const c = client(state);
  const drawer = await openDetail(c);
  const table = drawer.getByRole("table", { name: "能力" });
  // Only this project's unverified first-batch tools; harness.pi has no guide.
  expect(
    within(table)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual(["安装 browser.chromium", "安装 node"]);
  const opener = within(table).getByRole("button", { name: "安装 node" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "安装 node" });
  const view = within(dialog);
  expect(fact(dialog, "状态")).toBe("未验证");
  expect(fact(dialog, "检测命令")).toBe("node --version ");
  expect(fact(dialog, "检查结果")).toContain(
    "未检出：检测命令未成功运行或没有输出版本号",
  );
  expect(fact(dialog, "执行账号")).toBe("worker-a");
  // A Linux machine: Linux first, SteamOS beside it; never macOS.
  const systems = view.getByRole("group", { name: "系统" });
  expect(
    within(systems)
      .getAllByRole("button")
      .map((b) => [b.textContent, b.getAttribute("aria-pressed")]),
  ).toEqual([
    ["Linux", "true"],
    ["SteamOS", "false"],
  ]);
  const commands = () =>
    view.getByLabelText("安装命令", { selector: "pre" }).textContent ?? "";
  expect(commands()).toContain("node-v[0-9.]*-linux-x64");
  expect(commands()).not.toContain("worker-a");
  fireEvent.click(within(systems).getByRole("button", { name: "SteamOS" }));
  expect(commands()).toContain("SteamOS 根分区只读");
  const writeText = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText } });
  fireEvent.click(view.getByRole("button", { name: "复制命令" }));
  await view.findByText("已复制安装命令");
  expect(writeText).toHaveBeenCalledWith(commands());

  fireEvent.click(view.getByRole("button", { name: "复查" }));
  await waitFor(() => expect(fact(dialog, "状态")).toBe("已验证 24.11.0"));
  expect(c.checkMachine).toHaveBeenCalledTimes(1);
  expect(fact(dialog, "检查结果")).toBeUndefined();
  // The row no longer offers 安装; the dialog stays on the system picked.
  expect(
    drawer.queryByRole("button", { name: "安装 node", hidden: true }),
  ).toBeNull();
  expect(commands()).toContain("SteamOS");
  fireEvent.click(view.getByRole("button", { name: "关闭" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "安装 node" })).toBeNull(),
  );
  // Its 安装 button is gone: focus goes to the drawer's close button.
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe("关闭抽屉"),
  );
});

test("the browser search shows where it looked; a read-only session gets commands but no 复查", async () => {
  const c = client({ machine: before });
  const drawer = await openDetail(c, false);
  fireEvent.click(
    drawer.getByRole("button", { name: "安装 browser.chromium" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "安装 browser.chromium",
  });
  expect(fact(dialog, "检测位置")).toBe(
    "PATH:chromium $HOME/.cache/ms-playwright ",
  );
  // Every listed location was searched: they are not repeated.
  expect(fact(dialog, "检查结果")).toContain("未检出：检测位置都没有找到");
  expect(within(dialog).queryByRole("button", { name: "复查" })).toBeNull();
  expect(
    within(dialog).getByLabelText("安装命令", { selector: "pre" }).textContent,
  ).toContain("npx -y playwright install chromium");
  expect(c.checkMachine).not.toHaveBeenCalled();
});

test("a macOS machine offers only macOS commands", async () => {
  const c = client({
    machine: machineWith(
      { capabilities: [capability("godot", "unverified")] },
      { os: "darwin", arch: "arm64" },
    ),
  });
  const drawer = await openDetail(c);
  fireEvent.click(drawer.getByRole("button", { name: "安装 godot" }));
  const dialog = await screen.findByRole("dialog", { name: "安装 godot" });
  expect(within(dialog).queryByRole("group", { name: "系统" })).toBeNull();
  expect(
    within(dialog).getByLabelText("安装命令", { selector: "pre" }).textContent,
  ).toContain("macos.universal.zip");
  // Without a host probe (an older server) no probe line is invented.
  expect(fact(dialog, "检测命令")).toBeUndefined();
});

test("the check result says why a capability was not verified", () => {
  const binding = (patch: Partial<MachineBindingView>) => ({
    ...current,
    capabilities: [capability("node", "unverified")],
    ...patch,
  });
  expect(capabilityCheckResult(binding({ machine_check: null }), "node")).toBe(
    "尚未检查",
  );
  expect(
    capabilityCheckResult(
      binding({
        machine_check: {
          status: "failed",
          checked_at: CHECKED,
          blockers: ["machine_check_failed"],
          available: false,
        },
      }),
      "node",
    ),
  ).toBe("机器检查未通过：机器检查失败");
  expect(
    capabilityCheckResult(
      binding({
        capability_failures: [
          {
            key: "node",
            search_locations: [],
            reason: "fixed host reason",
          },
        ],
      }),
      "node",
    ),
  ).toBe("未检出：fixed host reason");
  expect(
    capabilityCheckResult(
      binding({
        capability_failures: [
          {
            key: "node",
            search_locations: ["PATH:x"],
            search_incomplete: true,
          },
        ],
      }),
      "node",
    ),
  ).toBe("未检出：已查找 PATH:x；查找未完成");
  // Every location of the probe was searched: not listed twice.
  expect(
    capabilityCheckResult(
      binding({
        capabilities: [
          {
            ...capability("browser.chromium", "unverified"),
            probe: { kind: "search", locations: ["PATH:x", "PATH:y"] },
          },
        ],
        capability_failures: [
          { key: "browser.chromium", search_locations: ["PATH:x", "PATH:y"] },
        ],
      }),
      "browser.chromium",
    ),
  ).toBe("未检出：检测位置都没有找到");
  expect(
    capabilityCheckResult(
      binding({ capabilities: [capability("node", "verified")] }),
      "node",
    ),
  ).toBeUndefined();
});
