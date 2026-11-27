import { expect, test } from "vitest";
import type { DeviceInitStep, DeviceObservation } from "./device-provider.js";
import {
  type DeviceRegistration,
  deviceActionKey,
  deviceAlternativeKeys,
  deviceEnabledFor,
  deviceHeldReason,
  deviceInitProject,
  deviceRegistrationNext,
  deviceUnavailableReason,
  normalizeDeviceInitResult,
  preselectedDeviceProject,
  validateDeviceProjects,
  waitsOnDevice,
} from "./device-registry.js";

const base: DeviceRegistration = {
  machine: "mac-mini",
  type: "android.device",
  id: "WGC6R21609003324",
  status: "pending",
  projects: [],
  model: "MRR-W39",
  discovered_at: "2032-01-01T00:00:00.000Z",
  updated_at: "2032-01-01T00:00:00.000Z",
};
const steps: DeviceInitStep[] = [
  { key: "stay_awake", title: "插电常亮" },
  { key: "lock_screen", title: "关闭锁屏", hint: "先在设备上取消锁屏密码" },
];

test("C-817: enabling initializes unless already initialized; disabling and assigning keep leases to the lease rules", () => {
  expect(deviceRegistrationNext(base, "enable")).toEqual({
    status: "initializing",
  });
  expect(
    deviceRegistrationNext({ ...base, status: "failed" }, "enable"),
  ).toEqual({ status: "initializing" });
  expect(
    deviceRegistrationNext({ ...base, status: "initializing" }, "enable"),
  ).toHaveProperty("error");
  expect(
    deviceRegistrationNext({ ...base, status: "enabled" }, "enable"),
  ).toEqual({ status: "enabled" });
  // Re-enabling a disabled device that was initialized before needs no new run.
  expect(
    deviceRegistrationNext(
      { ...base, status: "disabled", initialized_at: base.updated_at },
      "enable",
    ),
  ).toEqual({ status: "enabled" });
  expect(
    deviceRegistrationNext({ ...base, status: "disabled" }, "enable"),
  ).toEqual({ status: "initializing" });
  for (const status of ["pending", "enabled", "failed"] as const)
    expect(deviceRegistrationNext({ ...base, status }, "disable")).toEqual({
      status: "disabled",
    });
  expect(
    deviceRegistrationNext({ ...base, status: "enabled" }, "assign"),
  ).toEqual({ status: "enabled" });
});

test("C-817: only an enabled device assigned to the project is dispatchable to it", () => {
  const enabled = { ...base, status: "enabled" as const, projects: ["a"] };
  expect(deviceEnabledFor(enabled, "a")).toBe(true);
  expect(deviceEnabledFor(enabled, "b")).toBe(false);
  expect(deviceEnabledFor(undefined, "a")).toBe(false);
  for (const status of [
    "pending",
    "initializing",
    "failed",
    "disabled",
  ] as const)
    expect(deviceEnabledFor({ ...enabled, status }, "a")).toBe(false);
});

test("C-817: project choices come from the machine; a single-project machine is preselected", () => {
  expect(preselectedDeviceProject(["sensen"])).toBe("sensen");
  expect(preselectedDeviceProject(["a", "b"])).toBeUndefined();
  expect(validateDeviceProjects([" a", "a", "b"], ["a", "b"])).toEqual({
    projects: ["a", "b"],
  });
  expect(validateDeviceProjects([], ["a"])).toHaveProperty("error");
  expect(validateDeviceProjects(["c"], ["a", "b"])).toEqual({
    error: "机器没有登记给项目 c",
  });
  // Init runs as the first chosen project whose account sees the device.
  expect(deviceInitProject(["a", "b"], (p) => p === "b")).toBe("b");
  expect(deviceInitProject(["a", "b"], () => false)).toBe("a");
});

test("C-817: initialization output is reduced to fixed texts and strict values", () => {
  expect(
    normalizeDeviceInitResult(
      { result: "ok", resolution: "1600x2560", version: "12" },
      steps,
    ),
  ).toEqual({ ok: true, resolution: "1600x2560", version: "12" });
  expect(
    normalizeDeviceInitResult(
      { result: "ok", resolution: "1600x2560; rm -rf /", version: "12 beta" },
      steps,
    ),
  ).toEqual({ ok: true });
  expect(
    normalizeDeviceInitResult({ result: "failed", step: "lock_screen" }, steps),
  ).toEqual({
    ok: false,
    reason: "“关闭锁屏”没有成功：先在设备上取消锁屏密码",
  });
  expect(
    normalizeDeviceInitResult({ result: "failed", step: "stay_awake" }, steps),
  ).toEqual({ ok: false, reason: "“插电常亮”没有成功" });
  for (const raw of [
    undefined,
    null,
    "ok",
    { result: "failed", step: "<script>" },
    { result: "weird", message: "device said hi" },
  ]) {
    const outcome = normalizeDeviceInitResult(raw, steps);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toMatch(/script|device said/u);
  }
  expect(
    normalizeDeviceInitResult({ result: "not_found" }, steps),
  ).toMatchObject({
    ok: false,
    reason: expect.stringContaining("没有看到这台设备"),
  });
  expect(
    normalizeDeviceInitResult({ result: "unauthorized" }, steps),
  ).toMatchObject({ ok: false, reason: expect.stringContaining("授权") });
});

test("C-817: unusable states have plain reasons; usable ones none", () => {
  expect(deviceUnavailableReason(undefined)).toBe("已拔掉或看不到");
  expect(deviceUnavailableReason("unauthorized")).toBe("掉了授权");
  expect(deviceUnavailableReason("offline")).toBe("离线");
  expect(deviceUnavailableReason("available")).toBeUndefined();
  expect(deviceUnavailableReason("in_use")).toBeUndefined();
});

test("C-817: waiting work is affected only when no other usable device can serve it", () => {
  const device = { type: "android.device", id: "AAA", model: "MRR-W39" };
  const other: DeviceObservation = {
    type: "android.device",
    id: "BBB",
    state: "available",
    model: "Pixel 7",
  };
  expect(waitsOnDevice(["android.device"], device, [])).toBe(true);
  expect(waitsOnDevice(["android.device"], device, [other])).toBe(false);
  expect(
    waitsOnDevice(["android.device", "android.device:AAA"], device, [other]),
  ).toBe(true);
  expect(
    waitsOnDevice(["android.device", "android.device.model.mrr-w39"], device, [
      other,
    ]),
  ).toBe(true);
  expect(
    waitsOnDevice(["android.device", "android.device:BBB"], device, []),
  ).toBe(false);
  expect(waitsOnDevice(["android.emulator"], device, [])).toBe(false);
  // An unusable other device does not serve it either.
  expect(
    waitsOnDevice(["android.device"], device, [{ ...other, state: "offline" }]),
  ).toBe(true);
});

test("C-827: a queued android.any waits on the device only while no other option is available", () => {
  const device = { type: "android.device", id: "AAA", model: "MRR-W39" };
  const other: DeviceObservation = {
    type: "android.device",
    id: "BBB",
    state: "available",
  };
  const any = ["android.any"];
  // No emulator on the machine: the device is its only way out.
  expect(deviceAlternativeKeys(any, "android.device", [])).toEqual([
    "android.any",
    "android.device",
  ]);
  expect(waitsOnDevice(any, device, [], [])).toBe(true);
  expect(waitsOnDevice(any, device, [], ["android.sdk"])).toBe(true);
  // Another usable device still serves it.
  expect(waitsOnDevice(any, device, [other], [])).toBe(false);
  // An available emulator can still take the work: no reminder.
  expect(
    deviceAlternativeKeys(any, "android.device", ["android.emulator"]),
  ).toBe(any);
  expect(waitsOnDevice(any, device, [], ["android.emulator"])).toBe(false);
  // Without the machine's capabilities the C-817 judgment is unchanged.
  expect(waitsOnDevice(any, device, [])).toBe(false);
  // Already narrowed to one option: judged by that option as before.
  expect(
    waitsOnDevice(["android.any", "android.emulator"], device, [], []),
  ).toBe(false);
  expect(
    waitsOnDevice(
      ["android.any", "android.device"],
      device,
      [],
      ["android.emulator"],
    ),
  ).toBe(true);
  // Emulator-only and device-only requirements keep their C-817 answers.
  expect(waitsOnDevice(["android.emulator"], device, [], [])).toBe(false);
  expect(
    waitsOnDevice(["android.device"], device, [], ["android.emulator"]),
  ).toBe(true);
  expect(
    waitsOnDevice(["android.device"], device, [other], ["android.emulator"]),
  ).toBe(false);
  // A different device type is never added.
  expect(deviceAlternativeKeys(any, "ios.device", [])).toBe(any);
});

test("C-817: device to-do keys carry only validated ids", () => {
  expect(deviceActionKey("enable", "mac-mini", "android.device", "AAA")).toBe(
    "device-enable:mac-mini:android.device:AAA",
  );
  for (const [machine, type, id] of [
    ["mac mini", "android.device", "AAA"],
    ["mac-mini", "Android", "AAA"],
    ["mac-mini", "android.device", "A:B"],
  ] as const)
    expect(() => deviceActionKey("enable", machine, type, id)).toThrow();
});

test("C-833: a held device names the adb server's port and its sessions; free text and odd values never pass", () => {
  expect(
    deviceHeldReason({ port: 15100, kind: "slot", sessions: ["SEN-A-12"] }),
  ).toBe(
    "设备被端口 15100 上的 adb 服务占用，属于会话 SEN-A-12：等这个 Run 结束、系统关掉它的 adb 服务后重试",
  );
  expect(
    deviceHeldReason({
      port: 5137,
      kind: "legacy",
      sessions: ["SEN-A-634", "sensen/A-602"],
    }),
  ).toBe(
    "设备被端口 5137 上的旧 adb 服务占用，可能属于切换前起的会话 SEN-A-634、sensen/A-602：系统巡检会让它放开 USB 设备，几分钟后重试",
  );
  expect(deviceHeldReason({ port: 5137, kind: "legacy", sessions: [] })).toBe(
    "设备被端口 5137 上的旧 adb 服务占用，不属于系统登记的会话：系统巡检会让它放开 USB 设备，几分钟后重试",
  );
  expect(deviceHeldReason({ port: 5037, kind: "other", sessions: [] })).toBe(
    "设备被端口 5037 上的 adb 服务占用，不属于系统登记的会话：在机器上执行 adb -P 5037 kill-server 后重试",
  );
  const many = Array.from({ length: 7 }, (_, i) => `SEN-A-${i + 1}`);
  expect(
    deviceHeldReason({ port: 5137, kind: "legacy", sessions: many }),
  ).toContain("SEN-A-5 等 7 个会话");
  const odd = deviceHeldReason({
    port: 1e9,
    kind: "slot",
    sessions: ["A-1; rm -rf /", "x".repeat(81)],
  });
  expect(odd).toBe(
    "设备被端口 0 上的 adb 服务占用：等这个 Run 结束、系统关掉它的 adb 服务后重试",
  );
});
