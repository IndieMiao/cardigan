import {
  type DeviceObservation,
  type DeviceSessionContext,
  validateDeviceSessionEnv,
  withDeviceTypes,
} from "@cardigan/domain";
import { androidDeviceProvider } from "./android-device-provider.js";
import type { HostDeviceProvider } from "./device-provider-host.js";

export type {
  HostDeviceProvider,
  HostDeviceTarget,
} from "./device-provider-host.js";

/**
 * C-813: every device provider the host knows. Adding a kind of device means
 * adding one provider here (see docs/device-providers.md).
 */
export const DEVICE_PROVIDERS: readonly HostDeviceProvider[] = [
  androidDeviceProvider,
];

export const DEVICE_TYPES: readonly string[] = DEVICE_PROVIDERS.map(
  (p) => p.type,
);

export function deviceProvider(type: string) {
  return DEVICE_PROVIDERS.find((p) => p.type === type);
}

/** Add the type-level key to narrowed device requirements (one quota slot each). */
export function withDeviceResources(keys: readonly string[]) {
  return withDeviceTypes(keys, DEVICE_TYPES);
}

/** The combined, validated environment and prompt rules for held devices. */
export function deviceSession(
  held: readonly DeviceObservation[],
  context: DeviceSessionContext,
): { env: Record<string, string>; rules: string[] } | undefined {
  if (!held.length) return undefined;
  const env: Record<string, string> = {};
  const rules: string[] = [];
  for (const device of held) {
    const provider = deviceProvider(device.type);
    if (!provider) throw new Error("Unknown device provider");
    const own = validateDeviceSessionEnv(provider.sessionEnv(device, context));
    for (const [key, value] of Object.entries(own)) {
      if (Object.hasOwn(env, key) && env[key] !== value)
        throw new Error("Device session environments conflict");
      env[key] = value;
    }
    rules.push(provider.sessionRule(device, context));
  }
  return { env, rules };
}
