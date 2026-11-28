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
  type SlotProcess,
} from "./adb-slot-probe.js";
import {
  adbEnvironmentWarnings,
  listUnregisteredEmulators,
} from "./adb-slots.js";
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

type Reply =
  | { found: number; left: number; processes?: readonly SlotProcess[] }
  | undefined;
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
  // A session without a launch generation (every local one) is judged by
  // its Assignment's latest launch: the replacement's record.
  const { launch_generation: _, ...legacyRef } = live.runtime_ref ?? {};
  expect(
    after.sessions.stale("first", {
      ...live,
      runtime_ref: legacyRef,
    } as typeof owner),
  ).toBe(false);
});

test("C-833: a local session (no launch generation) is replaced once after the switch, not at every wake", async () => {
  const { probe } = fakeProbe();
  const { owner } = needs(1, ["other"]);
  const first = { ...run(1), status: "completed", started_at: at } as Run;
  setStatus(first, {});
  // As a real local launch: no launch generation on the runtime reference.
  const live = {
    ...owner,
    runtime_ref: {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: "t1",
      agent_name: "coder",
    },
  } as typeof owner;
  const unmanaged = new MachineLeases(
    store,
    await config(undefined, { adb_slots: undefined }),
    probe,
  );
  launchDevices(unmanaged, "first", "local", first.id, at);
  const l = new MachineLeases(store, await config(), probe);
  expect(l.sessions.stale("first", live)).toBe(true);
  // The replacement session of the same Assignment records the new setup.
  const second = {
    ...run(2),
    assignment_id: owner.id,
    trigger_event_id: "evt-second",
  } as Run;
  store.uow.run((tx) =>
    tx.runs.put("first", {
      ...second,
      status: "running",
      started_at: later(1000),
    }),
  );
  launchDevices(l, "first", "local", second.id, later(1000));
  expect(l.sessions.stale("first", live)).toBe(false);
  expect(l.freshSession("first", live)).toBe(false);
});

test("C-833: old sessions are judged by their launch environment, not the time: launched before slots, or after without machine leases (before C-834)", async () => {
  const { probe } = fakeProbe();
  const session = (n: number) => {
    const { owner } = needs(n, ["other"]);
    const r = { ...run(n), status: "completed", started_at: at } as Run;
    setStatus(r, {});
    const live = {
      ...owner,
      runtime_ref: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: `t${n}`,
        agent_name: "coder",
        launch_generation: { run_id: r.id, generation: `g${n}` },
      },
    } as typeof owner;
    store.uow.run((tx) => tx.assignments.put("first", live));
    return { live, run: r };
  };
  // Launched while the machine had no adb slots.
  const unmanaged = new MachineLeases(
    store,
    await config(undefined, { adb_slots: undefined }),
    probe,
  );
  const before = session(1);
  launchDevices(unmanaged, "first", "local", before.run.id, at);
  expect(unmanaged.sessions.stale("first", before.live)).toBe(false);
  const l = new MachineLeases(store, await config(), probe);
  // Launched after slots were enabled, but by a path that passed no machine
  // leases: its environment never got the slot setup.
  const leaseless = session(2);
  launchDevices(undefined, "first", "local", leaseless.run.id, later(1000));
  // Launched after, with the slot setup compiled in.
  const current = session(3);
  launchDevices(l, "first", "local", current.run.id, later(2000));
  expect(l.sessions.stale("first", before.live)).toBe(true);
  expect(l.sessions.stale("first", leaseless.live)).toBe(true);
  expect(l.sessions.stale("first", current.live)).toBe(false);
  expect(l.freshSession("first", leaseless.live)).toBe(true);
  expect(l.sessions.staleSessions("local")).toEqual([
    { project: "first", assignment_id: before.live.id },
    { project: "first", assignment_id: leaseless.live.id },
  ]);
});

test("C-837: a remote session launched without the slot setup is still replaced; launch records keep one row per live Assignment", async () => {
  const { probe } = fakeProbe();
  await writeFile(
    join(dir, "run-capacity.yaml"),
    JSON.stringify({
      machines: {
        mac: {
          limit: 6,
          resources: { "android.emulator": 2, godot: 2, other: 1 },
          adb_slots: slots,
        },
      },
    }),
    { mode: 0o600 },
  );
  const l = new MachineLeases(
    store,
    await loadRunCapacityConfig({ configDir: dir }),
    probe,
  );
  const rows = () =>
    (
      store.database
        .prepare("SELECT run_id FROM machine_adb_launches ORDER BY run_id")
        .all() as { run_id: string }[]
    ).map((r) => r.run_id);
  // A remote launch publishes its launch generation on the runtime reference.
  const remote = (n: number, launch: string) => {
    const live = {
      ...assignment(n),
      machine_id: "mac",
      runtime_ref: {
        machine_id: "mac",
        runtime_machine: "mac",
        terminal_ref: `t${n}`,
        agent_name: "coder",
        launch_generation: { run_id: launch, generation: `g${n}` },
      },
    };
    store.uow.run((tx) => tx.assignments.put("first", live));
    return live;
  };
  const item = fixture().work_items[0];
  if (!item) throw new Error("missing item");
  store.uow.run((tx) => {
    tx.machines.put("first", {
      ...tx.machines.get("first", "local"),
      id: "mac",
      label: "mac",
      herdr_machine: "mac",
    } as Machine);
    for (const n of [1, 2]) {
      tx.work_items.put("first", { ...item, id: assignment(n).work_item_id });
      tx.assignments.put("first", { ...assignment(n), machine_id: "mac" });
      tx.runs.put("first", { ...run(n), status: "completed" });
    }
  });
  const old = remote(1, run(1).id);
  const kept = remote(2, run(2).id);
  // Launched by a path without machine leases (before C-834): no record.
  launchDevices(undefined, "first", "mac", run(1).id, at);
  launchDevices(l, "first", "mac", run(2).id, at);
  expect(l.sessions.stale("first", old)).toBe(true);
  expect(l.freshSession("first", old)).toBe(true);
  expect(l.sessions.stale("first", kept)).toBe(false);
  expect(rows()).toEqual([run(2).id]);
  // The replacement session of Assignment 1 records; its live session is
  // that launch, so it is no longer replaced.
  const next = {
    ...run(3, 1),
    trigger_event_id: "evt-next",
  } as Run;
  store.uow.run((tx) => tx.runs.put("first", next));
  launchDevices(l, "first", "mac", next.id, later(1000));
  const replaced = remote(1, next.id);
  expect(l.sessions.stale("first", replaced)).toBe(false);
  // A later launch of Assignment 2 supersedes its earlier record.
  const again = {
    ...run(4, 2),
    trigger_event_id: "evt-again",
  } as Run;
  store.uow.run((tx) => tx.runs.put("first", again));
  launchDevices(l, "first", "mac", again.id, later(2000));
  expect(rows()).toEqual([next.id, again.id]);
  // A released Assignment has no session left: its record goes at the next launch.
  store.uow.run((tx) =>
    tx.assignments.put("first", { ...replaced, status: "released" }),
  );
  launchDevices(l, "first", "mac", again.id, later(3000));
  expect(rows()).toEqual([again.id]);
  expect(l.sessions.stale("first", remote(2, again.id))).toBe(false);
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

// ---- C-844: emulators outside any Run's slot -------------------------------

test("C-844: only a Run holding an emulator may start one; elsewhere the launch gets no AVD", async () => {
  const l = new MachineLeases(store, await config(), fakeProbe().probe);
  const emulator = await claim(l, 1, ["android.emulator"]);
  const godot = await claim(l, 2, ["godot"]);
  const none = needs(3, []);
  expect(
    launchDevices(l, "first", "local", emulator.run.id, at).no_emulator,
  ).toBeUndefined();
  expect(launchDevices(l, "first", "local", godot.run.id, at)).toMatchObject({
    adb_slot: { slot: 1 },
    no_emulator: {},
  });
  expect(
    launchDevices(l, "first", "local", none.run.id, at).no_emulator,
  ).toEqual({});
  // A machine without adb slots goes by the claimed resource keys.
  const unmanaged = new MachineLeases(
    store,
    await config(undefined, { adb_slots: undefined }),
    fakeProbe().probe,
  );
  setStatus(none.run, { resource_keys: ["android.any", "android.emulator"] });
  expect(
    launchDevices(unmanaged, "first", "local", none.run.id, at).no_emulator,
  ).toBeUndefined();
  setStatus(none.run, { resource_keys: ["other"] });
  expect(
    launchDevices(unmanaged, "first", "local", none.run.id, at).no_emulator,
  ).toEqual({});
  // No machine leases at all: nothing is managed, nothing is taken away.
  expect(launchDevices(undefined, "first", "local", none.run.id, at)).toEqual(
    {},
  );
});

type Listed = NonNullable<Awaited<ReturnType<AdbProbe>>>["emulators"];
function emulatorProbe(list: () => Listed) {
  const stops: AdbProbeContext[] = [];
  const adb = vi.fn<AdbProbe>(async (c) => {
    if (c.action === "emulators")
      return { target: "target-1", found: 0, left: 0, emulators: list() };
    if (c.action === "emulator_stop") {
      stops.push(c);
      return { target: "target-1", found: c.pids?.length ?? 0, left: 0 };
    }
    return { target: "target-1", found: 0, left: 0 };
  });
  const probe = Object.assign(
    vi.fn(async () => "target-1"),
    { adb },
  ) as unknown as ResourceProbe;
  return { probe, adb, stops };
}
const timeline = (card = "C-1") =>
  store.uow.read((tx) => tx.timeline.list("first", card as never));

test("C-844: the sweep records emulators no Run's slot covers and stops them once the machine is over its emulator slots", async () => {
  const card = fixture().cards[0];
  if (!card) throw new Error("missing card");
  store.uow.run((tx) => tx.cards.put("first", card));
  let running: Listed = [];
  const { probe, stops } = emulatorProbe(() => running);
  const l = new MachineLeases(
    store,
    await config({ ...slots, sweep_minutes: 5 }),
    probe,
  );
  const leased = await claim(l, 1, ["android.emulator"]);
  const godot = await claim(l, 2, ["godot"]);
  running = [
    // The emulator Run's own, on its slot's console port.
    { pid: 101, started: "11", kind: "qemu", port: 5600 },
    // Also its own, though started on the default port: it names its Run.
    {
      pid: 102,
      started: "12",
      kind: "qemu",
      port: 5556,
      session: `${leased.owner.id}.${leased.run.id}`,
    },
    // The godot Run started one itself, on the default port.
    {
      pid: 202,
      started: "22",
      kind: "qemu",
      port: 5554,
      session: `${godot.owner.id}.${godot.run.id}`,
    },
    { pid: 203, started: "23", kind: "launcher", port: 5554 },
  ];
  await l.adb.reconcile("first", () => at);
  // One leased emulator plus one stray fits the 2 emulator slots: shown, kept.
  expect(stops).toEqual([]);
  expect(listUnregisteredEmulators(store.database)).toEqual([
    expect.objectContaining({
      project: "first",
      machine: "local",
      pid: 202,
      kind: "qemu",
      port: 5554,
      assignment_id: godot.owner.id,
      run_id: godot.run.id,
      first_seen_at: at,
    }),
    expect.objectContaining({ pid: 203, kind: "launcher" }),
  ]);
  expect(events("machine_emulator_unregistered")).toEqual([
    expect.objectContaining({
      payload: {
        machine: "local",
        instances: 1,
        action: "observed",
        run_ids: godot.run.id,
      },
    }),
  ]);
  // The next sweep sees the same processes: no new event.
  await l.adb.reconcile("first", () => later(5 * 60_000));
  expect(events("machine_emulator_unregistered")).toHaveLength(1);
  expect(listUnregisteredEmulators(store.database)[0]?.last_seen_at).toBe(
    later(5 * 60_000),
  );
  // A second emulator Run takes the last slot: the stray is over the limit.
  const second = await claim(l, 3, ["android.emulator"]);
  expect(second.access?.adb?.emulator_port).toBe(5604);
  await l.adb.reconcile("first", () => later(10 * 60_000));
  expect(stops).toHaveLength(1);
  expect(stops[0]?.pids).toEqual([
    [202, "22"],
    [203, "23"],
  ]);
  expect(listUnregisteredEmulators(store.database)).toEqual([]);
  expect(events("machine_emulator_unregistered").at(-1)?.payload).toEqual({
    machine: "local",
    instances: 1,
    action: "stopped",
    reason: "over_limit",
    run_ids: godot.run.id,
  });
  // The godot Run's card is told, without ports or PIDs.
  const note = timeline().find((t) => t.body.includes("自己启动的模拟器"));
  expect(note?.body).toContain(godot.run.id);
  expect(note?.body).toContain("名额已满");
  expect(note?.body).toContain("android.any");
  expect(note?.body).not.toMatch(/5554|202/u);
});

test("C-844: on a machine whose emulator another project reserved, any stray emulator is stopped at once; an unanswered stop keeps it listed", async () => {
  const listed: Listed = [{ pid: 7, started: "70", kind: "qemu" }];
  let answer = false;
  const stops: AdbProbeContext[] = [];
  const adb = vi.fn<AdbProbe>(async (c) => {
    if (c.action === "emulators")
      return { target: "target-1", found: 1, left: 0, emulators: listed };
    if (c.action === "emulator_stop") {
      stops.push(c);
      return answer ? { target: "target-1", found: 1, left: 0 } : undefined;
    }
    return { target: "target-1", found: 0, left: 0 };
  });
  const probe = Object.assign(
    vi.fn(async () => "target-1"),
    {
      adb,
    },
  ) as unknown as ResourceProbe;
  const l = new MachineLeases(
    store,
    await config({ ...slots, sweep_minutes: 5 }),
    probe,
  );
  const reservation = await l.reserve(
    { kind: "human", project_id: "second" },
    "local",
    "android.emulator",
    later(-60_000),
    later(3600_000),
    () => later(-120_000),
  );
  await l.adb.reconcile("first", () => at);
  expect(stops).toHaveLength(1);
  expect(listUnregisteredEmulators(store.database)).toEqual([
    expect.objectContaining({
      pid: 7,
      stop_reason: "reserved",
      stop_failed_at: at,
    }),
  ]);
  expect(events("machine_emulator_unregistered").at(-1)?.payload).toEqual({
    machine: "local",
    instances: 1,
    action: "stop_failed",
    reason: "reserved",
    reservation: expect.any(String),
  });
  expect(reservation).toBeDefined();
  answer = true;
  await l.adb.reconcile("first", () => later(5 * 60_000));
  expect(stops).toHaveLength(2);
  expect(listUnregisteredEmulators(store.database)).toEqual([]);
  expect(events("machine_emulator_unregistered").at(-1)?.payload).toMatchObject(
    { action: "stopped", reason: "reserved" },
  );
  // The holder project's own emulators are not closed by its reservation.
  expect(events("machine_emulator_unregistered", "second")).toEqual([]);
});

test("C-844: the real script lists this account's emulator processes with their console port and Run, and stops exactly the named ones", async () => {
  if (platform() !== "linux") return;
  const probe = targetProbe(() => ({ mode: "local", dataDir: dir }));
  const adb = probe.adb as AdbProbe;
  const fake = (argv0: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawn(
      "/usr/bin/python3",
      [
        "-c",
        `import os,sys; os.execv('/usr/bin/python3', [${JSON.stringify(argv0)}, '-c', 'import time; time.sleep(60)', ${args.map((a) => JSON.stringify(a)).join(",")}])`,
      ],
      { env: { PATH: "/usr/bin:/bin", ...env }, stdio: "ignore" },
    );
  const qemu = fake(
    "qemu-system-x86_64-headless",
    ["-avd", "X", "-port", "5554"],
    {
      CARDIGAN_RESOURCE_SESSION: "A-9.R-99",
    },
  );
  const launcher = fake("/opt/sdk/emulator/emulator", ["-ports", "5602,5603"]);
  const other = fake("qemu-img", ["-port", "5556"]);
  children.push(qemu, launcher, other);
  const context = {
    project: "first",
    machine: "local",
    generation: "g-1",
    adb_ports: [],
    emulator_ports: [],
  };
  let found: Listed = [];
  for (let i = 0; i < 50; i++) {
    found = (await adb({ ...context, action: "emulators" }))?.emulators;
    if (
      (found ?? []).filter((e) => e.pid === qemu.pid || e.pid === launcher.pid)
        .length === 2
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const mine = (found ?? [])
    .filter(
      (e) =>
        e.pid === qemu.pid || e.pid === launcher.pid || e.pid === other.pid,
    )
    .sort((a, b) => a.pid - b.pid);
  expect(mine).toEqual(
    [
      expect.objectContaining({
        pid: qemu.pid,
        kind: "qemu",
        port: 5554,
        session: "A-9.R-99",
      }),
      expect.objectContaining({
        pid: launcher.pid,
        kind: "launcher",
        port: 5602,
      }),
    ].sort((a, b) => (a.pid ?? 0) - (b.pid ?? 0)),
  );
  const target = mine.find((e) => e.pid === qemu.pid);
  if (!target) throw new Error("missing qemu stand-in");
  // A stale start stamp (a reused PID) is never signalled.
  expect(
    await adb({
      ...context,
      action: "emulator_stop",
      pids: [[launcher.pid ?? 0, "0"]],
    }),
  ).toEqual({ target: "local", found: 0, left: 0 });
  expect(
    await adb({
      ...context,
      action: "emulator_stop",
      pids: [[target.pid, target.started]],
    }),
  ).toEqual({ target: "local", found: 1, left: 0 });
  const after = (await adb({ ...context, action: "emulators" }))?.emulators;
  expect(after?.some((e) => e.pid === qemu.pid)).toBe(false);
  expect(after?.some((e) => e.pid === launcher.pid)).toBe(true);
}, 20_000);

// ---- C-848: the system closes what an ended Run left on its slot ---------

const leftover = (signalled: boolean, port = 5600): SlotProcess[] => [
  { pid: 23812, kind: "qemu", port, ppid: 1, signalled },
  { pid: 23790, kind: "adb", port: 15100, ppid: 1, signalled: false },
];
const releases = (adb: ReturnType<typeof fakeProbe>["adb"]) =>
  adb.mock.calls.filter(([c]) => c.action === "release").map(([c]) => c);

test("C-848: a Run that ended without closing its emulator has it stopped by the system; the event names the PIDs, ports and reason", async () => {
  const { probe, adb } = fakeProbe((c) =>
    c.action === "check"
      ? { found: 0, left: 0 }
      : { found: 3, left: 0, processes: leftover(true) },
  );
  const l = new MachineLeases(store, await config(), probe);
  const a = await claim(l, 1, ["android.emulator"]);
  const b = await claim(l, 2, ["android.emulator"]);
  // The agent finished its turn and never closed the emulator it started.
  setStatus(a.run, { status: "completed" });
  await l.adb.reconcile("first", () => later(1000));
  const [release] = releases(adb);
  expect(release).toMatchObject({
    adb_ports: [15100],
    emulator_ports: [5600],
    // An emulator naming this Run is closed even off its slot's port...
    session: `${a.owner.id}.${a.run.id}`,
    // ...while the other Run, still running, is never touched.
    keep_sessions: [`${b.owner.id}.${b.run.id}`],
  });
  expect(events("machine_adb_slot_released").at(-1)?.payload).toEqual({
    machine: "local",
    slot: 0,
    run_id: a.run.id,
    closed: 3,
    reason: "run_ended",
    run_status: "completed",
    adb_port: 15100,
    emulator_port: 5600,
    pids: "23812,23790",
    processes: "qemu:23812:5600:ppid=1:signalled,adb:23790:15100:ppid=1",
    signalled: 1,
    orphaned: 2,
  });
  expect(l.adb.launchSlot("first", "local", a.run.id)).toBeNull();
  expect(l.adb.launchSlot("first", "local", b.run.id)).toEqual(b.access?.adb);
  // Other projects' streams get nothing.
  expect(events("machine_adb_slot_released", "second")).toEqual([]);
});

test("C-848: a stopped session's emulator is closed once the stop is confirmed, not while it may still run", async () => {
  const { probe, adb } = fakeProbe((c) =>
    c.action === "check"
      ? { found: 0, left: 0 }
      : { found: 2, left: 0, processes: leftover(true) },
  );
  const l = new MachineLeases(store, await config(), probe);
  const a = await claim(l, 1, ["android.emulator"]);
  setStatus(a.run, {
    status: "cancelled",
    dispatch_stop: { requested_at: at } as never,
  });
  await l.adb.reconcile("first", () => later(1000));
  expect(releases(adb)).toEqual([]);
  // The stop is confirmed: the session is gone, its emulator is not.
  setStatus(a.run, { status: "cancelled" });
  await l.adb.reconcile("first", () => later(2000));
  expect(releases(adb)).toHaveLength(1);
  expect(releases(adb)[0]?.keep_sessions).toBeUndefined();
  expect(events("machine_adb_slot_released").at(-1)?.payload).toMatchObject({
    run_id: a.run.id,
    reason: "run_ended",
    run_status: "cancelled",
    pids: "23812,23790",
    emulator_port: 5600,
  });
  expect(l.adb.diagnostics("local")?.[0]?.state).toBe("free");
});

test("C-848: while the worker is unreachable the slot stays held; after it reconnects the leftover emulator is stopped and the slot freed", async () => {
  let online = false;
  const { probe, adb } = fakeProbe((c) =>
    !online
      ? undefined
      : c.action === "check"
        ? { found: 0, left: 0 }
        : { found: 3, left: 0, processes: leftover(true) },
  );
  const l = new MachineLeases(store, await config(), probe);
  const a = await claim(l, 1, ["android.emulator"]);
  // The worker dropped; the Run is failed without its session cleaning up.
  setStatus(a.run, { status: "failed" });
  await l.adb.reconcile("first", () => later(0));
  expect(l.adb.diagnostics("local")?.[0]).toMatchObject({
    state: "release_pending",
    run_id: a.run.id,
    release_state: "目标不可达或未确认",
  });
  // No other Run gets the slot meanwhile: its emulator may still run.
  const b = await claim(l, 2, ["android.emulator"]);
  expect(b.access?.adb?.slot).toBe(1);
  online = true;
  await l.adb.reconcile("first", () => later(31_000));
  expect(releases(adb)).toHaveLength(2);
  expect(events("machine_adb_slot_released").at(-1)?.payload).toMatchObject({
    slot: 0,
    run_id: a.run.id,
    reason: "run_ended",
    run_status: "failed",
    pids: "23812,23790",
    adb_port: 15100,
    emulator_port: 5600,
  });
  expect(l.adb.diagnostics("local")?.[0]?.state).toBe("free");
});

test("C-848: the sweep stops an orphan emulator on a released slot even when its console port does not answer, and passes running Runs as untouchable", async () => {
  const orphan = (signalled: boolean): SlotProcess[] => [
    { pid: 23812, kind: "qemu", port: 5602, ppid: 1, signalled },
  ];
  const { probe, adb } = fakeProbe((c) =>
    !c.emulator_ports.includes(5602)
      ? { found: 0, left: 0 }
      : c.action === "check"
        ? { found: 1, left: 1, processes: orphan(false) }
        : { found: 1, left: 0, processes: orphan(true) },
  );
  const l = new MachineLeases(store, await config(), probe);
  const live = await claim(l, 1, ["android.emulator"]);
  await l.adb.reconcile("first", () => at);
  const checks = adb.mock.calls
    .filter(([c]) => c.action === "check")
    .map(([c]) => c);
  // The live Run's slot is never checked; its processes are kept everywhere.
  expect(checks.map((c) => c.emulator_ports[0])).toEqual([5602, 5604, 5606]);
  for (const c of [...checks, ...releases(adb)]) {
    expect(c.keep_sessions).toEqual([`${live.owner.id}.${live.run.id}`]);
    expect(c.session).toBeUndefined();
  }
  expect(releases(adb)).toHaveLength(1);
  expect(events("machine_adb_orphan_closed")).toEqual([
    expect.objectContaining({
      payload: {
        machine: "local",
        slot: 1,
        closed: 1,
        reason: "slot_free",
        adb_port: 15101,
        emulator_port: 5602,
        pids: "23812",
        processes: "qemu:23812:5602:ppid=1:signalled",
        signalled: 1,
        orphaned: 1,
      },
    }),
  ]);
  expect(l.adb.diagnostics("local")?.map((d) => d.state)).toEqual([
    "run",
    "free",
    "free",
    "free",
  ]);
});

test("C-848: an unparsable process list from the target is no proof of release", async () => {
  for (const processes of [
    [[1, "qemu", 5600, 1]],
    [[0, "qemu", 5600, 1, true]],
    [[1, "bash", 5600, 1, true]],
    "x",
  ]) {
    const probe = adbTargetProbe(
      async () => ({
        config: { mode: "local", dataDir: dir },
        target: "local",
      }),
      async () =>
        JSON.stringify({ generation: "g", found: 1, left: 0, processes }),
    );
    expect(
      await probe({
        action: "release",
        project: "first",
        machine: "local",
        generation: "g",
        adb_ports: [15100],
        emulator_ports: [5600],
      }),
    ).toBeUndefined();
  }
});

// Real script against stand-ins named like the real processes: a qemu whose
// console hangs and that ignores SIGTERM, a qemu not listening at all, an adb
// server that ignores host:kill. Each is double-forked so its parent is gone,
// like an emulator an agent left behind with nohup.
const ORPHAN = `import os,socket,sys
argv0,mode,session=sys.argv[1],sys.argv[2],sys.argv[3]
args=sys.argv[4:]
s=None
if 'listen' in mode:
 s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',0)); s.listen(8); s.set_inheritable(True)
 args=[a.replace('PORT',str(s.getsockname()[1])) for a in args]
if os.fork(): os._exit(0)
os.setsid()
env={'PATH':'/usr/bin:/bin'}
if session!='-': env['CARDIGAN_RESOURCE_SESSION']=session
body="""import os,signal,socket,sys,time
mode,fd=sys.argv[1],int(sys.argv[2])
if 'stubborn' in mode: signal.signal(signal.SIGTERM,signal.SIG_IGN)
print('ready',os.getpid(),flush=True)
if fd<0:
 while True: time.sleep(1)
s=socket.socket(fileno=fd); held=[]
while True:
 c,_=s.accept(); held.append(c)
"""
os.execve('/usr/bin/python3',[argv0,'-c',body,mode,str(s.fileno() if s else -1)]+args,env)
`;
const orphans: number[] = [];
afterEach(() => {
  for (const pid of orphans.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
});
async function orphanStandIn(
  argv0: string,
  mode: string,
  args: string[],
  session = "-",
): Promise<{ pid: number; port?: number }> {
  const child = spawn(
    "/usr/bin/python3",
    ["-I", "-c", ORPHAN, argv0, mode, session, ...args],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const pid = await new Promise<number>((resolve, reject) => {
    child.stdout?.once("data", (data: Buffer) =>
      resolve(Number(String(data).split(" ")[1])),
    );
    setTimeout(() => reject(new Error("stand-in did not start")), 5000);
  });
  child.stdout?.destroy();
  orphans.push(pid);
  const argv = await readArgs(pid);
  const at = argv.findIndex((a) => a === "-port" || a === "-P");
  const port = at >= 0 ? Number(argv[at + 1]) : undefined;
  return { pid, ...(port ? { port } : {}) };
}
async function readArgs(pid: number): Promise<string[]> {
  const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) =>
    execFile("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], (e, o) =>
      e ? reject(e) : resolve({ stdout: o }),
    ),
  );
  return stdout.trim().split(/\s+/u);
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function unused(): Promise<number> {
  // A port nothing listens on for a stand-in that never binds.
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 30000);
    if (!(await listening(port)) && !(await listening(port + 1))) return port;
  }
}

test("C-848: the real script stops by PID what the console and adb protocol left running, checks only this slot, and reports parents", async () => {
  const probe = targetProbe(() => ({ mode: "local", dataDir: dir }));
  const adb = probe.adb as AdbProbe;
  const hung = await orphanStandIn("qemu-system-x86_64", "listen stubborn", [
    "-avd",
    "X",
    "-port",
    "PORT",
  ]);
  const server = await orphanStandIn("adb", "listen", [
    "-P",
    "PORT",
    "fork-server",
    "server",
  ]);
  const quiet = await orphanStandIn("qemu-system-aarch64", "", [
    "-port",
    String(await unused()),
  ]);
  const other = await orphanStandIn("qemu-system-x86_64", "", [
    "-port",
    String(await unused()),
  ]);
  if (!hung.port || !server.port || !quiet.port) throw new Error("no port");
  const context = {
    project: "first",
    machine: "local",
    generation: "g-848",
    adb_ports: [server.port],
    emulator_ports: [hung.port],
  };
  const checked = await adb({ ...context, action: "check" });
  expect(checked).toMatchObject({ found: 2, left: 2 });
  expect(checked?.processes?.map((p) => [p.pid, p.kind, p.port])).toEqual(
    [
      [hung.pid, "qemu", hung.port],
      [server.pid, "adb", server.port],
    ].sort((x, y) => Number(x[0]) - Number(y[0])),
  );
  // The parent is gone: it was handed to launchd / init or a subreaper.
  for (const p of checked?.processes ?? [])
    expect(p.ppid).not.toBe(process.pid);
  expect(alive(hung.pid) && alive(server.pid)).toBe(true);
  const released = await adb({ ...context, action: "release" }, "local");
  expect(released).toMatchObject({ found: 2, left: 0 });
  expect(released?.processes?.every((p) => p.signalled)).toBe(true);
  expect(alive(hung.pid) || alive(server.pid)).toBe(false);
  // An emulator on the slot's console port the port check cannot see.
  const silent = { ...context, emulator_ports: [quiet.port], adb_ports: [] };
  expect(await adb({ ...silent, action: "check" })).toMatchObject({
    found: 1,
    left: 1,
    processes: [expect.objectContaining({ pid: quiet.pid, kind: "qemu" })],
  });
  expect(await adb({ ...silent, action: "release" }, "local")).toMatchObject({
    found: 1,
    left: 0,
  });
  expect(alive(quiet.pid)).toBe(false);
  // Another slot's emulator was never touched.
  expect(alive(other.pid)).toBe(true);
}, 40_000);

test("C-848: the real script closes an emulator naming the ended Run off its slot port, never one naming a running Run", async () => {
  // Sessions are read from the process environment, which Linux exposes.
  if (platform() !== "linux") return;
  const probe = targetProbe(() => ({ mode: "local", dataDir: dir }));
  const adb = probe.adb as AdbProbe;
  const slotPort = await unused();
  const mine = await orphanStandIn(
    "qemu-system-x86_64",
    "",
    ["-port", String(await unused())],
    "A-1.R-1",
  );
  const running = await orphanStandIn(
    "qemu-system-x86_64",
    "",
    ["-port", String(slotPort)],
    "A-2.R-2",
  );
  const context = {
    project: "first",
    machine: "local",
    generation: "g-848s",
    adb_ports: [],
    emulator_ports: [slotPort],
    session: "A-1.R-1",
    keep_sessions: ["A-2.R-2"],
  };
  const released = await adb({ ...context, action: "release" }, "local");
  expect(released).toMatchObject({ found: 1, left: 0 });
  expect(released?.processes).toEqual([
    expect.objectContaining({ pid: mine.pid, kind: "qemu", signalled: true }),
  ]);
  expect(alive(mine.pid)).toBe(false);
  expect(alive(running.pid)).toBe(true);
}, 30_000);
