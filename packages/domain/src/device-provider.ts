/**
 * C-813: external test devices (USB Android devices first; later iOS devices,
 * handhelds, controllers...) as schedulable resources.
 *
 * A device provider is a port: the host implements how to list one machine's
 * devices and what a Run holding a device receives. These pure rules are what
 * every provider shares, so each new provider only adds its listing and its
 * session environment:
 *
 * - every device is a resource of capacity 1 named `<type>:<device id>`;
 * - devices roll up into the type-level capability (`android.device`), plus
 *   `<type>:<id>` and `<type>.model.<model>` for narrowing;
 * - a work item asks for the type, optionally narrowed by id or model, and
 *   always also takes one slot of the type's quota;
 * - only strictly validated fields of a listing are ever kept (it is worker
 *   output), and a device another Run holds stays listed as `in_use`.
 *
 * No IO here (§20.2).
 */

/** What the controller shows: `available` is the only state that can be handed out (besides `in_use` by its holder). */
export const DEVICE_STATES = [
  "available",
  "unauthorized",
  "offline",
  "unavailable",
  "in_use",
] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];

export interface DeviceObservation {
  /** Provider type = type-level capability key, e.g. `android.device`. */
  readonly type: string;
  /** Provider-specific id (adb serial, UDID...). */
  readonly id: string;
  readonly state: DeviceState;
  readonly model?: string;
  /** OS version of the device, numeric dotted. */
  readonly version?: string;
}

/** One first-time setup step a person follows; the system never runs it. */
export interface DeviceSetupStep {
  readonly title: string;
  /** Optional command to run by hand; never contains credentials. */
  readonly command?: string;
}

/** C-817: one fixed initialization step a provider declares and the host runs. */
export interface DeviceInitStep {
  /** Stable key the provider's script reports a failure with. */
  readonly key: string;
  /** What the step does, shown in the enable prompt. */
  readonly title: string;
  /** What a person can do when this step fails. */
  readonly hint?: string;
}

/** What the session of a Run holding devices is given, per held device. */
export interface DeviceSessionContext {
  /** Serial of the emulator the same Run holds, when it holds one. */
  readonly emulator_serial?: string;
}

/**
 * The port a device provider implements in the host. `Target` is the host's
 * opaque handle on one machine (execution binding, OS, probe); the listing
 * runs as the project account there, never as a project file.
 */
export interface DeviceProviderPort<Target = unknown> {
  readonly type: string;
  /** Human label, e.g. 安卓真机. */
  readonly label: string;
  /** Platforms the provider can list on. */
  readonly os: readonly string[];
  /** Machine capability that must be verified before listing (e.g. `android.sdk`). */
  readonly requires_capability?: string;
  /** First-time setup a person follows (USB authorization...). Not executed. */
  readonly setup_steps: readonly DeviceSetupStep[];
  /**
   * C-817: fixed steps the host runs once a person enabled a device, listed
   * in the enable prompt. Providers without them enable devices directly.
   */
  readonly init_steps?: readonly DeviceInitStep[];
  /**
   * C-817: run exactly `init_steps` on `device` as the project account;
   * unvalidated result (see `normalizeDeviceInitResult`), `undefined` when
   * the attempt itself failed. Takes no caller-supplied commands.
   */
  initialize?(
    target: Target,
    device: DeviceObservation,
  ): Promise<unknown | undefined>;
  /** Devices currently visible, unvalidated; `undefined` when listing failed. */
  list(target: Target): Promise<readonly unknown[] | undefined>;
  /** Environment of a Run holding `device`; checked by `validateDeviceSessionEnv`. */
  sessionEnv(
    device: DeviceObservation,
    context: DeviceSessionContext,
  ): Readonly<Record<string, string>>;
  /** One short prompt rule for a Run holding `device`. */
  sessionRule(device: DeviceObservation, context: DeviceSessionContext): string;
}

export const MAX_DEVICES_PER_PROVIDER = 16;
const TYPE = /^[a-z][a-z0-9.-]{0,47}$/u;
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,63}$/u;
const VERSION = /^\d{1,3}(?:\.\d{1,3}){0,3}$/u;

export function isDeviceType(type: string) {
  return TYPE.test(type) && !type.includes(".model");
}

/** `<type>:<id>`: the resource (capacity 1) of one device. */
export function deviceResourceName(type: string, id: string) {
  if (!isDeviceType(type) || !DEVICE_ID_PATTERN.test(id))
    throw new Error("Invalid device resource");
  return `${type}:${id}`;
}

const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9._-]/gu, "-");
const modelKey = (type: string, model: string) =>
  `${type}.model.${slug(model)}`;

/**
 * Keep only fields that pass strict patterns; unknown states become
 * `unavailable`; duplicates keep the first; at most 16; sorted by id.
 * Listing output is worker data and never persisted unchecked.
 */
export function normalizeDeviceInventory(
  type: string,
  raw: readonly unknown[],
): DeviceObservation[] {
  if (!isDeviceType(type)) throw new Error("Invalid device type");
  const result = new Map<string, DeviceObservation>();
  for (const value of raw) {
    if (result.size >= MAX_DEVICES_PER_PROVIDER) break;
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const { id, state } = entry;
    if (typeof id !== "string" || !DEVICE_ID_PATTERN.test(id) || result.has(id))
      continue;
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    const version =
      typeof entry.version === "string" ? entry.version.trim() : "";
    result.set(id, {
      type,
      id,
      state: (DEVICE_STATES as readonly unknown[]).includes(state)
        ? (state as DeviceState)
        : "unavailable",
      ...(MODEL.test(model) ? { model } : {}),
      ...(VERSION.test(version) ? { version } : {}),
    });
  }
  return [...result.values()].sort(byId);
}

function byId(a: DeviceObservation, b: DeviceObservation) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Devices that can be handed to a Run (`in_use` only once its holder is gone). */
export function usableDevice(device: DeviceObservation) {
  return device.state === "available" || device.state === "in_use";
}

/**
 * A device held by a Run is usually invisible to (or unusable by) the
 * listing. Keep it as `in_use` with what was last known, so its machine keeps
 * the capability and later work queues for it instead of finding no machine.
 */
export function mergeHeldDevices(
  observed: readonly DeviceObservation[],
  previous: readonly DeviceObservation[] | undefined,
  held: ReadonlySet<string>,
): DeviceObservation[] {
  const result = new Map(observed.map((d) => [d.id, d]));
  for (const id of held) {
    const seen = result.get(id);
    const before = previous?.find((d) => d.id === id);
    const known = seen?.state === "available" ? seen : before;
    const type = seen?.type ?? before?.type;
    if (!type) continue;
    result.set(id, {
      type,
      id,
      state: "in_use",
      ...(known?.model ? { model: known.model } : {}),
      ...(known?.version ? { version: known.version } : {}),
    });
  }
  return [...result.values()].sort(byId);
}

/** Capability keys the usable devices of one listing provide on their machine. */
export function deviceCapabilities(
  devices: readonly DeviceObservation[],
): string[] {
  const keys = new Set<string>();
  for (const d of devices.filter(usableDevice)) {
    keys.add(d.type);
    keys.add(deviceResourceName(d.type, d.id));
    if (d.model) keys.add(modelKey(d.type, d.model));
  }
  return [...keys].sort();
}

/** Whether `key` asks for a device of `type` (plain, by id or by model). */
export function isDeviceKey(type: string, key: string) {
  return (
    key === type ||
    key.startsWith(`${type}:`) ||
    key.startsWith(`${type}.model.`)
  );
}

/** Every narrowing key for this device's type must name it. */
export function deviceMatches(
  device: DeviceObservation,
  keys: readonly string[],
) {
  const own = new Set([
    deviceResourceName(device.type, device.id),
    ...(device.model ? [modelKey(device.type, device.model)] : []),
  ]);
  return keys
    .filter((k) => isDeviceKey(device.type, k) && k !== device.type)
    .every((k) => own.has(k));
}

/** A narrowed device requirement also takes one slot of the type's quota. */
export function withDeviceTypes(
  keys: readonly string[],
  types: readonly string[],
): string[] {
  const result = [...keys];
  for (const type of types)
    if (keys.some((k) => isDeviceKey(type, k)) && !result.includes(type))
      result.push(type);
  return result;
}

/**
 * The device a Run requiring `keys` gets: the first by id that is usable,
 * held by no live lease, not reserved by another project (`<type>:<id>`
 * reservations), and matching every narrowing key.
 */
export function chooseDevice(
  type: string,
  devices: readonly DeviceObservation[],
  keys: readonly string[],
  unavailable: ReadonlySet<string>,
): DeviceObservation | undefined {
  if (!keys.some((k) => isDeviceKey(type, k))) return undefined;
  return [...devices]
    .sort(byId)
    .find(
      (d) =>
        d.type === type &&
        usableDevice(d) &&
        !unavailable.has(d.id) &&
        deviceMatches(d, keys),
    );
}

const ENV_KEY = /^(?:ANDROID_SERIAL|CARDIGAN_[A-Z0-9_]{1,60})$/u;
const ENV_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * A provider's session environment may only name the device: the standard
 * serial variable or host-owned `CARDIGAN_*` variables, with plain values.
 * Nothing that changes PATH, loaders, credentials or other tools.
 */
export function validateDeviceSessionEnv(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      !ENV_KEY.test(key) ||
      typeof value !== "string" ||
      !ENV_VALUE.test(value)
    )
      throw new Error("Invalid device session environment");
    result[key] = value;
  }
  return result;
}
