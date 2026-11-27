import type {
  DeviceObservation,
  DeviceRegistration,
  DeviceState,
  RunId,
} from "@cardigan/domain";
import {
  readMachineObservationsInTransaction,
  type Store,
} from "@cardigan/store";
import { DeviceLeases } from "./device-leases.js";
import { DeviceRegistry, machineProjects } from "./device-registry.js";

/** C-818: who holds a device right now (a live C-813 lease). */
export interface DeviceHolder {
  readonly project: string;
  readonly run_id: string;
  readonly assignment_id: string;
  readonly since: string;
  /** The holder's card, only when it is in the project reading the list. */
  readonly card_id?: string;
}

/**
 * C-818: one row of the device list (settings page and `cardigan machine
 * device list` alike): the registration, the projects it may be given to,
 * what the reading project's latest machine check saw and the live holder.
 */
export interface DeviceListEntry extends DeviceRegistration {
  readonly choices: readonly string[];
  /**
   * The reading project's current listing: the device's state there, or
   * `missing` when the listing no longer has it (unplugged). Absent when the
   * project has no current listing of that device type on the machine (never
   * checked, the check or the provider's listing failed, or it is too old):
   * nothing is claimed about the device then.
   */
  readonly state?: DeviceState | "missing";
  readonly holder?: DeviceHolder;
}

/**
 * The devices of one machine (or of every machine) as `project` sees them.
 * Every value comes from the records the host itself uses: the registry, this
 * project's machine check (judged like the C-817 loss reminder) and the
 * live leases.
 */
export function deviceList(
  store: Store,
  project: string,
  machine: string | undefined,
  now: string,
): DeviceListEntry[] {
  const registrations = new DeviceRegistry(store).list(machine);
  const machines = [...new Set(registrations.map((r) => r.machine))];
  const leases = new DeviceLeases(store, { adbSlots: () => undefined });
  const fixed = new Map(
    machines.map((m) => [
      m,
      { choices: machineProjects(store, m), leases: leases.diagnostics(m) },
    ]),
  );
  return store.uow.read((tx) => {
    const listings = new Map<
      string,
      { devices: readonly DeviceObservation[]; failed: Set<string> }
    >();
    for (const m of machines) {
      if (!tx.machines.get(project, m)) continue;
      const health = readMachineObservationsInTransaction(
        store,
        project,
        m,
        now,
      ).health;
      if (health?.available)
        listings.set(m, {
          devices: health.devices ?? [],
          failed: new Set(health.capability_failures?.map((f) => f.key)),
        });
    }
    const cardOf = (run: string) => {
      const found = tx.runs.get(project, run as RunId);
      const assignment =
        found && tx.assignments.get(project, found.assignment_id);
      return assignment?.work_item_id
        ? tx.work_items.get(project, assignment.work_item_id)?.card_id
        : undefined;
    };
    return registrations.map((reg): DeviceListEntry => {
      const at = fixed.get(reg.machine);
      const listing = listings.get(reg.machine);
      const lease = at?.leases.find(
        (l) => l.type === reg.type && l.device === reg.id,
      );
      const card =
        lease && lease.project === project ? cardOf(lease.run_id) : undefined;
      return {
        ...reg,
        choices: at?.choices ?? [],
        ...(listing && !listing.failed.has(reg.type)
          ? {
              state:
                listing.devices.find(
                  (d) => d.type === reg.type && d.id === reg.id,
                )?.state ?? "missing",
            }
          : {}),
        ...(lease
          ? {
              holder: {
                project: lease.project,
                run_id: lease.run_id,
                assignment_id: lease.assignment_id,
                since: lease.since,
                ...(card ? { card_id: card } : {}),
              },
            }
          : {}),
      };
    });
  });
}
