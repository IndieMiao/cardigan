import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceObservation,
  normalizeDeviceInventory,
} from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import {
  ANDROID_DEVICE_PROBE_COMMAND,
  ANDROID_DEVICE_PROBE_SCRIPT,
  androidDeviceProvider,
  parseAndroidDevices,
  ANDROID_DEVICE_TYPE as TYPE,
} from "./android-device-provider.js";
import type { CapabilityProbe } from "./machine-capability-probe.js";

const TABLET: DeviceObservation = {
  type: TYPE,
  id: "WGC6R21609003324",
  state: "available",
  model: "MRR-W39",
  version: "12",
};

test("adb rows map to the generic shape; emulator and wireless serials are not USB devices", () => {
  const raw = parseAndroidDevices(
    JSON.stringify({
      devices: [
        {
          serial: "WGC6R21609003324",
          state: "device",
          model: "MRR-W39",
          android: "12",
        },
        { serial: "R58N", state: "unauthorized", model: "SM_G991B" },
        { serial: "OFF1", state: "offline" },
        { serial: "NOPERM", state: "no" },
        { serial: "emulator-5554", state: "device" },
        { serial: "192.168.1.5:5555", state: "device" },
        "junk",
      ],
    }),
  );
  expect(normalizeDeviceInventory(TYPE, raw ?? [])).toEqual([
    { type: TYPE, id: "NOPERM", state: "unavailable" },
    { type: TYPE, id: "OFF1", state: "offline" },
    { type: TYPE, id: "R58N", state: "unauthorized", model: "SM_G991B" },
    TABLET,
  ]);
  expect(parseAndroidDevices("not json")).toBeUndefined();
  expect(parseAndroidDevices("{}")).toBeUndefined();
});

test("the provider lists through the host probe, needs adb and an adb slot, and names the device for the session", async () => {
  expect(androidDeviceProvider).toMatchObject({
    type: "android.device",
    requires_capability: "android.sdk",
    needs_adb_slot: true,
  });
  expect(androidDeviceProvider.setup_steps.length).toBeGreaterThan(0);
  const probe = vi.fn<CapabilityProbe>(async () => ({
    ok: true,
    output: JSON.stringify({ devices: [{ serial: "S1", state: "device" }] }),
  }));
  const execution = { mode: "local", dataDir: "/nonexistent" } as const;
  expect(
    await androidDeviceProvider.list({ execution, os: "linux", probe }),
  ).toEqual([{ id: "S1", state: "available" }]);
  expect(probe.mock.calls[0]?.[2]).toBe(ANDROID_DEVICE_PROBE_COMMAND);
  probe.mockResolvedValueOnce({ ok: false, output: "" });
  expect(
    await androidDeviceProvider.list({ execution, os: "linux", probe }),
  ).toBeUndefined();
  // Device only: ANDROID_SERIAL is the device.
  expect(androidDeviceProvider.sessionEnv(TABLET, {})).toEqual({
    ANDROID_SERIAL: TABLET.id,
    CARDIGAN_DEVICE_SERIAL: TABLET.id,
  });
  // With an emulator: ANDROID_SERIAL stays on the emulator, both are given.
  expect(
    androidDeviceProvider.sessionEnv(TABLET, {
      emulator_serial: "emulator-5600",
    }),
  ).toEqual({
    CARDIGAN_DEVICE_SERIAL: TABLET.id,
    CARDIGAN_EMULATOR_SERIAL: "emulator-5600",
  });
  expect(androidDeviceProvider.sessionRule(TABLET, {})).toContain(
    "adb --one-device $CARDIGAN_DEVICE_SERIAL start-server",
  );
  expect(
    androidDeviceProvider.sessionRule(TABLET, { emulator_serial: "e" }),
  ).toContain("adb -s $CARDIGAN_DEVICE_SERIAL");
});

const fakeAdb = `#!/usr/bin/env python3
import json, os, socket, sys
args = sys.argv[1:]
log = os.environ['FAKE_ADB_LOG']
if args[:1] != ['-P'] or args[2:] != ['server', 'nodaemon']:
    open(log, 'a').write('client ' + ' '.join(args) + '\\n'); sys.exit(1)
open(log, 'a').write(json.dumps({k: os.environ.get(k) for k in ('ADB_EMU', 'ADB_MDNS', 'ANDROID_ADB_SERVER_PORT', 'ANDROID_SERIAL')}) + '\\n')
listing = 'WGC6R21609003324 device usb:1-1 product:MRR model:MRR_W39 device:HWMRR transport_id:1\\nR58N unauthorized usb:1-2 transport_id:2\\nemulator-5554 device product:sdk transport_id:3\\n'
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', int(args[1]))); srv.listen(8)
def read(c):
    n = int(c.recv(4), 16); return c.recv(n).decode()
while True:
    c, _ = srv.accept()
    req = read(c)
    if req == 'host:kill':
        c.sendall(b'OKAY'); c.close(); open(log, 'a').write('killed\\n'); sys.exit(0)
    if req == 'host:devices-l':
        data = listing.encode(); c.sendall(b'OKAY' + b'%04x' % len(data) + data)
    elif req.startswith('host:transport:WGC6'):
        c.sendall(b'OKAY')
        if read(c).startswith('shell:getprop ro.product.model'):
            c.sendall(b'OKAY' + b'MRR-W39\\r\\n12\\r\\n')
    else:
        c.sendall(b'FAIL')
    c.close()
`;

test("the real listing script uses a throw-away adb server and stops it", async () => {
  const bin = await mkdtemp(join(tmpdir(), "cg-fake-adb-"));
  try {
    await writeFile(join(bin, "adb"), fakeAdb);
    await chmod(join(bin, "adb"), 0o755);
    const log = join(bin, "log");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "python3",
        ["-I", "-B", "-c", ANDROID_DEVICE_PROBE_SCRIPT],
        {
          env: {
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            FAKE_ADB_LOG: log,
            ANDROID_ADB_SERVER_PORT: "5137",
            ANDROID_SERIAL: "emulator-5590",
          },
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      let out = "";
      child.stdout.on("data", (b: Buffer) => {
        out += b.toString();
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)),
      );
    });
    expect(
      normalizeDeviceInventory(TYPE, parseAndroidDevices(output) ?? []),
    ).toEqual([{ type: TYPE, id: "R58N", state: "unauthorized" }, TABLET]);
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    // Only the server was started (no adb client that could spawn a daemon),
    // without the pinned port or serial, discovery off, and it was stopped.
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      ADB_EMU: "0",
      ADB_MDNS: "0",
      ANDROID_ADB_SERVER_PORT: null,
      ANDROID_SERIAL: null,
    });
    expect(lines.slice(1)).toEqual(["killed"]);
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
}, 20_000);
