import { randomUUID } from "node:crypto";
import {
  type Assignment,
  chooseDevice,
  type DeviceObservation,
  deviceResourceName,
  isDeviceKey,
  type Run,
  runOccupiesSlot,
} from "@cardigan/domain";
import {
  type ReadRepositories,
  readMachineObservationsInTransaction,
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
} from "@cardigan/store";
import type { AdbSlotPolicy } from "./adb-slots.js";
import {
  DEVICE_PROVIDERS,
  type HostDeviceProvider,
} from "./device-providers.js";

/**
 * C-813: exclusive leases on single devices (`<type>:<id>`, capacity 1).
 *
 * A Run requiring a device type gets, in the same transaction as its other
 * resources, one device of the project's current machine check that no live
 * lease holds and no other project has reserved. A partial unique index keeps
 * any two live leases (across projects) off the same device. The lease ends
 * once the Run has ended and no launch of it is pending, and, for devices
 * used through adb, only after the Run's own adb slot has been closed.
 */
interface Row {
  generation: string;
  machine: string;
  type: string;
  device: string;
  project: string;
  assignment_id: string;
  run_id: Run["id"];
  acquired_at: string;
  released_at: string | null;
}
export interface DeviceLeaseDiagnostic {
  readonly type: string;
  readonly device: string;
  readonly project: string;
  readonly assignment_id: string;
  readonly run_id: string;
  readonly since: string;
}
type Config = { adbSlots(machine: string): AdbSlotPolicy | undefined };
/** Another project holds this `<type>:<id>` by reservation right now. */
export type ReservedElsewhere = (
  project: string,
  machine: string,
  resource: string,
  now: string,
) => boolean;

/** Devices of a type some live lease on this machine holds (any project). */
export function heldDevices(store: Store, machine: string, type: string) {
  return new Set(
    (
      store.database
        .prepare(
          "SELECT device FROM machine_device_leases WHERE machine=? AND type=? AND released_at IS NULL",
        )
        .all(machine, type) as { device: string }[]
    ).map((r) => r.device),
  );
}

export class DeviceLeases {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly reservedElsewhere: ReservedElsewhere = () => false,
    private readonly providers: readonly HostDeviceProvider[] = DEVICE_PROVIDERS,
  ) {}
  /** Providers these resource keys ask a device of. */
  required(keys: readonly string[]) {
    return this.providers.filter((p) =>
      keys.some((k) => isDeviceKey(p.type, k)),
    );
  }
  private held(project: string, run: string): Row[] {
    return this.store.database
      .prepare(
        "SELECT * FROM machine_device_leases WHERE project=? AND run_id=? AND released_at IS NULL ORDER BY type",
      )
      .all(project, run) as unknown as Row[];
  }
  private observed(project: string, machine: string, now: string) {
    const health = readMachineObservationsInTransaction(
      this.store,
      project,
      machine,
      now,
    ).health;
    return health?.available ? (health.devices ?? []) : [];
  }
  private choose(
    project: string,
    machine: string,
    provider: HostDeviceProvider,
    keys: readonly string[],
    now: string,
  ): DeviceObservation | undefined {
    const taken = heldDevices(this.store, machine, provider.type);
    const devices = this.observed(project, machine, now).filter(
      (d) =>
        d.type === provider.type &&
        !this.reservedElsewhere(
          project,
          machine,
          deviceResourceName(d.type, d.id),
          now,
        ),
    );
    return chooseDevice(provider.type, devices, keys, taken);
  }
  /** adb device types this machine's adb slots hand out. */
  adbTypes(machine: string) {
    const policy = this.config.adbSlots(machine);
    return this.providers
      .filter((p) => p.needs_adb_slot && policy?.resources.has(p.type))
      .map((p) => p.type);
  }
  private unsupported(machine: string, provider: HostDeviceProvider) {
    if (
      provider.needs_adb_slot &&
      !this.config.adbSlots(machine)?.resources.has(provider.type)
    )
      return `${provider.label}：本机 adb_slots 未包含 ${provider.type}`;
  }
  /** A reason this Run cannot get its devices now, if any. */
  blocked(
    project: string,
    machine: string,
    keys: readonly string[],
    now: string,
    own?: { run: string },
  ) {
    const held = own ? this.held(project, own.run) : [];
    for (const provider of this.required(keys)) {
      const unsupported = this.unsupported(machine, provider);
      if (unsupported) return unsupported;
      if (held.some((r) => r.type === provider.type)) continue;
      if (!this.choose(project, machine, provider, keys, now))
        return `${provider.label}：没有空闲的可用设备，等待释放或重新检查机器`;
    }
  }
  /** Inside the claim transaction; a Run that already holds its devices keeps them. */
  acquire(
    tx: StoreTransactionContext,
    project: string,
    a: Assignment,
    run: Run,
    keys: readonly string[],
    now: string,
  ): DeviceObservation[] {
    const result: DeviceObservation[] = [];
    const held = this.held(project, run.id);
    for (const provider of this.required(keys)) {
      if (this.unsupported(a.machine_id, provider))
        throw new Error("设备配置不支持");
      const prior = held.find(
        (r) => r.type === provider.type && r.machine === a.machine_id,
      );
      if (prior) {
        result.push(this.device(project, prior, now));
        continue;
      }
      const device = this.choose(project, a.machine_id, provider, keys, now);
      if (!device) throw new Error("没有空闲设备");
      const generation = randomUUID();
      this.store.database
        .prepare(
          "INSERT INTO machine_device_leases (generation,machine,type,device,project,assignment_id,run_id,acquired_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          generation,
          a.machine_id,
          provider.type,
          device.id,
          project,
          a.id,
          run.id,
          now,
        );
      this.event(tx, project, "machine_device_acquired", now, {
        generation,
        machine: a.machine_id,
        resource: deviceResourceName(provider.type, device.id),
        assignment_id: a.id,
        run_id: run.id,
      });
      result.push(device);
    }
    return result;
  }
  /** What was last observed about a held device (the id at least). */
  private device(project: string, row: Row, now: string): DeviceObservation {
    return (
      this.observed(project, row.machine, now).find(
        (d) => d.type === row.type && d.id === row.device,
      ) ?? { type: row.type, id: row.device, state: "in_use" }
    );
  }
  /** The devices this Run's launch environment must name. */
  launchDevices(project: string, machine: string, run: string, now: string) {
    return this.held(project, run)
      .filter((r) => r.machine === machine)
      .map((r) => this.device(project, r, now));
  }
  /** Every type this Run needs is held (relaunch and publication checks). */
  holds(project: string, run: string, keys: readonly string[]) {
    const held = this.held(project, run);
    return this.required(keys).every((p) =>
      held.some((r) => r.type === p.type),
    );
  }
  private event(
    tx: StoreTransactionContext,
    project: string,
    type: string,
    at: string,
    payload: Record<string, string>,
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
  /**
   * The Run ended (any way), no launch of it is pending (or it is gone), and
   * it holds no live adb slot any more: its own adb server, which may still
   * hold the device, has been closed.
   */
  private ended(tx: ReadRepositories, row: Row) {
    const run = tx.runs.get(row.project, row.run_id);
    const finished =
      !run ||
      (["completed", "failed", "cancelled", "queued"].includes(run.status) &&
        !runOccupiesSlot(run) &&
        !unfinishedBellAttempts(this.store.database, row.project).some(
          (b) => b.run_id === run.id,
        ));
    return (
      finished &&
      !this.store.database
        .prepare(
          "SELECT 1 FROM machine_adb_slots WHERE project=? AND run_id=? AND released_at IS NULL LIMIT 1",
        )
        .get(row.project, row.run_id)
    );
  }
  /** Release leases of ended Runs (database only; no device action). */
  reconcile(project: string, clock: () => string) {
    const due = this.store.database
      .prepare(
        "SELECT * FROM machine_device_leases WHERE project=? AND released_at IS NULL",
      )
      .all(project) as unknown as Row[];
    if (!due.length) return;
    this.store.uow.run((tx) => {
      const at = clock();
      for (const row of due) {
        if (!this.ended(tx, row)) continue;
        if (
          !this.store.database
            .prepare(
              "UPDATE machine_device_leases SET released_at=? WHERE generation=? AND released_at IS NULL",
            )
            .run(at, row.generation).changes
        )
          continue;
        this.event(tx, project, "machine_device_released", at, {
          generation: row.generation,
          machine: row.machine,
          resource: deviceResourceName(row.type, row.device),
          run_id: row.run_id,
        });
      }
    });
  }
  /** Host diagnostics: who holds which device on this machine. */
  diagnostics(machine: string): DeviceLeaseDiagnostic[] {
    return (
      this.store.database
        .prepare(
          "SELECT * FROM machine_device_leases WHERE machine=? AND released_at IS NULL ORDER BY type, device",
        )
        .all(machine) as unknown as Row[]
    ).map((r) => ({
      type: r.type,
      device: r.device,
      project: r.project,
      assignment_id: r.assignment_id,
      run_id: r.run_id,
      since: r.acquired_at,
    }));
  }
}
