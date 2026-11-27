import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceObservation,
  normalizeDeviceInitResult,
  normalizeDeviceInventory,
} from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import {
  ANDROID_DEVICE_HOLDER_COMMAND,
  ANDROID_DEVICE_HOLDER_SCRIPT,
  ANDROID_DEVICE_INIT_COMMAND,
  ANDROID_DEVICE_INIT_SCRIPT,
  ANDROID_DEVICE_INIT_STEPS,
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

const fakeInitAdb = `#!/usr/bin/env python3
import os, socket, sys
args = sys.argv[1:]
log = os.environ['FAKE_ADB_LOG']
if args[:1] != ['-P'] or args[2:] != ['server', 'nodaemon']:
    open(log, 'a').write('client ' + ' '.join(args) + '\\n'); sys.exit(1)
state = os.environ.get('FAKE_STATE', 'device')
lock = os.environ.get('FAKE_LOCK', 'true')
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', int(args[1]))); srv.listen(8)
def read(c):
    n = int(c.recv(4), 16); return c.recv(n).decode()
while True:
    c, _ = srv.accept()
    req = read(c)
    if req == 'host:kill':
        c.sendall(b'OKAY'); c.close(); open(log, 'a').write('killed\\n'); sys.exit(0)
    if req == 'host:devices':
        data = ('WGC6R21609003324\\t' + state + '\\nOTHER\\tdevice\\n').encode() if state else b''
        c.sendall(b'OKAY' + b'%04x' % len(data) + data)
    elif req == 'host:transport:WGC6R21609003324':
        c.sendall(b'OKAY')
        cmd = read(c)
        open(log, 'a').write(cmd + '\\n')
        if cmd.startswith('shell:settings put global stay_on'):
            out = '7\\n'
        elif cmd.startswith('shell:settings put global window'):
            out = '0.0\\n0.0\\n0\\n'
        elif cmd.startswith('shell:locksettings'):
            out = ('' if lock == 'true' else 'Old password provided is invalid\\n') + lock + '\\n'
        elif cmd.startswith('shell:wm size'):
            out = 'Physical size: 1600x2560\\n12\\n'
        else:
            out = 'unexpected\\n'
        c.sendall(b'OKAY' + out.encode())
    else:
        c.sendall(b'FAIL')
    c.close()
`;

async function runInit(env: Record<string, string>) {
  const bin = await mkdtemp(join(tmpdir(), "cg-fake-adb-init-"));
  try {
    await writeFile(join(bin, "adb"), fakeInitAdb);
    await chmod(join(bin, "adb"), 0o755);
    const log = join(bin, "log");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "python3",
        [...ANDROID_DEVICE_INIT_COMMAND.slice(1), "WGC6R21609003324"],
        {
          env: {
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            FAKE_ADB_LOG: log,
            ANDROID_ADB_SERVER_PORT: "5137",
            ...env,
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
    return {
      result: JSON.parse(output) as unknown,
      log: (await readFile(log, "utf8")).trim().split("\n"),
    };
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
}

test("C-817: the real initialization changes only the three declared settings on the given device and stops its server", async () => {
  const ok = await runInit({});
  expect(
    normalizeDeviceInitResult(ok.result, ANDROID_DEVICE_INIT_STEPS),
  ).toEqual({ ok: true, resolution: "1600x2560", version: "12" });
  const commands = ok.log.filter((l) => l.startsWith("shell:"));
  expect(commands).toEqual([
    "shell:settings put global stay_on_while_plugged_in 7;settings get global stay_on_while_plugged_in",
    expect.stringMatching(
      /^shell:settings put global window_animation_scale 0;settings put global transition_animation_scale 0;settings put global animator_duration_scale 0;/u,
    ),
    "shell:locksettings set-disabled true;locksettings get-disabled",
    "shell:wm size;getprop ro.build.version.release",
  ]);
  // Never the other device, never an adb client, the server was stopped.
  expect(ok.log.at(-1)).toBe("killed");
  expect(ok.log.some((l) => l.startsWith("client"))).toBe(false);
  // A lock credential refuses the lock step: reported by key, nothing else runs.
  const locked = await runInit({ FAKE_LOCK: "false" });
  expect(
    normalizeDeviceInitResult(locked.result, ANDROID_DEVICE_INIT_STEPS),
  ).toEqual({
    ok: false,
    reason: expect.stringMatching(/^“关闭锁屏”没有成功：/u),
  });
  expect(locked.log.some((l) => l.startsWith("shell:wm size"))).toBe(false);
  expect(
    normalizeDeviceInitResult(
      (await runInit({ FAKE_STATE: "unauthorized" })).result,
      ANDROID_DEVICE_INIT_STEPS,
    ),
  ).toMatchObject({ ok: false, reason: expect.stringContaining("授权") });
  expect(
    normalizeDeviceInitResult(
      (await runInit({ FAKE_STATE: "" })).result,
      ANDROID_DEVICE_INIT_STEPS,
    ),
  ).toMatchObject({ ok: false, reason: expect.stringContaining("没有看到") });
}, 60_000);

test("C-817: the initialization script installs, removes, resets or reboots nothing, and the serial is argv, not code", async () => {
  expect(ANDROID_DEVICE_INIT_SCRIPT).not.toMatch(
    /\bpm (?:install|uninstall|clear)|\binstall\b|uninstall|wipe|reboot|recovery|factory|reset|push|pull|rm /u,
  );
  const probe = vi.fn<CapabilityProbe>(async () => ({
    ok: true,
    output: JSON.stringify({ result: "ok", resolution: "1x1" }),
  }));
  const execution = { mode: "local", dataDir: "/nonexistent" } as const;
  const initialize = androidDeviceProvider.initialize;
  if (!initialize) throw new Error("missing initialize");
  expect(await initialize({ execution, os: "linux", probe }, TABLET)).toEqual({
    result: "ok",
    resolution: "1x1",
  });
  expect(probe.mock.calls[0]?.[2]).toEqual([
    ...ANDROID_DEVICE_INIT_COMMAND,
    TABLET.id,
  ]);
  // A malformed id never reaches the worker.
  probe.mockClear();
  expect(
    await initialize(
      { execution, os: "linux", probe },
      { ...TABLET, id: "x;reboot" },
    ),
  ).toBeUndefined();
  expect(probe).not.toHaveBeenCalled();
  expect(androidDeviceProvider.init_steps?.map((s) => s.title)).toEqual([
    "插电常亮",
    "关闭动画",
    "关闭锁屏",
  ]);
});

const LISTING_SERVER = `import socket,sys
serials=sys.argv[1:]
ls=socket.socket(); ls.bind(('127.0.0.1',0)); ls.listen(8)
print(ls.getsockname()[1],flush=True)
while True:
 c,_=ls.accept()
 try:
  n=int(c.recv(4),16); svc=c.recv(n)
  if svc==b'host:devices':
   b=''.join('%s\\tdevice\\n'%s for s in serials).encode(); c.sendall(b'OKAY'+b'%04x'%len(b)+b)
 except (OSError,ValueError):
  pass
 c.close()
`;

test("C-833: the real holder script names the adb server port that lists the device, and only asks", async () => {
  const servers = [["emulator-5590"], ["OTHER", TABLET.id]].map((serials) =>
    spawn("python3", ["-I", "-c", LISTING_SERVER, ...serials], {
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  try {
    const ports = await Promise.all(
      servers.map(
        (s) =>
          new Promise<number>((resolve) =>
            s.stdout?.once("data", (d: Buffer) => resolve(Number(String(d)))),
          ),
      ),
    );
    const run = (serial: string, candidates: number[]) =>
      new Promise<unknown>((resolve, reject) => {
        const child = spawn(
          "python3",
          [
            ...ANDROID_DEVICE_HOLDER_COMMAND.slice(1),
            serial,
            JSON.stringify(candidates),
          ],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        let out = "";
        child.stdout.on("data", (b: Buffer) => {
          out += b.toString();
        });
        child.once("error", reject);
        child.once("close", () => resolve(JSON.parse(out)));
      });
    // A closed port in between is skipped.
    expect(await run(TABLET.id, [1, ...ports])).toEqual({ port: ports[1] });
    expect(await run("MISSING", ports)).toEqual({ port: null });
    expect(ANDROID_DEVICE_HOLDER_SCRIPT).not.toMatch(
      /kill|start-server|subprocess|transport|shell:/,
    );
    // The provider passes the ports as argv and accepts only one of them.
    const probe = vi.fn<CapabilityProbe>(async () => ({
      ok: true,
      output: JSON.stringify({ port: 5137 }),
    }));
    const target = {
      execution: { mode: "local" as const, dataDir: "/" },
      os: "darwin",
      probe,
    };
    expect(
      await androidDeviceProvider.holder?.(target, TABLET, [15100, 5137]),
    ).toBe(5137);
    expect(probe.mock.calls[0]?.[2]).toEqual([
      ...ANDROID_DEVICE_HOLDER_COMMAND,
      TABLET.id,
      "[15100,5137]",
    ]);
    expect(
      await androidDeviceProvider.holder?.(target, TABLET, [15100]),
    ).toBeUndefined();
    expect(
      await androidDeviceProvider.holder?.(
        target,
        { ...TABLET, id: "bad id" },
        [5137],
      ),
    ).toBeUndefined();
  } finally {
    for (const s of servers) s.kill("SIGKILL");
  }
}, 20_000);
