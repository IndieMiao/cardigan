import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine, Run } from "@cardigan/domain";
import { beginLaunchAttempt, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  assignment,
  fixture,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import { adbServerHolders, sessionLabel } from "./adb-sessions.js";
import {
  type AdbProbe,
  type AdbProbeContext,
  adbTargetProbe,
} from "./adb-slot-probe.js";
import { adbEnvironmentWarnings } from "./adb-slots.js";
import { launchDevices } from "./launch.js";
import { MachineLeases } from "./resource-leases.js";
import { type ResourceProbe, targetProbe } from "./resource-probe.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";

const at = "2032-02-01T00:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
let dir: string, store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-adb-"));
  store = Store.open({ dataDir: dir });
  for (const id of ["first", "second"]) store.createProject({ id });
  store.uow.run((tx) => {
    for (const id of ["first", "second"])
      tx.machines.put(id, {
        id: "local",
        label: "local",
        herdr_machine: "local",
        // createProject registers this host as "local"; match its identity.
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
  resources: ["android.emulator", "godot"],
  adb_port_base: 15100,
  emulator_port_base: 5600,
};
async function config(adb: unknown = slots, extra: object = {}) {
  await writeFile(
    join(dir, "run-capacity.yaml"),
    JSON.stringify({
      machines: {
        local: {
          limit: 6,
          resources: { "android.emulator": 2, godot: 2, other: 1 },
          adb_slots: adb,
          ...extra,
        },
      },
    }),
    { mode: 0o600 },
  );
  return loadRunCapacityConfig({ configDir: dir });
}

type Reply = { found: number; left: number } | undefined;
function fakeProbe(
  reply: (c: AdbProbeContext) => Reply = (c) =>
    c.action === "check" ? { found: 0, left: 0 } : { found: 1, left: 0 },
) {
  const adb = vi.fn<AdbProbe>(async (c) => {
    const r = reply(c);
    return r && { target: "target-1", ...r };
  });
  const probe = Object.assign(
    vi.fn(async () => "target-1"),
    { adb },
  ) as unknown as ResourceProbe;
  return { probe, adb };
}

/** Assignment n needs these capabilities; Run n belongs to it. */
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
async function claim(l: MachineLeases, n: number, caps: string[]) {
  const { owner, run: r } = needs(n, caps);
  const inspected = await l.inspect("first", owner);
  const keys = caps;
  const blocked = l.blocked("first", "local", keys, at, inspected);
  if (blocked) return { blocked, owner, run: r };
  const access = store.uow.run((tx) =>
    l.acquire(tx, "first", owner, r, keys, inspected, at),
  );
  // Dispatched: the Run is executing now.
  const running = { ...r, status: "running" } as Run;
  setStatus(running, {});
  return { access, owner, run: running };
}
function setStatus(r: Run, patch: Partial<Run>) {
  return store.uow.run((tx) => tx.runs.put("first", { ...r, ...patch } as Run));
}
const events = (type: string, project = "first") =>
  store
    .getUpdates({ project_id: project })
    .events.filter((e) => e.type === type);

test("config: defaults, ranges and overlaps are validated without echoing values", async () => {
  const cfg = await config();
  expect(cfg.errors).toEqual([]);
  expect(cfg.adbSlots("local")).toMatchObject({
    count: 4,
    adbPortBase: 15100,
    emulatorPortBase: 5600,
    sweepMs: 600_000,
  });
  for (const bad of [
    { ...slots, resources: ["missing"] },
    { ...slots, emulator_port_base: undefined },
    { ...slots, emulator_port_base: 5601 },
    // Inside the range every adb server scans for emulators on its own.
    { ...slots, emulator_port_base: 5560 },
    { ...slots, adb_port_base: 5035 },
    { ...slots, adb_port_base: 5600 },
    { ...slots, legacy_adb_ports: [15101] },
    { ...slots, count: 0 },
    { ...slots, surprise: true },
  ]) {
    const c = await config(bad);
    expect(c.errors).toHaveLength(1);
    expect(c.forMachine("local")).toBe(0);
    expect(c.errors.join()).not.toContain("15100");
  }
  const bound = await config(slots, {
    resource_policies: {
      other: { bindings: { first: { adb_port: 17000, release: ["/x"] } } },
    },
  });
  expect(bound.errors).toHaveLength(1);
});

test("concurrent emulator Runs get different adb and emulator ports; a godot-only Run gets its own adb port and no emulator", async () => {
  const { probe } = fakeProbe();
  const l = new MachineLeases(store, await config(), probe);
  const a = await claim(l, 1, ["android.emulator"]);
  const b = await claim(l, 2, ["android.emulator", "godot"]);
  const c = await claim(l, 3, ["godot"]);
  const d = await claim(l, 4, ["other"]);
  expect(a.access?.adb).toMatchObject({
    slot: 0,
    adb_port: 15100,
    emulator_port: 5600,
  });
  expect(b.access?.adb).toMatchObject({
    slot: 1,
    adb_port: 15101,
    emulator_port: 5602,
  });
  expect(c.access?.adb).toEqual({
    generation: expect.any(String),
    slot: 2,
    adb_port: 15102,
  });
  expect(d.access?.adb).toBeUndefined();
  // Launch reads the held slot back; a Run without one has adb disabled.
  expect(l.adb.launchSlot("first", "local", b.run.id)).toEqual(b.access?.adb);
  expect(l.adb.launchSlot("first", "local", d.run.id)).toBeNull();
  // Fresh sessions for Runs with slots, so no Run inherits an old port.
  expect(l.freshSession("first", a.owner)).toBe(true);
  expect(l.freshSession("first", d.owner)).toBe(false);
  // Claiming the same Run again keeps its slot.
  const again = store.uow.run((tx) =>
    l.adb.acquire(tx, "first", a.owner, a.run, ["android.emulator"], "t", at),
  );
  expect(again).toEqual(a.access?.adb);
  const e = await claim(l, 5, ["godot"]);
  expect(e.access?.adb?.slot).toBe(3);
  // Pool exhausted: the next one waits instead of sharing a port.
  const f = await claim(l, 6, ["godot"]);
  expect(f.blocked).toContain("adb");
  expect(
    store.database
      .prepare(
        "SELECT COUNT(DISTINCT adb_port) AS n FROM machine_adb_slots WHERE released_at IS NULL",
      )
      .get(),
  ).toEqual({ n: 4 });
  expect(JSON.stringify(events("machine_adb_slot_acquired"))).not.toContain(
    "15100",
  );
});

test.each([
  ["completed", {}],
  ["failed", {}],
  ["cancelled", {}],
  ["queued", {}],
] as const)(
  "a Run that ended as %s gets its adb server and emulator closed and its slot freed",
  async (status, patch) => {
    const { probe, adb } = fakeProbe();
    const l = new MachineLeases(store, await config(), probe);
    const a = await claim(l, 1, ["android.emulator"]);
    const b = await claim(l, 2, ["android.emulator"]);
    // Running Runs keep their slots.
    await l.adb.reconcile("first", () => at);
    expect(adb.mock.calls.filter(([c]) => c.action === "release")).toEqual([]);
    setStatus(a.run, { status, ...patch });
    await l.adb.reconcile("first", () => later(1000));
    const releases = adb.mock.calls.filter(([c]) => c.action === "release");
    expect(releases).toHaveLength(1);
    expect(releases[0]?.[0]).toMatchObject({
      adb_ports: [15100],
      emulator_ports: [5600],
      generation: a.access?.adb?.generation,
    });
    expect(releases[0]?.[1]).toBe("target-1");
    expect(l.adb.launchSlot("first", "local", a.run.id)).toBeNull();
    expect(l.adb.launchSlot("first", "local", b.run.id)).toEqual(b.access?.adb);
    expect(events("machine_adb_slot_released")).toHaveLength(1);
    const c = await claim(l, 3, ["android.emulator"]);
    expect(c.access?.adb?.slot).toBe(0);
  },
);

test("a session or stop not yet confirmed, or a pending launch, keeps the slot", async () => {
  const { probe, adb } = fakeProbe();
  const l = new MachineLeases(store, await config(), probe);
  const a = await claim(l, 1, ["godot"]);
  setStatus(a.run, {
    status: "cancelled",
    dispatch_stop: { requested_at: at } as never,
  });
  await l.adb.reconcile("first", () => later(1000));
  setStatus(a.run, { status: "queued" });
  store.uow.run(() =>
    beginLaunchAttempt(store.database, {
      id: "attempt-1",
      project_id: "first",
      assignment_id: a.owner.id,
      run_id: a.run.id,
      notification_ids: [],
      started_at: at,
      lease_until: later(60_000),
    }),
  );
  await l.adb.reconcile("first", () => later(2000));
  expect(adb.mock.calls.filter(([c]) => c.action === "release")).toEqual([]);
  expect(l.adb.launchSlot("first", "local", a.run.id)).not.toBeNull();
});

test("an unconfirmed release keeps the slot and retries with backoff", async () => {
  let reply: Reply;
  const { probe, adb } = fakeProbe((c) =>
    c.action === "check" ? { found: 0, left: 0 } : reply,
  );
  const l = new MachineLeases(store, await config(), probe);
  const a = await claim(l, 1, ["godot"]);
  setStatus(a.run, { status: "completed" });
  reply = undefined;
  await l.adb.reconcile("first", () => later(0));
  reply = { found: 1, left: 1 };
  await l.adb.reconcile("first", () => later(10_000)); // inside the backoff
  const releases = () =>
    adb.mock.calls.filter(([c]) => c.action === "release").length;
  expect(releases()).toBe(1);
  await l.adb.reconcile("first", () => later(31_000));
  expect(releases()).toBe(2);
  expect(l.adb.diagnostics("local")?.[0]).toMatchObject({
    state: "release_pending",
    run_id: a.run.id,
  });
  expect(events("machine_adb_slot_release_pending")).toHaveLength(2);
  reply = { found: 1, left: 0 };
  await l.adb.reconcile("first", () => later(10 * 60_000));
  expect(l.adb.diagnostics("local")?.[0]?.state).toBe("free");
});

test("periodic sweep closes orphans on free slots and legacy fixed ports, never a live Run's", async () => {
  const listening = new Set([15101, 5137]);
  const { probe, adb } = fakeProbe((c) => {
    const ports = [...c.adb_ports, ...c.emulator_ports];
    const found = ports.filter((p) => listening.has(p)).length;
    if (c.action === "release") for (const p of ports) listening.delete(p);
    return { found, left: 0 };
  });
  const l = new MachineLeases(
    store,
    await config({ ...slots, legacy_adb_ports: [5137], sweep_minutes: 5 }),
    probe,
  );
  const live = await claim(l, 1, ["godot"]);
  // A Run from before slots existed may still use the fixed port.
  needs(2, ["godot"]);
  setStatus({ ...run(2), status: "queued" } as Run, { status: "running" });
  await l.adb.reconcile("first", () => at);
  expect(listening).toEqual(new Set([5137]));
  const swept = adb.mock.calls.map(([c]) => c.adb_ports[0]);
  expect(swept).not.toContain(15100);
  expect(events("machine_adb_orphan_closed")).toHaveLength(1);
  expect(events("machine_adb_orphan_closed")[0]?.payload).toMatchObject({
    slot: 1,
  });
  // Every slot is free again except the live Run's.
  expect(l.adb.diagnostics("local")?.map((d) => d.state)).toEqual([
    "run",
    "free",
    "free",
    "free",
  ]);
  setStatus({ ...run(2) } as Run, { status: "completed" });
  // Not due yet.
  await l.adb.reconcile("first", () => later(60_000));
  expect(listening.has(5137)).toBe(true);
  await l.adb.reconcile("first", () => later(5 * 60_000));
  expect(listening.has(5137)).toBe(false);
  expect(events("machine_adb_orphan_closed").at(-1)?.payload).toMatchObject({
    legacy: true,
    closed: 1,
  });
  expect(l.adb.launchSlot("first", "local", live.run.id)).not.toBeNull();
});

test("the dispatch reconcile runs adb cleanup in the background, one pass per project", async () => {
  let finish: (() => void) | undefined;
  const { probe, adb } = fakeProbe();
  const l = new MachineLeases(store, await config(), probe);
  const a = await claim(l, 1, ["godot"]);
  setStatus(a.run, { status: "completed" });
  adb.mockImplementation(
    (c) =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            target: "target-1",
            found: c.action === "release" ? 1 : 0,
            left: 0,
          });
      }),
  );
  await l.reconcile("first", () => later(1000));
  await l.reconcile("first", () => later(2000));
  expect(adb).toHaveBeenCalledTimes(1);
  adb.mockImplementation(async (c) => ({
    target: "target-1",
    found: c.action === "release" ? 1 : 0,
    left: 0,
  }));
  finish?.();
  await l.adb.idle();
  expect(l.adb.launchSlot("first", "local", a.run.id)).toBeNull();
});

test("a pinned ANDROID_ADB_SERVER_PORT on a slot machine is reported, without its value", async () => {
  const cfg = await config();
  const worker = (machine_id: string) => ({
    machine_id,
    project_id: "sensen",
    execution: { env: { ANDROID_ADB_SERVER_PORT: "5137" } },
  });
  const warnings = adbEnvironmentWarnings(
    [worker("local"), worker("elsewhere")],
    cfg,
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("ANDROID_ADB_SERVER_PORT");
  expect(warnings[0]).not.toContain("5137");
});

// ---- The real cleanup script against loopback stand-ins -----------------

// Port 0 lets each stand-in bind its own port, so no other test can take it
// between choosing and binding. Like a real emulator, the console stand-in
// also listens on its adb port (console + 1), which the script inspects too.
const STANDIN = `import socket,sys,threading
kind,port=sys.argv[1],int(sys.argv[2])
def bound(p):
 s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',p)); s.listen(8); return s
def drain(s):
 while True: s.accept()[0].close()
ls=bound(port)
if kind=='console': threading.Thread(target=drain,args=(bound(ls.getsockname()[1]+1),),daemon=True).start()
print('ready',ls.getsockname()[1],flush=True)
while True:
 c,_=ls.accept(); c.settimeout(2)
 try:
  if kind=='adb':
   d=c.recv(64)
   if d==b'0009host:kill':
    c.sendall(b'OKAY'); c.close(); ls.close(); sys.exit(0)
  else:
   c.sendall(b'Android Console: Authentication required\\r\\nOK\\r\\n')
   d=b''
   while b'\\n' not in d:
    x=c.recv(64)
    if not x: break
    d+=x
   if d.startswith(b'auth'):
    c.sendall(b'OK\\r\\n'); d=c.recv(64)
   if d.startswith(b'kill'):
    c.sendall(b'OK: killing emulator, bye bye\\r\\n'); c.close(); ls.close(); sys.exit(0)
 except OSError:
  pass
 c.close()
`;
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
});
async function standIn(kind: "adb" | "console") {
  const child = spawn("/usr/bin/python3", ["-I", "-c", STANDIN, kind, "0"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return new Promise<number>((resolve, reject) => {
    child.stdout?.once("data", (data: Buffer) =>
      resolve(Number(String(data).split(" ")[1])),
    );
    child.once("exit", () => reject(new Error("stand-in exited")));
  });
}
async function emulatorStandIn(): Promise<number> {
  // Retry when the port after an ephemeral console port is already taken.
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await standIn("console").catch(() => undefined);
    if (port) return port;
  }
  throw new Error("no free emulator port pair");
}
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = new Socket();
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    s.connect(port, "127.0.0.1");
  });

test("the real script closes only this slot's adb server and emulator; the other Run's server keeps running", async () => {
  const probe = targetProbe(() => ({ mode: "local", dataDir: dir }));
  expect(probe.adb).toBeDefined();
  const adb = probe.adb as AdbProbe;
  const mine = await standIn("adb"),
    theirs = await standIn("adb"),
    emulator = await emulatorStandIn();
  const context = {
    project: "first",
    machine: "local",
    generation: "generation-1",
    adb_ports: [mine],
    emulator_ports: [emulator],
  };
  // A check only looks; nothing is closed.
  expect(await adb({ ...context, action: "check" })).toEqual({
    target: "local",
    found: 3,
    left: 3,
  });
  expect(await adb({ ...context, action: "release" }, "local")).toEqual({
    target: "local",
    found: 3,
    left: 0,
  });
  expect(await listening(mine)).toBe(false);
  expect(await listening(emulator)).toBe(false);
  expect(await listening(emulator + 1)).toBe(false);
  expect(await listening(theirs)).toBe(true);
  // Nothing left: a second release is a clean no-op.
  expect(await adb({ ...context, action: "release" }, "local")).toMatchObject({
    found: 0,
    left: 0,
  });
  // A wrong target or a reply for another generation is never a proof.
  expect(
    await adb({ ...context, action: "release" }, "remote"),
  ).toBeUndefined();
  const echo = adbTargetProbe(
    async () => ({ config: { mode: "local", dataDir: dir }, target: "local" }),
    async () => JSON.stringify({ generation: "old", found: 0, left: 0 }),
  );
  expect(await echo({ ...context, action: "release" })).toBeUndefined();
}, 20_000);

// ---- C-833: legacy servers holding USB devices --------------------------

const deviceSlots = {
  resources: ["android.emulator", "godot", "android.device"],
  adb_port_base: 15100,
  emulator_port_base: 5600,
  legacy_adb_ports: [5137],
};
const deviceResources = {
  resources: { "android.emulator": 2, godot: 2, other: 1, "android.device": 1 },
};
type UsbReply = Awaited<ReturnType<AdbProbe>>;
function usbProbe(usbOff: () => UsbReply | undefined) {
  const adb = vi.fn<AdbProbe>(async (c) =>
    c.action === "usb_off"
      ? usbOff()
      : { target: "target-1", found: 0, left: 0 },
  );
  const probe = Object.assign(
    vi.fn(async () => "target-1"),
    { adb },
  ) as unknown as ResourceProbe;
  return { probe, adb };
}
const restarted = {
  target: "target-1",
  found: 1,
  left: 0,
  foreign: 0,
  reconnected: 1,
  missing: 0,
};

test("C-833: while a session from before the switch may use the legacy port, its USB-holding server is restarted with ADB_USB=0, not closed", async () => {
  const { probe, adb } = usbProbe(() => restarted);
  const l = new MachineLeases(
    store,
    await config(deviceSlots, deviceResources),
    probe,
  );
  needs(2, ["godot"]);
  setStatus({ ...run(2), status: "queued" } as Run, { status: "running" });
  await l.adb.reconcile("first", () => at);
  const calls = adb.mock.calls.map(([c]) => c);
  expect(calls.filter((c) => c.action === "usb_off")).toEqual([
    expect.objectContaining({
      adb_ports: [5137],
      emulator_ports: [],
      generation: expect.any(String),
    }),
  ]);
  // The legacy port is not closed while the old Run may still use it.
  expect(
    calls.filter((c) => c.action === "release" && c.adb_ports.includes(5137)),
  ).toEqual([]);
  const released = events("machine_adb_legacy_usb_released");
  expect(released).toHaveLength(1);
  expect(released[0]?.payload).toEqual({
    machine: "local",
    legacy: true,
    restarted: 1,
    failed: 0,
    reconnected: 1,
    missing: 0,
  });
  expect(JSON.stringify(released)).not.toContain("5137");
});

test("C-833: no USB restart without android.device in the slots, and an unanswered restart is retried before the sweep interval", async () => {
  let reply: UsbReply | undefined;
  const { probe, adb } = usbProbe(() => reply);
  const plain = new MachineLeases(
    store,
    await config({ ...slots, legacy_adb_ports: [5137] }),
    probe,
  );
  needs(2, ["godot"]);
  setStatus({ ...run(2), status: "queued" } as Run, { status: "running" });
  await plain.adb.reconcile("first", () => at);
  expect(adb.mock.calls.some(([c]) => c.action === "usb_off")).toBe(false);
  const l = new MachineLeases(
    store,
    await config(deviceSlots, deviceResources),
    probe,
  );
  await l.adb.reconcile("first", () => at);
  reply = { ...restarted, found: 0, reconnected: 0 };
  await l.adb.reconcile("first", () => later(1000));
  const usbOff = () =>
    adb.mock.calls.filter(([c]) => c.action === "usb_off").length;
  expect(usbOff()).toBe(2);
  // Answered (nothing held USB): next only after the sweep interval.
  await l.adb.reconcile("first", () => later(2000));
  expect(usbOff()).toBe(2);
  expect(events("machine_adb_legacy_usb_released")).toEqual([]);
});

test("C-833: a launch records the machine's adb environment; sessions from before a switch are fresh-session candidates", async () => {
  const { probe } = fakeProbe();
  const before = new MachineLeases(store, await config(), probe);
  const { owner } = needs(1, ["other"]);
  const launched = { ...run(1), status: "running", started_at: at } as Run;
  setStatus(launched, {});
  const live = {
    ...owner,
    runtime_ref: {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: "t1",
      agent_name: "coder",
      launch_generation: { run_id: launched.id, generation: "g1" },
    },
  } as typeof owner;
  // Launched with slots: the same environment keeps the session.
  launchDevices(before, "first", "local", launched.id, at);
  expect(before.sessions.stale("first", live)).toBe(false);
  expect(before.freshSession("first", live)).toBe(false);
  // The machine now also hands out USB devices: replace at the next wake.
  const after = new MachineLeases(
    store,
    await config(deviceSlots, deviceResources),
    probe,
  );
  expect(after.sessions.stale("first", live)).toBe(true);
  expect(after.freshSession("first", live)).toBe(true);
  // No session, an external one, or an unmanaged machine: nothing to replace.
  expect(after.sessions.stale("first", owner)).toBe(false);
  expect(after.sessions.stale("first", { ...live, external: true })).toBe(
    false,
  );
  const none = new MachineLeases(
    store,
    await config(undefined, { adb_slots: undefined }),
    probe,
  );
  expect(none.sessions.stale("first", live)).toBe(false);
  // The replacement's launch records the new environment.
  launchDevices(after, "first", "local", launched.id, later(1000));
  expect(after.sessions.stale("first", live)).toBe(false);
  // A session without a launch generation cannot show its environment.
  const { launch_generation: _, ...legacyRef } = live.runtime_ref ?? {};
  expect(
    after.sessions.stale("first", {
      ...live,
      runtime_ref: legacyRef,
    } as typeof owner),
  ).toBe(true);
});

test("C-833: sessions launched before the record existed are judged from the slots and leases the machine had then", async () => {
  const { probe } = fakeProbe();
  const l = new MachineLeases(store, await config(), probe);
  const session = (n: number, started: string) => {
    const { owner } = needs(n, ["other"]);
    const r = { ...run(n), status: "completed", started_at: started } as Run;
    setStatus(r, {});
    return {
      ...owner,
      runtime_ref: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: `t${n}`,
        agent_name: "coder",
        launch_generation: { run_id: r.id, generation: `g${n}` },
      },
    } as typeof owner;
  };
  const old = session(1, at);
  await claim(l, 2, ["godot"]); // the first slot row, acquired at `at`
  const newer = session(3, later(1000));
  expect(l.sessions.stale("first", old)).toBe(false); // same instant counts
  expect(l.sessions.stale("first", newer)).toBe(false);
  const devices = new MachineLeases(
    store,
    await config(deviceSlots, deviceResources),
    probe,
  );
  // No device was ever handed out on this machine before: launched before.
  expect(devices.sessions.stale("first", newer)).toBe(true);
  const ancient = session(4, later(-1000));
  expect(l.sessions.stale("first", ancient)).toBe(true);
  store.uow.run((tx) => {
    for (const a of [old, newer, ancient]) tx.assignments.put("first", a);
  });
  expect(l.sessions.staleSessions("local")).toEqual([
    { project: "first", assignment_id: ancient.id },
  ]);
  expect(
    devices.sessions.staleSessions("local").map((s) => s.assignment_id),
  ).toEqual([old.id, newer.id, ancient.id].sort());
});

// A stand-in adb server speaking the host protocol: it lists a USB device
// only when started without ADB_USB=0, takes emulators registered with
// `host:emulator:<adb port>` and network devices with `host:connect:`.
const ADB_SERVER_STANDIN = `import json,os,socket,sys
port,usb,devices,log=int(sys.argv[1]),sys.argv[2]=='1',json.loads(sys.argv[3]),sys.argv[4]
ls=socket.socket(); ls.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); ls.bind(('127.0.0.1',port)); ls.listen(8)
with open(log,'a') as f: f.write(json.dumps(dict(pid=os.getpid(),usb=usb))+'\\n')
print('ready',ls.getsockname()[1],flush=True)
def reply(c,t):
 b=t.encode(); c.sendall(b'OKAY'+b'%04x'%len(b)+b)
while True:
 c,_=ls.accept(); c.settimeout(2)
 try:
  n=int(c.recv(4),16); svc=b''
  while len(svc)<n: svc+=c.recv(n-len(svc))
  svc=svc.decode()
  if svc=='host:kill':
   c.sendall(b'OKAY'); c.close(); ls.close(); sys.exit(0)
  if svc=='host:devices': reply(c,''.join('%s\\tdevice\\n'%d for d in (['USB123'] if usb else [])+devices))
  elif svc.startswith('host:emulator:'): devices.append('emulator-%d'%(int(svc[14:])-1))
  elif svc.startswith('host:connect:'):
   devices.append(svc[13:]); reply(c,'connected')
 except (OSError,ValueError):
  pass
 c.close()
`;
// `adb -P <port> start-server`: start the stand-in as a daemon, honouring ADB_USB.
const FAKE_ADB = `#!/usr/bin/python3
import os,subprocess,sys
a=sys.argv[1:]
if a[:1]!=['-P'] or a[2:]!=['start-server']: sys.exit(1)
d=os.path.dirname(os.path.abspath(__file__))
p=subprocess.Popen(['/usr/bin/python3','-I',os.path.join(d,'standin.py'),a[1],'0' if os.environ.get('ADB_USB')=='0' else '1','[]',os.path.join(d,'log')],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
p.stdout.readline()
`;

test("C-833: the real script restarts this account's USB-holding legacy server with ADB_USB=0 and re-registers its emulator and network device", async () => {
  const bin = await mkdtemp(join(tmpdir(), "cg-adb-usb-"));
  const pids = () =>
    readFile(join(bin, "log"), "utf8")
      .then((t) =>
        t
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { pid: number; usb: boolean }),
      )
      .catch(() => []);
  try {
    await writeFile(join(bin, "standin.py"), ADB_SERVER_STANDIN);
    await writeFile(join(bin, "adb"), FAKE_ADB, { mode: 0o755 });
    const legacy = spawn(
      "/usr/bin/python3",
      [
        "-I",
        join(bin, "standin.py"),
        "0",
        "1",
        JSON.stringify(["emulator-5590", "10.0.0.5:5555"]),
        join(bin, "log"),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    children.push(legacy);
    const port = await new Promise<number>((resolve, reject) => {
      legacy.stdout?.once("data", (d: Buffer) =>
        resolve(Number(String(d).split(" ")[1])),
      );
      legacy.once("exit", () => reject(new Error("stand-in exited")));
    });
    const plain = await standIn("adb"); // holds no USB device: left alone
    const probe = adbTargetProbe(
      async () => ({
        config: { mode: "local", dataDir: dir },
        target: "local",
      }),
      (_config, args) =>
        new Promise((resolve, reject) =>
          execFile(
            "/usr/bin/python3",
            [...args],
            { env: { PATH: `${bin}:/usr/bin:/bin` }, timeout: 15_000 },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          ),
        ),
    );
    const result = await probe({
      action: "usb_off",
      project: "first",
      machine: "local",
      generation: "generation-usb",
      adb_ports: [plain, port],
      emulator_ports: [],
    });
    expect(result).toEqual({
      target: "local",
      found: 1,
      left: 0,
      foreign: 0,
      reconnected: 2,
      missing: 0,
    });
    const started = await pids();
    expect(started.map((s) => s.usb)).toEqual([true, false]);
    expect(await listening(plain)).toBe(true);
    // The restarted server on the same port lists the emulator under its old
    // serial and the network device, but no USB device.
    const listing = await new Promise<string>((resolve, reject) => {
      const s = new Socket();
      let data = "";
      s.on("data", (d) => {
        data += String(d);
      });
      s.once("close", () => resolve(data));
      s.once("error", reject);
      s.connect(port, "127.0.0.1", () => s.write("000chost:devices"));
    });
    expect(listing).toContain("emulator-5590\tdevice");
    expect(listing).toContain("10.0.0.5:5555\tdevice");
    expect(listing).not.toContain("USB123");
    // Run again: nothing holds USB any more, nothing is restarted.
    expect(
      await probe({
        action: "usb_off",
        project: "first",
        machine: "local",
        generation: "generation-usb-2",
        adb_ports: [port],
        emulator_ports: [],
      }),
    ).toMatchObject({ found: 0, left: 0 });
    expect(await pids()).toHaveLength(2);
  } finally {
    for (const s of (await pids()).slice(1)) {
      try {
        process.kill(s.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(bin, { recursive: true, force: true });
  }
}, 30_000);

test("C-833: holder candidates name each live slot's session, the legacy ports' sessions from before the switch, and the default port", async () => {
  const { probe } = fakeProbe();
  const cfg = await config(deviceSlots, deviceResources);
  const l = new MachineLeases(store, cfg, probe);
  const held = await claim(l, 1, ["godot"]);
  const { owner } = needs(2, ["other"]);
  store.uow.run((tx) =>
    tx.assignments.put("first", {
      ...owner,
      runtime_ref: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "t2",
        agent_name: "coder",
      },
    }),
  );
  const label = (id: string) => sessionLabel(store, "first", id);
  expect(
    adbServerHolders(store, cfg, "local", (m) => l.devices.adbTypes(m)),
  ).toEqual([
    { port: 15100, kind: "slot", sessions: [label(held.owner.id)] },
    { port: 5137, kind: "legacy", sessions: [label(owner.id)] },
    { port: 5037, kind: "other", sessions: [] },
  ]);
  expect(label(owner.id)).toMatch(/^[\p{L}\p{N}._:/-]+$/u);
  const none = await config(undefined, { adb_slots: undefined });
  expect(adbServerHolders(store, none, "local", () => [])).toEqual([
    { port: 5037, kind: "other", sessions: [] },
  ]);
});
