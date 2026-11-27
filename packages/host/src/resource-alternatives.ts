import {
  type Assignment,
  type MachineResources,
  remainingResourceRatio,
  resolveCapabilityAlternatives,
  unresolvedAlternatives,
} from "@cardigan/domain";
import {
  readMachineObservationsInTransaction,
  type Store,
} from "@cardigan/store";
import { withDeviceResources } from "./device-providers.js";
import type { MachineLeases } from "./resource-leases.js";

/** The parts of a capacity snapshot (`runCapacitySnapshot`) the choice reads. */
export interface AlternativeCapacity {
  resourcesForMachine(machine: string): MachineResources;
  withinProjectQuota(
    project: string,
    owner: Assignment,
    keys?: readonly string[],
  ): boolean;
}

/**
 * C-815: resolve `android.any` (and any other alternative) among a Run's
 * resource keys to one option on the Assignment's machine, before inspection
 * and again inside the claim (same inputs, same answer).
 *
 * An option is `free` when the machine's current check verified it, its
 * resource slots and the project quota have room, and the machine leases
 * (device lease, adb slot, reservations) do not block it; `supported` when
 * only the verification holds. The claimed keys keep the alternative and add
 * the option, so capacity, adb slots and device leases see the option exactly
 * as if the work item had asked for it. Keys without an unresolved
 * alternative are returned unchanged and nothing is read.
 */
export function resolveResourceAlternatives(
  store: Store,
  project: string,
  owner: Assignment,
  keys: readonly string[],
  now: string,
  capacity: () => AlternativeCapacity,
  leases?: MachineLeases,
): string[] {
  if (!unresolvedAlternatives(keys).length) return [...keys];
  const machine = owner.machine_id;
  const verified = new Set(
    readMachineObservationsInTransaction(store, project, machine, now)
      .capabilities.filter((c) => c.available)
      .map((c) => c.key),
  );
  const snapshot = capacity();
  const slots = snapshot.resourcesForMachine(machine);
  return resolveCapabilityAlternatives(keys, (candidate, option) => {
    if (!verified.has(option)) return "unsupported";
    const expanded = withDeviceResources(candidate);
    return remainingResourceRatio(expanded, slots) > 0 &&
      snapshot.withinProjectQuota(project, owner, expanded) &&
      !leases?.blocked(project, machine, expanded, now)
      ? "free"
      : "supported";
  });
}
