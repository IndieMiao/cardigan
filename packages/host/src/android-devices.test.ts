import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine, Run } from "@cardigan/domain";
import {
  type AndroidDeviceObservation,
  beginMachineObservation,
  completeMachineObservation,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  assignment,
  fixture,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import type { AdbProbe } from "./adb-slot-probe.js";
import {
  ANDROID_DEVICE_PROBE_SCRIPT,
  androidDeviceCapabilityKeys,
  androidDeviceMatches,
  mergeHeldAndroidDevices,
  parseAndroidDevices,
  withAndroidDeviceResource,
} from "./android-devices.js";
import { MachineLeases } from "./resource-leases.js";
import type { ResourceProbe } from "./resource-probe.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";
import { assignmentResourceKeys } from "./run-resources.js";

const TABLET: AndroidDeviceObservation = {
  serial: "WGC6R21609003324",
  state: "authorized",
  model: "MRR-W39",
  android_version: "12",
};

describe("device listing", () => {
  test("keeps only strictly valid fields and maps adb states", () => {
    const output = JSON.stringify({
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
        { serial: "WEIRD", state: "bootloader" },
        { serial: "emulator-5554", state: "device" },
        { serial: "192.168.1.5:5555", state: "device" },
        {
          serial: "INJECT",
          state: "device",
          model: "x\n$(id)",
          android: "12; rm",
        },
        { serial: "WGC6R21609003324", state: "offline" },
        "junk",
      ],
    });
    expect(parseAndroidDevices(output)).toEqual([
      { serial: "INJECT", state: "authorized" },
      { serial: "NOPERM", state: "no_permission" },
      { serial: "OFF1", state: "offline" },
      { serial: "R58N", state: "unauthorized", model: "SM_G991B" },
      { serial: "WEIRD", state: "other" },
      TABLET,
    ]);
    expect(parseAndroidDevices("not json")).toBeUndefined();
    expect(parseAndroidDevices("{}")).toBeUndefined();
    const many = Array.from({ length: 40 }, (_, i) => ({
      serial: `S${i}`,
      state: "device",
    }));
    expect(parseAndroidDevices(JSON.stringify({ devices: many }))).toHaveLength(
      16,
    );
  });

  test("a device a Run holds stays listed as in use with what was known", () => {
    const previous = [TABLET];
    const held = new Set([TABLET.serial, "GONE"]);
    expect(mergeHeldAndroidDevices([], previous, held)).toEqual([
      { ...TABLET, state: "in_use" },
    ]);
    expect(
      mergeHeldAndroidDevices(
        [{ serial: TABLET.serial, state: "offline" }],
        previous,
        held,
      ),
    ).toEqual([{ ...TABLET, state: "in_use" }]);
    // Unplugged and not held: it disappears; unauthorized stays unauthorized.
    expect(
      mergeHeldAndroidDevices(
        [{ serial: "R58N", state: "unauthorized" }],
        previous,
        new Set(),
      ),
    ).toEqual([{ serial: "R58N", state: "unauthorized" }]);
  });

  test("capability keys narrow by serial or model", () => {
    expect(androidDeviceCapabilityKeys(TABLET)).toEqual([
      "android.device",
      "android.device.serial.wgc6r21609003324",
      "android.device.model.mrr-w39",
    ]);
    expect(androidDeviceMatches(TABLET, ["android.device"])).toBe(true);
    expect(
      androidDeviceMatches(TABLET, [
        "android.device",
        "android.device.model.mrr-w39",
        "godot",
      ]),
    ).toBe(true);
    expect(androidDeviceMatches(TABLET, ["android.device.serial.other"])).toBe(
      false,
    );
    expect(withAndroidDeviceResource(["android.device.model.mrr-w39"])).toEqual(
      ["android.device.model.mrr-w39", "android.device"],
    );
    expect(withAndroidDeviceResource(["android.emulator"])).toEqual([
      "android.emulator",
    ]);
  });
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
    expect(parseAndroidDevices(output)).toEqual([
      { serial: "R58N", state: "unauthorized" },
      TABLET,
    ]);
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

describe("scheduling", () => {
  const at = "2032-02-01T00:00:00.000Z";
  const later = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
  let dir: string, store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-device-"));
    store = Store.open({ dataDir: dir });
    for (const id of ["first", "second"]) store.createProject({ id });
    store.uow.run((tx) => {
      for (const id of ["first", "second"])
        tx.machines.put(id, {
          id: "local",
          label: "local",
          herdr_machine: "local",
          os: platform(),
          arch: arch(),
          tags: [],
          max_assignments: 4,
          status: "online",
          last_seen: at,
        } as unknown as Machine);
    });
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const slots = {
    resources: ["android.emulator", "android.device"],
    adb_port_base: 15100,
    emulator_port_base: 5600,
  };
  async function config(adb: unknown = slots, devices = 2) {
    await writeFile(
      join(dir, "run-capacity.yaml"),
      JSON.stringify({
        machines: {
          local: {
            limit: 8,
            resources: {
              "android.emulator": 2,
              "android.device": devices,
              godot: 2,
            },
            adb_slots: adb,
          },
        },
      }),
      { mode: 0o600 },
    );
    const loaded = await loadRunCapacityConfig({ configDir: dir });
    expect(loaded.errors).toEqual([]);
    return loaded;
  }
  function leases(cfg: Awaited<ReturnType<typeof config>>) {
    const adb = vi.fn<AdbProbe>(async (c) => ({
      target: "target-1",
      found: c.action === "check" ? 0 : 1,
      left: 0,
    }));
    const probe = Object.assign(
      vi.fn(async () => "target-1"),
      { adb },
    ) as unknown as ResourceProbe;
    return new MachineLeases(store, cfg, probe);
  }
  function observe(
    devices: readonly AndroidDeviceObservation[],
    project = "first",
    checked_at = at,
  ) {
    const actor = { kind: "system" as const, project_id: project };
    const id = `obs-${Math.random()}`;
    beginMachineObservation(store, actor, project, "local", id, checked_at);
    completeMachineObservation(
      store,
      actor,
      project,
      "local",
      id,
      {
        status: "passed",
        checked_at,
        blockers: [],
        launch_enabled: true,
        android_devices: devices,
      },
      [],
    );
  }
  function needs(n: number, capabilities: string[], project = "first") {
    const item = fixture().work_items[0];
    if (!item) throw new Error("missing item");
    const owner = assignment(n);
    store.uow.run((tx) => {
      tx.work_items.put(project, {
        ...item,
        id: owner.work_item_id,
        requirements: { capabilities },
      });
      tx.assignments.put(project, owner);
      tx.runs.put(project, { ...run(n), status: "queued" });
    });
    return { owner, run: { ...run(n), status: "queued" } as Run };
  }
  async function claim(l: MachineLeases, n: number, caps: string[], now = at) {
    const { owner, run: r } = needs(n, caps);
    const keys = store.uow.read((tx) =>
      assignmentResourceKeys(tx, "first", owner),
    );
    const inspected = await l.inspect("first", owner, keys);
    const blocked = l.blocked("first", "local", keys, now, inspected);
    if (blocked) return { blocked, owner, run: r, keys };
    const access = store.uow.run((tx) =>
      l.acquire(tx, "first", owner, r, keys, inspected, now),
    );
    const running = { ...r, status: "running" } as Run;
    store.uow.run((tx) => tx.runs.put("first", running));
    return { access, owner, run: running, keys };
  }

  test("emulator only, device only and both: separate quotas, one Run per device", async () => {
    const l = leases(await config());
    observe([TABLET, { serial: "R58N", state: "unauthorized" }]);
    const emulator = await claim(l, 1, ["android.emulator"]);
    const device = await claim(l, 2, ["android.device"]);
    expect(emulator.access?.adb).toEqual({
      generation: expect.any(String),
      slot: 0,
      adb_port: 15100,
      emulator_port: 5600,
      usb_off: true,
    });
    expect(device.access?.adb).toEqual({
      generation: expect.any(String),
      slot: 1,
      adb_port: 15101,
      device: TABLET.serial,
    });
    // The only authorized tablet is taken: the next device Run waits (the
    // unauthorized one is never handed out), emulators are unaffected.
    const waiting = await claim(l, 3, ["android.device"]);
    expect(waiting.blocked).toBe(
      "真机：没有空闲的已授权真机，等待释放或重新检查机器",
    );
    const both = await claim(l, 4, ["android.emulator", "android.device"]);
    expect(both.blocked).toContain("真机");
    const second = await claim(l, 5, ["android.emulator"]);
    expect(second.access?.adb).toMatchObject({ slot: 2, emulator_port: 5604 });
    // Launch reads the held device back.
    expect(l.adb.launchSlot("first", "local", device.run.id)).toEqual(
      device.access?.adb,
    );
    expect(l.adb.diagnostics("local")?.[1]).toMatchObject({
      device: TABLET.serial,
      state: "run",
    });
    expect(l.freshSession("first", device.owner)).toBe(true);
    // The device comes back only once the Run's adb server is closed.
    store.uow.run((tx) =>
      tx.runs.put("first", { ...device.run, status: "completed" } as Run),
    );
    await l.adb.reconcile("first", () => later(1000));
    expect(l.adb.launchSlot("first", "local", device.run.id)).toBeNull();
    const after = await claim(l, 6, ["android.device", "android.emulator"]);
    expect(after.access?.adb).toEqual({
      generation: expect.any(String),
      slot: 1,
      adb_port: 15101,
      emulator_port: 5602,
      device: TABLET.serial,
    });
    const released = store
      .getUpdates({ project_id: "first" })
      .events.filter((e) => e.type === "machine_adb_slot_released");
    expect(released[0]?.payload).toMatchObject({ device: TABLET.serial });
  });

  test("the database never lets two live slots hold one device", async () => {
    const l = leases(await config());
    observe([TABLET]);
    const a = await claim(l, 1, ["android.device"]);
    expect(a.access?.adb?.device).toBe(TABLET.serial);
    expect(() =>
      store.database
        .prepare(
          "INSERT INTO machine_adb_slots (generation,machine,slot,adb_port,project,assignment_id,run_id,purpose,device,acquired_at) VALUES ('x','local',3,15103,'second','A-9','R-9','run',?,?)",
        )
        .run(TABLET.serial, at),
    ).toThrow();
  });

  test("devices are per project account, narrowed by model or serial, and need a current check", async () => {
    const l = leases(await config());
    // Seen (authorized) only from the second project's account.
    observe([TABLET], "second");
    expect((await claim(l, 1, ["android.device"])).blocked).toContain("真机");
    observe([
      TABLET,
      { serial: "OTHER1", state: "authorized", model: "Pixel 8" },
    ]);
    const pixel = await claim(l, 2, ["android.device.model.pixel-8"]);
    expect(pixel.keys).toEqual([
      "android.device.model.pixel-8",
      "android.device",
    ]);
    expect(pixel.access?.adb?.device).toBe("OTHER1");
    expect(
      (await claim(l, 3, ["android.device.serial.other1"])).blocked,
    ).toContain("真机");
    const bySerial = await claim(l, 4, [
      "android.device.serial.wgc6r21609003324",
    ]);
    expect(bySerial.access?.adb?.device).toBe(TABLET.serial);
    // A machine check older than the observation TTL proves nothing.
    expect(
      (await claim(l, 5, ["android.device"], later(25 * 3600_000))).blocked,
    ).toContain("真机");
  });

  test("a machine whose adb slots do not include android.device never hands one out", async () => {
    const l = leases(
      await config({ ...slots, resources: ["android.emulator"] }),
    );
    observe([TABLET]);
    expect((await claim(l, 1, ["android.device"])).blocked).toBe(
      "真机：本机 adb_slots 未包含 android.device",
    );
    // Emulator-only Runs here keep exactly their previous slot (no USB flag).
    expect((await claim(l, 2, ["android.emulator"])).access?.adb).toEqual({
      generation: expect.any(String),
      slot: 0,
      adb_port: 15100,
      emulator_port: 5600,
    });
  });
});
