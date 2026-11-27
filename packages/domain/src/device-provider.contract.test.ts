import { expect, test } from "vitest";
import {
  chooseDevice,
  type DeviceObservation,
  type DeviceProviderPort,
  deviceCapabilities,
  deviceMatches,
  deviceResourceName,
  isDeviceKey,
  mergeHeldDevices,
  normalizeDeviceInventory,
  validateDeviceSessionEnv,
  withDeviceTypes,
} from "./device-provider.js";
import { parseCapabilityRequirement } from "./machine-requirements.js";

const TYPE = "android.device";
const tablet: DeviceObservation = {
  type: TYPE,
  id: "WGC6R21609003324",
  state: "available",
  model: "MRR-W39",
  version: "12",
};

test("a listing keeps only strictly valid fields, at most 16 devices, sorted by id", () => {
  expect(
    normalizeDeviceInventory(TYPE, [
      {
        id: "WGC6R21609003324",
        state: "available",
        model: "MRR-W39",
        version: "12",
      },
      { id: "R58N", state: "unauthorized", model: "SM_G991B" },
      { id: "OFF1", state: "offline" },
      { id: "ODD", state: "bootloader" },
      { id: "BAD", state: "available", model: "x\n$(id)", version: "12; rm" },
      { id: "with space", state: "available" },
      { id: "192.168.1.5:5555", state: "available" },
      { id: "WGC6R21609003324", state: "offline" },
      "junk",
      null,
    ]),
  ).toEqual([
    { type: TYPE, id: "BAD", state: "available" },
    { type: TYPE, id: "ODD", state: "unavailable" },
    { type: TYPE, id: "OFF1", state: "offline" },
    { type: TYPE, id: "R58N", state: "unauthorized", model: "SM_G991B" },
    tablet,
  ]);
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `S${i}`,
    state: "available",
  }));
  expect(normalizeDeviceInventory(TYPE, many)).toHaveLength(16);
  expect(() => normalizeDeviceInventory("Bad Type", [])).toThrow();
});

test("each device is a capacity-1 resource <type>:<id> and rolls up into the type capability", () => {
  expect(deviceResourceName(TYPE, tablet.id)).toBe(
    "android.device:WGC6R21609003324",
  );
  expect(() => deviceResourceName(TYPE, "a:b")).toThrow();
  expect(
    deviceCapabilities([
      tablet,
      { type: TYPE, id: "R58N", state: "unauthorized" },
      { type: TYPE, id: "HELD", state: "in_use", model: "Pixel 8" },
    ]),
  ).toEqual([
    "android.device",
    "android.device.model.mrr-w39",
    "android.device.model.pixel-8",
    "android.device:HELD",
    "android.device:WGC6R21609003324",
  ]);
  expect(
    deviceCapabilities([{ type: TYPE, id: "X", state: "offline" }]),
  ).toEqual([]);
  // Every capability key is a valid work item requirement.
  for (const key of deviceCapabilities([tablet]))
    expect(parseCapabilityRequirement(key)).toMatchObject({
      ok: true,
      value: { key },
    });
  expect(parseCapabilityRequirement("android.device:bad id").ok).toBe(false);
  expect(parseCapabilityRequirement("android.device:").ok).toBe(false);
});

test("requirements name the type, optionally narrowed by id or model, and always take a type slot", () => {
  expect(isDeviceKey(TYPE, "android.device")).toBe(true);
  expect(isDeviceKey(TYPE, "android.device:X")).toBe(true);
  expect(isDeviceKey(TYPE, "android.device.model.m")).toBe(true);
  expect(isDeviceKey(TYPE, "android.emulator")).toBe(false);
  expect(deviceMatches(tablet, ["android.device", "godot"])).toBe(true);
  expect(deviceMatches(tablet, ["android.device.model.mrr-w39"])).toBe(true);
  expect(deviceMatches(tablet, ["android.device:WGC6R21609003324"])).toBe(true);
  expect(deviceMatches(tablet, ["android.device:OTHER"])).toBe(false);
  expect(withDeviceTypes(["android.device:X", "godot"], [TYPE])).toEqual([
    "android.device:X",
    "godot",
    "android.device",
  ]);
  expect(withDeviceTypes(["android.emulator"], [TYPE])).toEqual([
    "android.emulator",
  ]);
});

test("a device goes to one holder: held, reserved or unusable devices are skipped", () => {
  const other: DeviceObservation = {
    type: TYPE,
    id: "AAA",
    state: "available",
    model: "Pixel 8",
  };
  const list = [
    tablet,
    other,
    { ...tablet, id: "R58N", state: "unauthorized" as const },
  ];
  expect(chooseDevice(TYPE, list, ["android.device"], new Set())?.id).toBe(
    "AAA",
  );
  expect(
    chooseDevice(TYPE, list, ["android.device"], new Set(["AAA"]))?.id,
  ).toBe(tablet.id);
  expect(
    chooseDevice(TYPE, list, ["android.device"], new Set(["AAA", tablet.id])),
  ).toBeUndefined();
  expect(
    chooseDevice(TYPE, list, ["android.device.model.mrr-w39"], new Set())?.id,
  ).toBe(tablet.id);
  expect(chooseDevice(TYPE, list, ["android.device:R58N"], new Set())).toBe(
    undefined,
  );
  expect(chooseDevice(TYPE, list, ["android.emulator"], new Set())).toBe(
    undefined,
  );
  // A held device left as in_use is handed out again once its lease is gone.
  expect(
    chooseDevice(TYPE, [{ ...tablet, state: "in_use" }], [TYPE], new Set())?.id,
  ).toBe(tablet.id);
});

test("a held device stays listed as in use with what was last known", () => {
  const held = new Set([tablet.id, "GONE"]);
  expect(mergeHeldDevices([], [tablet], held)).toEqual([
    { ...tablet, state: "in_use" },
  ]);
  expect(
    mergeHeldDevices(
      [{ type: TYPE, id: tablet.id, state: "offline" }],
      [tablet],
      held,
    ),
  ).toEqual([{ ...tablet, state: "in_use" }]);
  // Unplugged and not held: it disappears.
  expect(mergeHeldDevices([], [tablet], new Set())).toEqual([]);
});

test("a session environment may only name the device", () => {
  expect(
    validateDeviceSessionEnv({
      ANDROID_SERIAL: "WGC6R21609003324",
      CARDIGAN_DEVICE_SERIAL: "WGC6R21609003324",
    }),
  ).toEqual({
    ANDROID_SERIAL: "WGC6R21609003324",
    CARDIGAN_DEVICE_SERIAL: "WGC6R21609003324",
  });
  for (const env of [
    { PATH: "/tmp" },
    { LD_PRELOAD: "x" },
    { ANDROID_SERIAL: "x; rm -rf /" },
    { CARDIGAN_DEVICE_SERIAL: "" },
    { ADB_VENDOR_KEYS: "/home/user/.android" },
  ])
    expect(() => validateDeviceSessionEnv(env)).toThrow();
});

test("the port shape: listing, session environment, prompt rule and setup steps", async () => {
  const provider: DeviceProviderPort<{ readonly rows: unknown[] }> = {
    type: "fixture.device",
    label: "fixture",
    os: ["linux"],
    setup_steps: [{ title: "plug it in" }],
    list: async (target) => target.rows,
    sessionEnv: (device) => ({ CARDIGAN_DEVICE_SERIAL: device.id }),
    sessionRule: (device) => `use ${device.id}`,
  };
  const raw = await provider.list({ rows: [{ id: "D1", state: "available" }] });
  const devices = normalizeDeviceInventory(provider.type, raw ?? []);
  expect(deviceCapabilities(devices)).toEqual([
    "fixture.device",
    "fixture.device:D1",
  ]);
  const [device] = devices;
  if (!device) throw new Error("missing device");
  expect(validateDeviceSessionEnv(provider.sessionEnv(device, {}))).toEqual({
    CARDIGAN_DEVICE_SERIAL: "D1",
  });
});
