import { randomUUID } from "node:crypto";
import type { Assignment, CardId, Run } from "@cardigan/domain";
import { runOccupiesSlot } from "@cardigan/domain";
import {
  type ReadRepositories,
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
} from "@cardigan/store";
import type { AdbProbe, EmulatorProcess } from "./adb-slot-probe.js";
import { DEVICE_PROVIDERS } from "./device-providers.js";
import type { MachinePolicy } from "./resource-policy.js";

/**
 * C-679: per-Run adb server and emulator ports on one machine.
 *
 * A Run that needs any of `resources` gets one slot of the machine's pool for
 * its whole life: `adb_port_base + slot` for its own adb server and, when it
 * needs the emulator, console port `emulator_port_base + 2 * slot` (serial
 * `emulator-<port>`). The slot stays held until the system has closed both on
 * the worker after the Run ended; only then can another Run get it.
 */
export const EMULATOR_RESOURCE = "android.emulator";
export const DEFAULT_ADB_SWEEP_MINUTES = 10;
// adb servers scan console ports 5554..5584 for emulators on their own; a
// slot's emulator must stay outside that range so no other server attaches.
const EMULATOR_MIN = 5586,
  EMULATOR_MAX = 5682;

export interface AdbSlotPolicy {
  readonly resources: ReadonlySet<string>;
  readonly count: number;
  readonly adbPortBase: number;
  readonly emulatorPortBase?: number;
  readonly legacyAdbPorts: readonly number[];
  readonly legacyEmulatorPorts: readonly number[];
  readonly sweepMs: number;
}
export interface AdbSlotAccess {
  readonly generation: string;
  readonly slot: number;
  readonly adb_port: number;
  readonly emulator_port?: number;
}
/** The launch environment's slot: a slot, none on a managed machine (null), or unmanaged (undefined). */
export type LaunchAdbSlot = AdbSlotAccess | null | undefined;

function invalid(): never {
  throw new Error("Invalid adb slots");
}
const integer = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max
    ? v
    : invalid();
const ports = (v: unknown) =>
  v === undefined
    ? []
    : Array.isArray(v) && new Set(v).size === v.length
      ? v.map((p) => integer(p, 1024, 65535))
      : invalid();

export function parseAdbSlots(
  raw: unknown,
  slots: ReadonlyMap<string, number>,
  policies: MachinePolicy | undefined,
): AdbSlotPolicy {
  if (
    !raw ||
    typeof raw !== "object" ||
    Object.getPrototypeOf(raw) !== Object.prototype
  )
    return invalid();
  const r = raw as Record<string, unknown>;
  if (
    Object.keys(r).some(
      (k) =>
        ![
          "resources",
          "count",
          "adb_port_base",
          "emulator_port_base",
          "legacy_adb_ports",
          "legacy_emulator_ports",
          "sweep_minutes",
        ].includes(k),
    ) ||
    !Array.isArray(r.resources) ||
    !r.resources.length ||
    new Set(r.resources).size !== r.resources.length ||
    r.resources.some((k) => typeof k !== "string" || !slots.has(k))
  )
    return invalid();
  const resources = new Set(r.resources as string[]);
  // A Run needing several of these holds one slot, so the sum is enough.
  const count =
    r.count === undefined
      ? Math.min(
          64,
          [...resources].reduce((n, k) => n + (slots.get(k) ?? 0), 0),
        )
      : integer(r.count, 1, 64);
  const adbPortBase = integer(r.adb_port_base, 1024, 65535 - count + 1);
  const adb = new Set(Array.from({ length: count }, (_, i) => adbPortBase + i));
  let emulatorPortBase: number | undefined;
  const emulator = new Set<number>();
  if (r.emulator_port_base !== undefined) {
    emulatorPortBase = integer(
      r.emulator_port_base,
      EMULATOR_MIN,
      EMULATOR_MAX - 2 * (count - 1),
    );
    if (emulatorPortBase % 2) return invalid();
    for (let i = 0; i < count; i++) {
      emulator.add(emulatorPortBase + 2 * i);
      emulator.add(emulatorPortBase + 2 * i + 1);
    }
  } else if (resources.has(EMULATOR_RESOURCE)) return invalid();
  const legacyAdbPorts = ports(r.legacy_adb_ports),
    legacyEmulatorPorts = ports(r.legacy_emulator_ports);
  if (
    adb.has(5037) ||
    [...adb].some((p) => emulator.has(p)) ||
    // One adb environment per Run: static bindings would set another.
    [...(policies?.values() ?? [])].some((p) => p.bindings.size) ||
    [...legacyAdbPorts, ...legacyEmulatorPorts].some(
      (p) => adb.has(p) || emulator.has(p),
    ) ||
    legacyEmulatorPorts.some((p) => p % 2)
  )
    return invalid();
  return {
    resources,
    count,
    adbPortBase,
    ...(emulatorPortBase === undefined ? {} : { emulatorPortBase }),
    legacyAdbPorts,
    legacyEmulatorPorts,
    sweepMs:
      integer(r.sweep_minutes ?? DEFAULT_ADB_SWEEP_MINUTES, 1, 1440) * 60_000,
  };
}

interface Row {
  generation: string;
  machine: string;
  slot: number;
  adb_port: number;
  emulator_port: number | null;
  project: string;
  assignment_id: string | null;
  run_id: Run["id"] | null;
  purpose: "run" | "sweep";
  emulator: number;
  target: string | null;
  acquired_at: string;
  release_state: string | null;
  attempts: number;
  next_attempt_at: string | null;
  released_at: string | null;
}
export interface AdbSlotDiagnostic {
  readonly slot: number;
  readonly adb_port: number;
  readonly emulator_port?: number;
  readonly state: "free" | "run" | "sweep" | "release_pending";
  readonly project?: string;
  readonly assignment_id?: string;
  readonly run_id?: string;
  readonly since?: string;
  readonly release_state?: string;
}

type Config = {
  adbSlots(machine: string): AdbSlotPolicy | undefined;
};
/**
 * C-844: what an unregistered emulator on this machine is up against: the
 * machine's `android.emulator` slots (none configured counts as 0) and a
 * calendar reservation of the emulator by another project (the owner
 * closing it), named by its id.
 */
export type EmulatorPolicy = (
  project: string,
  machine: string,
  now: string,
) => { readonly limit: number; readonly reservation?: string };
export type EmulatorStopReason = "reserved" | "over_limit";
/** C-844: an emulator process no Run's slot covers, as host diagnostics show it. */
export interface UnregisteredEmulator {
  readonly project: string;
  readonly machine: string;
  readonly pid: number;
  readonly kind: "qemu" | "launcher";
  readonly port?: number;
  readonly assignment_id?: string;
  readonly run_id?: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  /** Why the sweep stops it (it is still running: the stop failed). */
  readonly stop_reason?: EmulatorStopReason;
  readonly stop_failed_at?: string;
}
const STOP_TEXT: Record<EmulatorStopReason, string> = {
  reserved: "这台机器的模拟器已被预约关闭",
  over_limit: "这台机器的模拟器名额已满",
};
const RETRY_MS = 30_000,
  RETRY_MAX_MS = 10 * 60_000;

export class AdbSlots {
  private readonly swept = new Map<string, number>();
  private sweeping = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly probe: AdbProbe | undefined,
    private readonly emulatorPolicy?: EmulatorPolicy,
  ) {}
  /** The machine policy when these resource keys need an adb slot. */
  applies(machine: string, keys: readonly string[]) {
    const p = this.config.adbSlots(machine);
    return p && keys.some((k) => p.resources.has(k)) ? p : undefined;
  }
  private live(machine: string): Row[] {
    return this.store.database
      .prepare(
        "SELECT * FROM machine_adb_slots WHERE machine=? AND released_at IS NULL ORDER BY slot",
      )
      .all(machine) as unknown as Row[];
  }
  private freeSlots(machine: string, p: AdbSlotPolicy) {
    const rows = this.live(machine);
    const used = new Set(rows.map((r) => r.slot)),
      usedPorts = new Set(
        rows.flatMap((r) => [
          r.adb_port,
          ...(r.emulator_port ? [r.emulator_port] : []),
        ]),
      );
    const free: number[] = [];
    for (let slot = 0; slot < p.count; slot++) {
      const ports = this.ports(p, slot);
      if (
        !used.has(slot) &&
        !usedPorts.has(ports.adb_port) &&
        !(ports.emulator_port && usedPorts.has(ports.emulator_port))
      )
        free.push(slot);
    }
    return free;
  }
  private ports(p: AdbSlotPolicy, slot: number) {
    return {
      adb_port: p.adbPortBase + slot,
      ...(p.emulatorPortBase === undefined
        ? {}
        : { emulator_port: p.emulatorPortBase + 2 * slot }),
    };
  }
  private held(project: string, run: string): Row | undefined {
    return this.store.database
      .prepare(
        "SELECT * FROM machine_adb_slots WHERE project=? AND run_id=? AND released_at IS NULL",
      )
      .get(project, run) as unknown as Row | undefined;
  }
  private access(row: Row): AdbSlotAccess {
    return {
      generation: row.generation,
      slot: row.slot,
      adb_port: row.adb_port,
      ...(row.emulator && row.emulator_port
        ? { emulator_port: row.emulator_port }
        : {}),
    };
  }
  /** What the launch environment of this Run must carry. */
  launchSlot(project: string, machine: string, run: string): LaunchAdbSlot {
    if (!this.config.adbSlots(machine)) return undefined;
    const row = this.held(project, run);
    return row && row.machine === machine ? this.access(row) : null;
  }
  /** A reason this Run cannot get a slot now, if any. */
  blocked(
    machine: string,
    keys: readonly string[],
    own?: { project: string; run: string },
  ) {
    const p = this.applies(machine, keys);
    if (!p) return;
    if (!this.probe) return "adb：缺少释放执行器";
    if (own && this.held(own.project, own.run)) return;
    if (!this.freeSlots(machine, p).length)
      return "adb：端口槽位已满，等待释放";
  }
  /** Inside the claim transaction; reuses a slot the Run already holds. */
  acquire(
    tx: StoreTransactionContext,
    project: string,
    a: Assignment,
    run: Run,
    keys: readonly string[],
    target: string | undefined,
    now: string,
  ): AdbSlotAccess | undefined {
    const p = this.applies(a.machine_id, keys);
    if (!p) return;
    const prior = this.held(project, run.id);
    if (prior?.machine === a.machine_id) return this.access(prior);
    if (!target || !this.probe) throw new Error("adb 槽位缺少执行目标");
    const slot = this.freeSlots(a.machine_id, p)[0];
    if (slot === undefined) throw new Error("adb 槽位已满");
    const generation = randomUUID(),
      ports = this.ports(p, slot),
      emulator = keys.includes(EMULATOR_RESOURCE) ? 1 : 0;
    this.store.database
      .prepare(
        "INSERT INTO machine_adb_slots (generation,machine,slot,adb_port,emulator_port,project,assignment_id,run_id,purpose,emulator,target,acquired_at) VALUES (?,?,?,?,?,?,?,?,'run',?,?,?)",
      )
      .run(
        generation,
        a.machine_id,
        slot,
        ports.adb_port,
        ports.emulator_port ?? null,
        project,
        a.id,
        run.id,
        emulator,
        target,
        now,
      );
    // Events name the slot, never its ports (C-497).
    this.event(tx, project, "machine_adb_slot_acquired", now, {
      machine: a.machine_id,
      slot,
      assignment_id: a.id,
      run_id: run.id,
      emulator: emulator === 1,
    });
    return {
      generation,
      slot,
      adb_port: ports.adb_port,
      ...(emulator && ports.emulator_port
        ? { emulator_port: ports.emulator_port }
        : {}),
    };
  }
  private event(
    tx: StoreTransactionContext,
    project: string,
    type: string,
    at: string,
    payload: Record<string, string | number | boolean>,
  ) {
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      actor: { kind: "system", project_id: project },
      type,
      created_at: at,
      payload,
    });
  }
  /** The Run ended (any way) and no launch of it is pending, or it is gone. */
  private ended(tx: ReadRepositories, row: Row) {
    if (row.purpose === "sweep" || !row.run_id) return true;
    const run = tx.runs.get(row.project, row.run_id);
    return (
      !run ||
      (["completed", "failed", "cancelled", "queued"].includes(run.status) &&
        !runOccupiesSlot(run) &&
        !unfinishedBellAttempts(this.store.database, row.project).some(
          (b) => b.run_id === run.id,
        ))
    );
  }
  private context(row: Row, action: "check" | "release") {
    return {
      action,
      project: row.project,
      machine: row.machine,
      generation: row.generation,
      adb_ports: [row.adb_port],
      emulator_ports: row.emulator_port ? [row.emulator_port] : [],
    };
  }
  private readonly inflight = new Map<string, Promise<void>>();
  /**
   * Start `reconcile` in the background: target round trips must not hold
   * up the dispatch tick. One pass per project at a time.
   */
  kick(project: string, clock: () => string) {
    if (!this.probe || this.inflight.has(project)) return;
    const work = this.reconcile(project, clock)
      .catch(() => {
        // Retried on the next tick; rows keep their slot meanwhile.
      })
      .finally(() => this.inflight.delete(project));
    this.inflight.set(project, work);
  }
  /** Settle background passes (tests and shutdown). */
  async idle() {
    await Promise.all(this.inflight.values());
  }
  /** Close ended Runs' servers and emulators, then sweep due machines. */
  async reconcile(project: string, clock: () => string) {
    if (!this.probe) return;
    const due = this.store.uow.read((tx) => {
      const at = clock();
      return (
        this.store.database
          .prepare(
            "SELECT * FROM machine_adb_slots WHERE project=? AND released_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY acquired_at",
          )
          .all(project, at) as unknown as Row[]
      ).filter((row) => this.ended(tx, row));
    });
    for (const row of due) await this.release(row, clock);
    await this.sweep(project, clock);
  }
  private async release(row: Row, clock: () => string) {
    const result = await this.probe?.(
      this.context(row, "release"),
      row.target ?? undefined,
    );
    this.store.uow.run((tx) => {
      const at = clock();
      const fresh = this.store.database
        .prepare(
          "SELECT * FROM machine_adb_slots WHERE generation=? AND released_at IS NULL",
        )
        .get(row.generation) as unknown as Row | undefined;
      if (!fresh || !this.ended(tx, fresh)) return;
      if (result && result.left === 0) {
        this.store.database
          .prepare(
            "UPDATE machine_adb_slots SET released_at=?, release_state=NULL WHERE generation=? AND released_at IS NULL",
          )
          .run(at, row.generation);
        const base = { machine: row.machine, slot: row.slot };
        if (row.purpose === "run")
          this.event(tx, row.project, "machine_adb_slot_released", at, {
            ...base,
            run_id: row.run_id ?? "",
            closed: result.found,
          });
        else
          this.event(tx, row.project, "machine_adb_orphan_closed", at, {
            ...base,
            closed: result.found,
          });
        return;
      }
      const reason = result ? "仍有监听未关闭" : "目标不可达或未确认";
      const attempts = fresh.attempts + 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (attempts - 1));
      this.store.database
        .prepare(
          "UPDATE machine_adb_slots SET release_state=?, attempts=?, next_attempt_at=? WHERE generation=? AND released_at IS NULL",
        )
        .run(
          reason,
          attempts,
          new Date(Date.parse(at) + delay).toISOString(),
          row.generation,
        );
      if (fresh.release_state !== reason)
        this.event(tx, row.project, "machine_adb_slot_release_pending", at, {
          machine: row.machine,
          slot: row.slot,
          reason,
        });
    });
  }
  /**
   * Orphans: a free slot's ports, or a configured legacy fixed port, still
   * listening although no live Run owns them. Free slots are held by a sweep
   * row while checked so no Run gets one mid-sweep.
   */
  private async sweep(project: string, clock: () => string) {
    const machines = this.store.uow.read((tx) =>
      tx.machines
        .list(project)
        .map((m) => m.id)
        .filter((id) => {
          const p = this.config.adbSlots(id);
          const last = this.swept.get(id);
          return (
            p &&
            !this.sweeping.has(id) &&
            (last === undefined || Date.parse(clock()) - last >= p.sweepMs)
          );
        }),
    );
    for (const machine of machines) {
      this.sweeping.add(machine);
      try {
        if (await this.sweepMachine(project, machine, clock))
          this.swept.set(machine, Date.parse(clock()));
      } finally {
        this.sweeping.delete(machine);
      }
    }
  }
  private async sweepMachine(
    project: string,
    machine: string,
    clock: () => string,
  ) {
    const p = this.config.adbSlots(machine);
    const probe = this.probe;
    if (!p || !probe) return false;
    const held = this.store.uow.run(() => {
      const at = clock();
      return this.freeSlots(machine, p).map((slot) => {
        const generation = randomUUID(),
          ports = this.ports(p, slot);
        this.store.database
          .prepare(
            "INSERT INTO machine_adb_slots (generation,machine,slot,adb_port,emulator_port,project,purpose,emulator,acquired_at) VALUES (?,?,?,?,?,?,'sweep',0,?)",
          )
          .run(
            generation,
            machine,
            slot,
            ports.adb_port,
            ports.emulator_port ?? null,
            project,
            at,
          );
        return {
          generation,
          machine,
          slot,
          adb_port: ports.adb_port,
          emulator_port: ports.emulator_port ?? null,
          project,
          purpose: "sweep",
          attempts: 0,
        } as unknown as Row;
      });
    });
    let reached = true;
    for (const row of held) {
      const checked = await probe(this.context(row, "check"));
      if (!checked) {
        // Unknown state: give the slot back and try the sweep again later.
        reached = false;
        this.store.uow.run(() =>
          this.store.database
            .prepare(
              "DELETE FROM machine_adb_slots WHERE generation=? AND released_at IS NULL AND purpose='sweep'",
            )
            .run(row.generation),
        );
        continue;
      }
      this.store.uow.run(() =>
        this.store.database
          .prepare(
            `UPDATE machine_adb_slots SET target=?${checked.found ? "" : ", released_at=?"} WHERE generation=? AND released_at IS NULL`,
          )
          .run(
            ...(checked.found
              ? [checked.target, row.generation]
              : [checked.target, clock(), row.generation]),
          ),
      );
      if (!checked.found) continue;
      await this.release({ ...row, target: checked.target }, clock);
    }
    const legacy =
      reached &&
      (p.legacyAdbPorts.length > 0 || p.legacyEmulatorPorts.length > 0) &&
      this.store.uow.read((tx) => this.legacyInUse(tx, machine, p));
    // C-833: while a session from before the switch may still use a legacy
    // port it is not closed, but on a machine handing out USB devices its
    // server must not hold them: restart it with ADB_USB=0.
    if (
      legacy &&
      p.legacyAdbPorts.length &&
      usbDeviceTypes(p).length &&
      !(await this.legacyUsbOff(project, machine, p, probe, clock))
    )
      return false;
    if (
      reached &&
      (p.legacyAdbPorts.length || p.legacyEmulatorPorts.length) &&
      !legacy
    ) {
      const context = {
        action: "release" as const,
        project,
        machine,
        generation: randomUUID(),
        adb_ports: p.legacyAdbPorts,
        emulator_ports: p.legacyEmulatorPorts,
      };
      const checked = await probe({ ...context, action: "check" });
      if (!checked) return false;
      if (checked.found) {
        const result = await probe(context, checked.target);
        this.store.uow.run((tx) =>
          this.event(
            tx,
            project,
            result && result.left === 0
              ? "machine_adb_orphan_closed"
              : "machine_adb_slot_release_pending",
            clock(),
            {
              machine,
              legacy: true,
              ...(result && result.left === 0
                ? { closed: result.found }
                : { reason: result ? "仍有监听未关闭" : "目标不可达或未确认" }),
            },
          ),
        );
      }
    }
    // C-844: after the slot and legacy ports are closed, what is left running
    // belongs to no Run.
    if (reached)
      await this.unregisteredEmulators(
        project,
        machine,
        p,
        probe,
        clock,
        !!legacy,
      );
    return reached;
  }
  /**
   * C-833: restart legacy servers of this project's account that hold USB
   * devices with `ADB_USB=0` (emulator connections are registered again).
   * False when the target gave no answer (the sweep is retried sooner).
   */
  private async legacyUsbOff(
    project: string,
    machine: string,
    p: AdbSlotPolicy,
    probe: AdbProbe,
    clock: () => string,
  ) {
    const result = await probe({
      action: "usb_off",
      project,
      machine,
      generation: randomUUID(),
      adb_ports: p.legacyAdbPorts,
      emulator_ports: [],
    });
    if (!result) return false;
    if (result.found)
      this.store.uow.run((tx) =>
        this.event(tx, project, "machine_adb_legacy_usb_released", clock(), {
          machine,
          legacy: true,
          restarted: result.found - result.left,
          failed: result.left,
          reconnected: result.reconnected ?? 0,
          missing: result.missing ?? 0,
        }),
      );
    return true;
  }
  /** A Run on this machine that may still use a fixed port from before C-679. */
  private legacyInUse(tx: ReadRepositories, machine: string, p: AdbSlotPolicy) {
    for (const project of this.store.listProjects()) {
      const pending = new Set(
        unfinishedBellAttempts(this.store.database, project.id).map(
          (b) => b.run_id,
        ),
      );
      for (const run of tx.runs.list(project.id)) {
        if (!runOccupiesSlot(run) && !pending.has(run.id)) continue;
        if (
          run.resource_keys &&
          !run.resource_keys.some((k) => p.resources.has(k))
        )
          continue;
        if (
          tx.assignments.get(project.id, run.assignment_id)?.machine_id !==
          machine
        )
          continue;
        if (
          !this.store.database
            .prepare(
              "SELECT 1 FROM machine_adb_slots WHERE project=? AND run_id=? LIMIT 1",
            )
            .get(project.id, run.id)
        )
          return true;
      }
    }
    return false;
  }
  /**
   * C-844: emulator processes of this project's account that no live Run
   * slot of the project covers (a Run started one without an emulator lease,
   * or someone did by hand). They are recorded for host diagnostics and the
   * capacity view; when the machine's emulator is reserved by another
   * project (closed by the owner) or the machine is over its emulator slots
   * counting them, they are stopped by PID and the Run's card (when the
   * process names its Run) is told. No answer from the target: next sweep.
   */
  private async unregisteredEmulators(
    project: string,
    machine: string,
    p: AdbSlotPolicy,
    probe: AdbProbe,
    clock: () => string,
    legacy: boolean,
  ) {
    const listed = await probe({
      action: "emulators",
      project,
      machine,
      generation: randomUUID(),
      adb_ports: [],
      emulator_ports: [],
    });
    if (!listed?.emulators) return;
    const plan = this.store.uow.read(() => {
      const live = this.live(machine).filter((r) => r.purpose === "run");
      const covered = new Set(
        live
          .filter((r) => r.project === project && r.emulator && r.emulator_port)
          .map((r) => r.emulator_port as number),
      );
      // A Run holding an emulator slot owns its emulator even on another port.
      const holders = new Set(
        live
          .filter((r) => r.project === project && r.emulator && r.run_id)
          .map((r) => `${r.assignment_id}.${r.run_id}`),
      );
      // Fixed ports a Run from before C-679 may still use are not strays.
      if (legacy) for (const port of p.legacyEmulatorPorts) covered.add(port);
      const stray = (listed.emulators ?? []).filter(
        (e) =>
          !(e.session && holders.has(e.session)) &&
          (e.port === undefined || !covered.has(e.port)),
      );
      if (!stray.length) return { stray };
      const policy = this.emulatorPolicy?.(project, machine, clock()) ?? {
        limit: 0,
      };
      const reason: EmulatorStopReason | undefined = policy.reservation
        ? "reserved"
        : live.filter((r) => r.emulator).length + emulatorInstances(stray) >
            policy.limit
          ? "over_limit"
          : undefined;
      return { stray, reason, reservation: policy.reservation };
    });
    const stopped =
      plan.reason && plan.stray.length
        ? await probe({
            action: "emulator_stop",
            project,
            machine,
            generation: randomUUID(),
            adb_ports: [],
            emulator_ports: [],
            pids: plan.stray.map((e) => [e.pid, e.started] as const),
          })
        : undefined;
    this.store.uow.run((tx) => {
      const at = clock();
      const db = this.store.database;
      const known = new Map(
        (
          db
            .prepare(
              "SELECT pid,started,stop_failed_at FROM machine_unregistered_emulators WHERE project=? AND machine=?",
            )
            .all(project, machine) as {
            pid: number;
            started: string;
            stop_failed_at: string | null;
          }[]
        ).map((r) => [`${r.pid}:${r.started}`, r]),
      );
      const gone = !!stopped && stopped.left === 0;
      const keep = gone ? [] : plan.stray;
      const kept = new Set(keep.map((e) => `${e.pid}:${e.started}`));
      for (const key of known.keys())
        if (!kept.has(key)) {
          const [pid, started] = [
            key.slice(0, key.indexOf(":")),
            key.slice(key.indexOf(":") + 1),
          ];
          db.prepare(
            "DELETE FROM machine_unregistered_emulators WHERE project=? AND machine=? AND pid=? AND started=?",
          ).run(project, machine, Number(pid), started);
        }
      const runs = new Map<string, { assignment: string; card?: string }>();
      for (const e of plan.stray) {
        const owner = this.sessionRun(tx, project, e.session);
        if (owner) runs.set(owner.run, owner);
      }
      const failed = !!plan.reason && !gone;
      for (const e of keep) {
        const owner = this.sessionRun(tx, project, e.session);
        const prior = known.get(`${e.pid}:${e.started}`);
        db.prepare(
          "INSERT INTO machine_unregistered_emulators (project,machine,pid,started,kind,port,assignment_id,run_id,first_seen_at,last_seen_at,stop_reason,stop_failed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project,machine,pid,started) DO UPDATE SET last_seen_at=excluded.last_seen_at, stop_reason=excluded.stop_reason, stop_failed_at=excluded.stop_failed_at",
        ).run(
          project,
          machine,
          e.pid,
          e.started,
          e.kind,
          e.port ?? null,
          owner?.assignment ?? null,
          owner?.run ?? null,
          at,
          at,
          plan.reason ?? null,
          failed ? (prior?.stop_failed_at ?? at) : null,
        );
      }
      const fresh = plan.stray.some((e) => !known.has(`${e.pid}:${e.started}`));
      const newlyFailed =
        failed &&
        plan.stray.some(
          (e) => !known.get(`${e.pid}:${e.started}`)?.stop_failed_at,
        );
      if (!(fresh || gone || newlyFailed)) return;
      // Events name the machine and Runs, never ports or PIDs (C-497).
      this.event(tx, project, "machine_emulator_unregistered", at, {
        machine,
        instances: emulatorInstances(plan.stray),
        action: gone ? "stopped" : failed ? "stop_failed" : "observed",
        ...(plan.reason ? { reason: plan.reason } : {}),
        ...(plan.reservation ? { reservation: plan.reservation } : {}),
        ...(runs.size ? { run_ids: [...runs.keys()].join(",") } : {}),
      });
      if (!gone || !plan.reason) return;
      const why =
        plan.reason === "reserved" && plan.reservation
          ? `${STOP_TEXT.reserved}（预约 ${plan.reservation}）`
          : STOP_TEXT[plan.reason];
      for (const [run, owner] of runs)
        if (owner.card)
          this.cardNote(
            tx,
            project,
            owner.card,
            at,
            {
              machine,
              run_id: run,
              assignment_id: owner.assignment,
              reason: plan.reason,
            },
            `系统巡检在 ${machine} 上发现 ${run}（${owner.assignment}）自己启动的模拟器：这个 Run 没有模拟器租约，${why}，已按进程停掉。环境里没有 CARDIGAN_EMULATOR_PORT 或 CARDIGAN_DEVICE_SERIAL 时不能自己起模拟器；需要设备时请 PM 建要求 android.any 的工作项。`,
          );
    });
  }
  /** The Run (and its card) an emulator's `CARDIGAN_RESOURCE_SESSION` names, when it is this project's. */
  private sessionRun(
    tx: ReadRepositories,
    project: string,
    session: string | undefined,
  ) {
    if (!session) return;
    const dot = session.indexOf(".");
    const assignment = session.slice(0, dot),
      run = session.slice(dot + 1);
    const r = tx.runs.get(project, run as Run["id"]);
    if (!r || r.assignment_id !== assignment) return;
    const a = tx.assignments.get(project, assignment as Assignment["id"]);
    const card = a?.work_item_id
      ? tx.work_items.get(project, a.work_item_id)?.card_id
      : undefined;
    return { run, assignment, ...(card ? { card: String(card) } : {}) };
  }
  private cardNote(
    tx: StoreTransactionContext,
    project: string,
    card: string,
    at: string,
    payload: Record<string, string>,
    body: string,
  ) {
    const cardId = card as CardId;
    if (!tx.cards.get(project, cardId)) return;
    const seq = tx.ids.nextEventSequence(project, cardId);
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      card_id: cardId,
      seq,
      actor: { kind: "system", project_id: project },
      type: "machine_emulator_stopped",
      created_at: at,
      payload,
    });
    const id = tx.ids.nextTimelineEntryId(project, cardId);
    tx.timeline.put(project, {
      id,
      short_id: id,
      card_id: cardId,
      event_seq: seq,
      type: "system",
      author: "system",
      created_at: at,
      refs: [{ kind: "run", id: payload.run_id as Run["id"] }],
      mentions: [],
      retracted: false,
      body,
    });
  }
  /** Host diagnostics: every slot of the machine and who holds it. */
  diagnostics(machine: string): AdbSlotDiagnostic[] | undefined {
    const p = this.config.adbSlots(machine);
    if (!p) return undefined;
    const rows = this.live(machine);
    const result: AdbSlotDiagnostic[] = [];
    for (let slot = 0; slot < p.count; slot++) {
      const row = rows.find((r) => r.slot === slot);
      const ports = this.ports(p, slot);
      result.push(
        row
          ? {
              slot,
              adb_port: row.adb_port,
              ...(row.emulator_port
                ? { emulator_port: row.emulator_port }
                : {}),
              state: row.release_state
                ? "release_pending"
                : row.purpose === "sweep"
                  ? "sweep"
                  : "run",
              project: row.project,
              ...(row.assignment_id
                ? { assignment_id: row.assignment_id }
                : {}),
              ...(row.run_id ? { run_id: row.run_id } : {}),
              since: row.acquired_at,
              ...(row.release_state
                ? { release_state: row.release_state }
                : {}),
            }
          : { slot, ...ports, state: "free" },
      );
    }
    // Rows left from an earlier, larger pool still hold their ports.
    for (const row of rows.filter((r) => r.slot >= p.count))
      result.push({
        slot: row.slot,
        adb_port: row.adb_port,
        ...(row.emulator_port ? { emulator_port: row.emulator_port } : {}),
        state: "release_pending",
        project: row.project,
        ...(row.run_id ? { run_id: row.run_id } : {}),
        since: row.acquired_at,
        ...(row.release_state ? { release_state: row.release_state } : {}),
      });
    return result;
  }
}

/** adb device types (C-813 providers with `needs_adb_slot`) these slots hand out. */
export function usbDeviceTypes(p: AdbSlotPolicy) {
  return DEVICE_PROVIDERS.filter(
    (d) => d.needs_adb_slot && p.resources.has(d.type),
  ).map((d) => d.type);
}

/**
 * C-679 compatibility: a worker binding that still pins ANDROID_ADB_SERVER_PORT
 * on a machine with adb slots. Launch drops the pinned value (each Run gets
 * its own port); these lines tell the operator to remove it. No values.
 */
export function adbEnvironmentWarnings(
  workers: readonly {
    machine_id: string;
    project_id: string;
    execution: { env?: Readonly<Record<string, string>> };
  }[],
  config: Config,
): string[] {
  return workers
    .filter(
      (w) =>
        w.execution.env?.ANDROID_ADB_SERVER_PORT !== undefined &&
        config.adbSlots(w.machine_id),
    )
    .map(
      (w) =>
        `runtime-workers.yaml：${w.project_id} 在 ${w.machine_id} 上仍写死 ANDROID_ADB_SERVER_PORT。该机器已按 Run 分配 adb 端口，启动时忽略这一项，请删除。`,
    );
}

/**
 * C-844: running VMs among emulator processes: one per qemu process, plus a
 * launcher on a console port no listed qemu uses (still starting up).
 */
export function emulatorInstances(
  processes: readonly Pick<EmulatorProcess, "kind" | "port" | "pid">[],
): number {
  const keys = new Set<string>();
  for (const e of processes)
    if (e.kind === "qemu")
      keys.add(e.port === undefined ? `pid:${e.pid}` : `port:${e.port}`);
  for (const e of processes)
    if (e.kind === "launcher" && e.port !== undefined)
      keys.add(`port:${e.port}`);
  return keys.size || (processes.length ? 1 : 0);
}

/** C-844: the latest unregistered emulators the sweep saw, oldest first. */
export function listUnregisteredEmulators(
  db: Store["database"],
  filter: { readonly project?: string; readonly machine?: string } = {},
): UnregisteredEmulator[] {
  const where: string[] = [],
    args: string[] = [];
  if (filter.project !== undefined) {
    where.push("project=?");
    args.push(filter.project);
  }
  if (filter.machine !== undefined) {
    where.push("machine=?");
    args.push(filter.machine);
  }
  return (
    db
      .prepare(
        `SELECT * FROM machine_unregistered_emulators${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY machine,project,first_seen_at,pid`,
      )
      .all(...args) as Record<string, unknown>[]
  ).map((r) => ({
    project: String(r.project),
    machine: String(r.machine),
    pid: Number(r.pid),
    kind: r.kind === "qemu" ? "qemu" : "launcher",
    ...(r.port === null ? {} : { port: Number(r.port) }),
    ...(r.assignment_id === null
      ? {}
      : { assignment_id: String(r.assignment_id) }),
    ...(r.run_id === null ? {} : { run_id: String(r.run_id) }),
    first_seen_at: String(r.first_seen_at),
    last_seen_at: String(r.last_seen_at),
    ...(r.stop_reason === "reserved" || r.stop_reason === "over_limit"
      ? { stop_reason: r.stop_reason }
      : {}),
    ...(r.stop_failed_at === null
      ? {}
      : { stop_failed_at: String(r.stop_failed_at) }),
  }));
}
