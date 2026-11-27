import type { DeviceProviderPort } from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { CapabilityProbe } from "./machine-capability-probe.js";

/** C-813: the host's handle on one machine for a device listing. */
export interface HostDeviceTarget {
  readonly execution: ExecutionConfig;
  readonly os: string;
  /** Runs host-supplied argv as the project account (bounded time/output). */
  readonly probe: CapabilityProbe;
  readonly signal?: AbortSignal;
}

export interface HostDeviceProvider
  extends DeviceProviderPort<HostDeviceTarget> {
  /**
   * The device is used through the Run's own adb server: the machine's
   * `adb_slots` must include this type, and the lease is released only after
   * the holder's slot has been closed.
   */
  readonly needs_adb_slot?: true;
  /**
   * C-833: which of these local adb server ports holds the device (an
   * initialization that does not see it then names the holder).
   */
  holder?(
    target: HostDeviceTarget,
    device: { readonly type: string; readonly id: string },
    ports: readonly number[],
  ): Promise<number | undefined>;
}
