import {
  alternativeCapabilities,
  type DeviceObservation,
  deviceCapabilities,
  deviceEnabledFor,
  isAlternativeCapability,
  isDeviceKey,
  type Machine,
  mergeHeldDevices,
} from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import {
  type MachineCapability,
  readMachineObservations,
  readMachineObservationsInTransaction,
  recordMachineDevices,
  type Store,
} from "@cardigan/store";
import { syncDeviceActions } from "./device-enablement.js";
import { heldDevices } from "./device-leases.js";
import {
  DEVICE_PROVIDERS,
  type HostDeviceProvider,
} from "./device-providers.js";
import { DeviceRegistry } from "./device-registry.js";
import {
  type CapabilityProbe,
  probeMachineCapability,
} from "./machine-capability-probe.js";
import { observationFingerprint } from "./worker-helper-release.js";

/**
 * C-841: a device that is unplugged or loses its authorization must stop
 * being handed out within minutes, not at the next 30-minute machine check.
 *
 * Between machine checks, every `DEVICE_PRESENCE_INTERVAL_MS` the host asks,
 * for each device enabled for the project on the machine and held by no live
 * lease (of any project), whether it is still there. The provider's presence
 * check touches only that one device (Android: a throw-away adb server on a
 * free loopback port started with `--one-device <serial>`), so a device a Run
 * holds, the Run's own adb server, emulators and other projects' servers are
 * left alone, and no adb client is run against a slot port. The answer
 * updates the current observation in place: the device listing and the
 * device capability keys (`recordMachineDevices`). Leases, machine selection
 * and `android.any` read exactly these records, so a missing device gets no
 * new lease and an `android.any` Run takes the emulator instead; the loss
 * reminder follows (`syncDeviceActions`) and closes once the device is back.
 *
 * Discovery of new devices, initialization and everything else stay with the
 * machine check. Without a passed current observation that listed devices,
 * nothing is checked.
 */
export const DEVICE_PRESENCE_INTERVAL_MS = 60 * 1000;
/** Devices checked per provider, project and machine in one round (by id). */
export const DEVICE_PRESENCE_MAX_PER_ROUND = 4;

export interface DevicePresenceOptions {
  readonly store: Store;
  readonly project: string;
  readonly machine: string;
  readonly target: () =>
    | { readonly execution: ExecutionConfig; readonly machine: Machine }
    | Promise<{
        readonly execution: ExecutionConfig;
        readonly machine: Machine;
      }>;
  readonly probe?: CapabilityProbe;
  readonly providers?: readonly HostDeviceProvider[];
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}

export interface DevicePresenceOutcome {
  /** Devices whose presence was asked. */
  readonly checked: number;
  /** The observation was updated with the answers. */
  readonly recorded: boolean;
  /** A device's listed state changed. */
  readonly changed: boolean;
}

const NONE: DevicePresenceOutcome = {
  checked: 0,
  recorded: false,
  changed: false,
};
const PREFIX = "machine-observation:";

export async function refreshDevicePresence(
  options: DevicePresenceOptions,
): Promise<DevicePresenceOutcome> {
  const { store, project, machine } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const providers = (options.providers ?? DEVICE_PROVIDERS).filter(
    (p) => p.presence,
  );
  if (!providers.length) return NONE;
  const observed = readMachineObservations(store, project, machine, now());
  const health = observed.health;
  if (!health?.available || !health.devices) return NONE;
  const observation = health.evidence_ref.slice(PREFIX.length);
  const verified = new Set(
    observed.capabilities.filter((c) => c.available).map((c) => c.key),
  );
  const registry = new DeviceRegistry(store);
  const due = providers.flatMap((provider) =>
    (provider.requires_capability &&
      !verified.has(provider.requires_capability)) ||
    health.capability_failures?.some((f) => f.key === provider.type)
      ? []
      : [
          {
            provider,
            devices: registry
              .list(machine)
              .filter(
                (r) => r.type === provider.type && deviceEnabledFor(r, project),
              )
              .map((r) => r.id)
              .sort(),
          },
        ],
  );
  if (!due.some((d) => d.devices.length)) return NONE;
  let target: Awaited<ReturnType<DevicePresenceOptions["target"]>>;
  try {
    target = await options.target();
  } catch {
    return NONE;
  }
  // Only through the binding this observation was made with.
  const expected = observationFingerprint(
    target.execution.target?.fingerprint,
    target.machine,
  );
  if (
    expected &&
    !store.uow.read(
      () =>
        readMachineObservationsInTransaction(
          store,
          project,
          machine,
          now(),
          expected,
        ).observation_target_matches,
    )
  )
    return NONE;
  const probe = options.probe ?? probeMachineCapability;
  const answers = new Map<string, Map<string, DeviceObservation | "missing">>();
  let checked = 0;
  for (const { provider, devices } of due) {
    if (!provider.os.includes(target.machine.os)) continue;
    const found = new Map<string, DeviceObservation | "missing">();
    let asked = 0;
    for (const id of devices) {
      if (asked >= DEVICE_PRESENCE_MAX_PER_ROUND) break;
      options.signal?.throwIfAborted();
      // Read right before each check: a device leased meanwhile is not touched.
      if (heldDevices(store, machine, provider.type).has(id)) continue;
      asked += 1;
      let answer: DeviceObservation | "missing" | undefined;
      try {
        answer = await provider.presence?.(
          {
            execution: target.execution,
            os: target.machine.os,
            probe,
            ...(options.signal ? { signal: options.signal } : {}),
          },
          { type: provider.type, id },
        );
      } catch {
        answer = undefined;
      }
      if (answer !== undefined) found.set(id, answer);
    }
    checked += asked;
    if (found.size) answers.set(provider.type, found);
  }
  if (!answers.size) return { ...NONE, checked };
  let changed = false;
  const at = now();
  const recorded = recordMachineDevices(
    store,
    { kind: "system", project_id: project },
    project,
    machine,
    observation,
    (current) => {
      const before = current.health.devices ?? [];
      let devices = before.filter((d) => !answers.has(d.type));
      const keys = new Set(
        current.capabilities
          .map((c) => c.key)
          .filter(
            (k) =>
              !isAlternativeCapability(k) &&
              ![...answers.keys()].some((type) => isDeviceKey(type, k)),
          ),
      );
      const add: MachineCapability[] = [];
      for (const [type, found] of answers) {
        const previous = before.filter((d) => d.type === type);
        const listed = mergeHeldDevices(
          [
            ...previous.filter((d) => !found.has(d.id)),
            ...[...found.values()].filter(
              (a): a is DeviceObservation => a !== "missing" && a.type === type,
            ),
          ],
          previous,
          heldDevices(store, machine, type),
        );
        if (JSON.stringify(listed) !== JSON.stringify(previous)) changed = true;
        devices = [...devices, ...listed];
        const enabled = listed.filter((d) =>
          deviceEnabledFor(registry.get(machine, d.type, d.id), project),
        );
        for (const key of deviceCapabilities(enabled)) {
          keys.add(key);
          add.push({
            key,
            version: null,
            verified_at: at,
            evidence_ref: `${PREFIX}${observation}#${type}`,
          });
        }
      }
      // An alternative (安卓设备任一) holds while any option does.
      const alternatives = alternativeCapabilities([...keys]);
      for (const key of alternatives)
        if (!current.capabilities.some((c) => c.key === key))
          add.push({
            key,
            version: null,
            verified_at: at,
            evidence_ref: `${PREFIX}${observation}#${key}`,
          });
      const remove = current.capabilities
        .map((c) => c.key)
        .filter(
          (k) =>
            (isAlternativeCapability(k) && !alternatives.includes(k)) ||
            ([...answers.keys()].some((type) => isDeviceKey(type, k)) &&
              !add.some((c) => c.key === k)),
        );
      return {
        devices,
        checked_at: at,
        remove,
        add,
      };
    },
  );
  // The loss reminder is judged every round: work may start waiting on a
  // device that was already gone.
  if (recorded)
    try {
      syncDeviceActions(store, project, machine, { now });
    } catch {
      // A failed to-do write never invalidates the recorded presence.
    }
  return { checked, recorded, changed: recorded && changed };
}
