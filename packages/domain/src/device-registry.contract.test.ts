import { expect, test } from "vitest";
import type { DeviceInitStep, DeviceObservation } from "./device-provider.js";
import {
  type DeviceRegistration,
  deviceActionKey,
  deviceEnabledFor,
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
