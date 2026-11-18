import { randomUUID } from "node:crypto";
import type { Machine } from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import {
  beginMachineObservation,
  completeMachineObservation,
  type MachineCapability,
  type MachineHealth,
  readMachineObservations,
  type Store,
} from "@cardigan/store";
import {
  type CapabilityDefinition,
  loadMachineCapabilityCatalog,
} from "./machine-capability-catalog.js";
import {
  type CapabilityProbe,
  probeMachineCapability,
} from "./machine-capability-probe.js";

export const MACHINE_CAPABILITY_INTERVAL_MS = 30 * 60 * 1000;
interface ObservationTarget {
  readonly execution: ExecutionConfig;
  readonly machine: Machine;
}
export interface MachineObservationOptions {
  readonly store: Store;
  readonly project: string;
  readonly machine: string;
  /** Resolve runtime configuration inside the observation fence, before any probe. */
  readonly target: () => ObservationTarget | Promise<ObservationTarget>;
  readonly check: () => Promise<
    Pick<MachineHealth, "blockers" | "launch_enabled">
  >;
  readonly catalog?: () => readonly CapabilityDefinition[];
  readonly probe?: CapabilityProbe;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}
/** Shared by the background patrol, machine check, and worker onboarding. */
export async function refreshMachineObservations(
  options: MachineObservationOptions,
) {
  const { store, project, machine } = options;
  options.signal?.throwIfAborted();
  const now = options.now ?? (() => new Date().toISOString());
  const actor = { kind: "system" as const, project_id: project };
  const observation = randomUUID();
  beginMachineObservation(store, actor, project, machine, observation, now());
  let health: MachineHealth = {
    status: "failed",
    checked_at: now(),
    blockers: ["machine_check_failed"],
    launch_enabled: false,
  };
  let capabilities: MachineCapability[] = [];
  try {
    const target = await options.target();
    const binding = JSON.stringify([
      target.execution,
      target.machine.os,
      target.machine.arch,
    ]);
    const checked = await options.check();
    health = {
      ...checked,
      checked_at: now(),
      status: checked.blockers.length ? "failed" : "passed",
    };
    const catalog = checked.blockers.length
      ? []
      : (
          options.catalog ?? (() => loadMachineCapabilityCatalog(options.env))
        )();
    const probe = options.probe ?? probeMachineCapability;
    for (const entry of catalog) {
      options.signal?.throwIfAborted();
      if (!entry.os.some((os) => os === target.machine.os)) continue;
      const result = await probe(
        target.execution,
        target.machine.os,
        entry.check,
        options.signal,
      );
      if (
        !result.ok ||
        (entry.acceptsOutput && !entry.acceptsOutput(result.output))
      )
        continue;
      const versionResult = entry.version
        ? JSON.stringify(entry.version) === JSON.stringify(entry.check)
          ? result
          : await probe(
              target.execution,
              target.machine.os,
              entry.version,
              options.signal,
            )
        : undefined;
      if (versionResult && !versionResult.ok) continue;
      const version = versionResult
        ? entry.parseVersion(versionResult.output)
        : null;
      if (versionResult && !version) continue;
      const verified_at = now();
      capabilities.push({
        key: entry.key,
        version,
        verified_at,
        evidence_ref: `machine-observation:${observation}#${entry.key}`,
      });
    }
    const current = await options.target();
    options.signal?.throwIfAborted();
    if (
      binding !==
      JSON.stringify([
        current.execution,
        current.machine.os,
        current.machine.arch,
      ])
    )
      throw new Error("Machine target changed");
  } catch {
    // Do not echo configuration, command output, SSH parameters, or exceptions.
    health = {
      status: "failed",
      checked_at: now(),
      blockers: ["machine_observation_failed"],
      launch_enabled: false,
    };
    capabilities = [];
  }
  completeMachineObservation(
    store,
    actor,
    project,
    machine,
    observation,
    health,
    capabilities,
  );
  return readMachineObservations(store, project, machine, now());
}
