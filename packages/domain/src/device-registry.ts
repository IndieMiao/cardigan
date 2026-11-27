/**
 * C-817: which external devices a person has enabled, and for which projects.
 *
 * C-813 lists devices on every machine check. A device seen for the first
 * time is only *registered* (`pending`): it is not handed to any Run until a
 * person enables it for one or more projects. Enabling runs the provider's
 * declared, fixed initialization steps during the next machine check
 * (`initializing`); success records the screen resolution and OS version and
 * makes the device dispatchable (`enabled`), failure keeps the reason and can
 * be retried (`failed`). `disabled` stops new dispatch; it never revokes a
 * live lease, so a Run holding the device keeps it until the system has seen
 * that Run end.
 *
 * No IO here (§20.2).
 */
import {
  capabilityAlternatives,
  unresolvedAlternatives,
} from "./capability-alternatives.js";
import {
  DEVICE_ID_PATTERN,
  type DeviceInitStep,
  type DeviceObservation,
  deviceMatches,
  isDeviceKey,
  isDeviceType,
  usableDevice,
} from "./device-provider.js";

export const DEVICE_REGISTRATION_STATUSES = [
  "pending",
  "initializing",
  "failed",
  "enabled",
  "disabled",
] as const;
export type DeviceRegistrationStatus =
  (typeof DEVICE_REGISTRATION_STATUSES)[number];

export interface DeviceRegistration {
  readonly machine: string;
  readonly type: string;
  readonly id: string;
  readonly status: DeviceRegistrationStatus;
  /** Projects the device may be handed to (never empty once requested). */
  readonly projects: readonly string[];
  readonly model?: string;
  /** OS version recorded by the initialization. */
  readonly version?: string;
  /** `<width>x<height>`, recorded by the initialization. */
  readonly resolution?: string;
  /** Project whose machine account runs the initialization. */
  readonly init_project?: string;
  /** Plain reason of the last failed initialization. */
  readonly failure?: string;
  readonly discovered_at: string;
  readonly updated_at: string;
  readonly initialized_at?: string;
}

/** What a person (Needs You or the host CLI) can do with a registration. */
export type DeviceRegistrationRequest = "enable" | "disable" | "assign";

/**
 * The next status for a request: enabling an initialized (or disabled but
 * already initialized) device needs no new initialization; everything else
 * that is enabled goes through `initializing`. Returns an error text when the
 * request is not allowed in the current status.
 */
export function deviceRegistrationNext(
  current: DeviceRegistration,
  request: DeviceRegistrationRequest,
): { status: DeviceRegistrationStatus } | { error: string } {
  switch (request) {
    case "enable":
      if (current.status === "initializing")
        return { error: "设备正在初始化，请等待结果" };
      if (current.status === "enabled") return { status: "enabled" };
      return {
        status:
          current.status === "disabled" && current.initialized_at
            ? "enabled"
            : "initializing",
      };
    case "disable":
      return { status: "disabled" };
    case "assign":
      return { status: current.status };
  }
}

/** Distinct project ids; at least one; all among `allowed` (the machine's projects). */
export function validateDeviceProjects(
  projects: readonly string[],
  allowed: readonly string[],
): { projects: string[] } | { error: string } {
  const result = [...new Set(projects.map((p) => p.trim()))];
  if (!result.length) return { error: "至少指定一个项目" };
  const bad = result.find((p) => !allowed.includes(p));
  if (bad !== undefined) return { error: `机器没有登记给项目 ${bad}` };
  return { projects: result };
}

/** Whether Runs of `project` may be handed this device. */
export function deviceEnabledFor(
  registration: DeviceRegistration | undefined,
  project: string,
) {
  return (
    registration?.status === "enabled" &&
    registration.projects.includes(project)
  );
}

/** The project a single-project machine preselects; none for shared machines. */
export function preselectedDeviceProject(projects: readonly string[]) {
  return projects.length === 1 ? projects[0] : undefined;
}

/**
 * Where to run the initialization: the first requested project whose latest
 * listing sees the device available (its account has authorized the device),
 * else the first requested project (the attempt then reports why it failed).
 */
export function deviceInitProject(
  projects: readonly string[],
  available: (project: string) => boolean,
) {
  return projects.find(available) ?? projects[0];
}

export type DeviceInitOutcome =
  | {
      readonly ok: true;
      readonly resolution?: string;
      readonly version?: string;
    }
  | { readonly ok: false; readonly reason: string };

const RESOLUTION = /^[1-9]\d{1,4}x[1-9]\d{1,4}$/u;
const VERSION = /^\d{1,3}(?:\.\d{1,3}){0,3}$/u;

/**
 * Worker output of an initialization, reduced to fixed texts: only a known
 * result, a declared step key and strictly matching values are kept; nothing
 * the device or worker printed reaches the person or the database.
 */
export function normalizeDeviceInitResult(
  raw: unknown,
  steps: readonly DeviceInitStep[],
): DeviceInitOutcome {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  switch (value.result) {
    case "ok": {
      const resolution =
        typeof value.resolution === "string" ? value.resolution : "";
      const version = typeof value.version === "string" ? value.version : "";
      return {
        ok: true,
        ...(RESOLUTION.test(resolution) ? { resolution } : {}),
        ...(VERSION.test(version) ? { version } : {}),
      };
    }
    case "not_found":
      return {
        ok: false,
        reason: "机器上没有看到这台设备：确认已接好线、设备已开机，然后重试",
      };
    case "unauthorized":
      return {
        ok: false,
        reason:
          "这个项目的机器账号还没有得到设备授权：在设备上确认“允许调试”后重试",
      };
    case "failed": {
      const step = steps.find((s) => s.key === value.step);
      if (step)
        return {
          ok: false,
          reason: `“${step.title}”没有成功${step.hint ? `：${step.hint}` : ""}`,
        };
      break;
    }
  }
  return { ok: false, reason: "初始化没有返回结果：检查机器连接后重试" };
}

/** The plain reason a listing gives for an unusable device. */
export function deviceUnavailableReason(
  state: DeviceObservation["state"] | undefined,
) {
  switch (state) {
    case "unauthorized":
      return "掉了授权";
    case "offline":
      return "离线";
    case "unavailable":
      return "不可用";
    case undefined:
      return "已拔掉或看不到";
    default:
      return undefined;
  }
}

/**
 * C-827: `keys` plus the device `type` when an alternative among them that
 * names none of its options yet (a queued `android.any`) can only be met by
 * that type on this machine: `type` is one of its options and no other
 * option is in `available` (the machine's currently verified capabilities).
 * While another option is available the Run can still be dispatched to it, so
 * the keys stay unchanged.
 */
export function deviceAlternativeKeys(
  keys: readonly string[],
  type: string,
  available: readonly string[],
): readonly string[] {
  if (keys.includes(type)) return keys;
  const only = unresolvedAlternatives(keys).some((key) => {
    const options = capabilityAlternatives(key) ?? [];
    return (
      options.includes(type) &&
      !options.some((o) => o !== type && available.includes(o))
    );
  });
  return only ? [...keys, type] : keys;
}

/**
 * Whether `keys` (a waiting Run's resource requirement) could only be met by
 * this enabled device: it asks for the device's type, the device matches
 * every narrowing key, and no other usable device enabled for the project on
 * the machine matches them. With `available` (the machine's verified
 * capabilities), an unresolved alternative whose only available option is the
 * device's type counts as asking for it (C-827, `deviceAlternativeKeys`).
 */
export function waitsOnDevice(
  requested: readonly string[],
  device: Pick<DeviceObservation, "type" | "id" | "model">,
  others: readonly DeviceObservation[],
  available?: readonly string[],
) {
  const keys = available
    ? deviceAlternativeKeys(requested, device.type, available)
    : requested;
  const own: DeviceObservation = { ...device, state: "available" };
  if (!keys.some((k) => isDeviceKey(device.type, k))) return false;
  if (!deviceMatches(own, keys)) return false;
  return !others.some(
    (d) =>
      d.type === device.type &&
      d.id !== device.id &&
      usableDevice(d) &&
      deviceMatches(d, keys),
  );
}

/** `device-enable:<machine>:<type>:<id>` and friends; the key carries no free text. */
export function deviceActionKey(
  kind: "enable" | "unavailable",
  machine: string,
  type: string,
  id: string,
) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(machine) ||
    !isDeviceType(type) ||
    !DEVICE_ID_PATTERN.test(id)
  )
    throw new Error("Invalid device action key");
  return `device-${kind}:${machine}:${type}:${id}`;
}
