import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  type ActionCommand,
  alternativeCapabilities,
  type DeviceObservation,
  deviceCapabilities,
  type Machine,
  mergeHeldDevices,
  normalizeDeviceInventory,
} from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import {
  acceptedBrowserDigest,
  beginMachineObservation,
  browserPathDigest,
  completeMachineObservation,
  isAcceptedBrowserPath,
  type MachineCapability,
  type MachineHealth,
  readMachineObservations,
  readMachineObservationsInTransaction,
  type Store,
} from "@cardigan/store";
import { agentToolsCapability } from "./agent-tools.js";
import {
  type AgentToolsOutcome,
  reconcileAgentToolsAction,
} from "./agent-tools-maintenance.js";
import { heldDevices } from "./device-leases.js";
import {
  DEVICE_PROVIDERS,
  type HostDeviceProvider,
} from "./device-providers.js";
import {
  type CapabilityDefinition,
  loadMachineCapabilityCatalog,
} from "./machine-capability-catalog.js";
import {
  type CapabilityProbe,
  probeMachineCapability,
} from "./machine-capability-probe.js";
import {
  observeReadiness,
  type ReadinessInput,
  type ReadinessOutcome,
  readinessReachable,
  recordReadiness,
} from "./machine-readiness.js";
import {
  RuntimeTargetError,
  safeTargetReason,
} from "./runtime-target-error.js";
import { runtimeWorkersPath } from "./runtime-workers-config.js";
import {
  helperMismatch,
  observationFingerprint,
  splitHelperWarnings,
} from "./worker-helper-release.js";
import { notifyHelperMismatch } from "./worker-maintenance.js";
import { stageWorkerUpgrade } from "./worker-upgrade.js";
import { manualWorkerUpgradeAllowed } from "./worker-upgrade-enrollment.js";

export const MACHINE_CAPABILITY_INTERVAL_MS = 30 * 60 * 1000;
export { observationFingerprint } from "./worker-helper-release.js";

interface ObservationTarget {
  readonly execution: ExecutionConfig;
  readonly machine: Machine;
}
export interface MachineObservationOptions {
  readonly stageUpgrade?: typeof stageWorkerUpgrade;
  readonly store: Store;
  readonly project: string;
  readonly machine: string;
  /** Resolve runtime configuration inside the observation fence, before any probe. */
  readonly target: () => ObservationTarget | Promise<ObservationTarget>;
  readonly observationId?: string;
  readonly progress?: (step: "runtime" | "capabilities") => void;
  readonly check: () => Promise<
    Pick<MachineHealth, "blockers" | "launch_enabled" | "warnings">
  >;
  /** Same launch configuration that supplies the browser MCP on this host. */
  readonly browsersPath?: () =>
    | string
    | undefined
    | Promise<string | undefined>;
  readonly catalog?: () => readonly CapabilityDefinition[];
  readonly probe?: CapabilityProbe;
  /** C-813: device providers to list; all of them by default only with the production catalog. */
  readonly deviceProviders?: readonly HostDeviceProvider[];
  /** C-608 readiness patrol; on by default only with the production catalog. */
  readonly readiness?: (input: ReadinessInput) => Promise<ReadinessOutcome>;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}
/** Shared by the background patrol, machine check, and worker onboarding. */
export async function refreshMachineObservations(
  options: MachineObservationOptions,
): Promise<
  ReturnType<typeof readMachineObservations> & {
    /** C-599: this observation's attachment tools outcome; never a command. */
    agent_tools?: AgentToolsOutcome;
  }
> {
  const { store, project, machine } = options;
  options.signal?.throwIfAborted();
  const now = options.now ?? (() => new Date().toISOString());
  const actor = { kind: "system" as const, project_id: project };
  const observation = options.observationId ?? randomUUID();
  const previousHealth = readMachineObservations(
    store,
    project,
    machine,
    now(),
  ).health;
  const previousReadiness = previousHealth?.readiness;
  beginMachineObservation(store, actor, project, machine, observation, now());
  let health: MachineHealth = {
    status: "failed",
    checked_at: now(),
    blockers: ["machine_check_failed"],
    launch_enabled: false,
  };
  let capabilities: MachineCapability[] = [];
  let observedBrowserDigest: string | null | undefined;
  let targetFingerprint: string | undefined;
  let checkedTarget: ObservationTarget | undefined;
  let readiness: ReadinessOutcome | undefined;
  try {
    const target = await options.target();
    const binding = JSON.stringify([
      target.execution,
      target.machine.os,
      target.machine.arch,
    ]);
    // A compatible helper awaiting upgrade is a warning, never a dispatch stop (C-608).
    const { warnings, ...checked } = splitHelperWarnings(await options.check());
    health = {
      ...checked,
      ...(warnings.length ? { warnings } : {}),
      checked_at: now(),
      status: checked.blockers.length ? "failed" : "passed",
    };
    let root: string | undefined;
    if (!checked.blockers.length && !options.catalog) {
      try {
        // A CLI file or web-process snapshot can be newer than the dispatch owner's config.
        const candidate = await options.browsersPath?.();
        if (candidate && isAcceptedBrowserPath(store, candidate))
          root = candidate;
      } catch {
        // This optional scope cannot invalidate the machine's other observations.
      }
    }
    const catalog = checked.blockers.length
      ? []
      : (options.catalog?.() ?? [
          ...loadMachineCapabilityCatalog(options.env, root, target.machine.os),
          agentToolsCapability(target.execution, machine),
        ]);
    const failures: NonNullable<
      MachineHealth["capability_failures"]
    >[number][] = [];
    if (catalog.length) options.progress?.("capabilities");
    const probe = options.probe ?? probeMachineCapability;
    for (const entry of catalog) {
      options.signal?.throwIfAborted();
      if (!entry.os.some((os) => os === target.machine.os)) continue;
      const search = "scopes" in entry.check ? entry.check : undefined;
      if (search) {
        const registry = search.scopes.find((s) => s.kind === "registry");
        observedBrowserDigest = registry
          ? browserPathDigest(registry.value)
          : acceptedBrowserDigest(store);
      }
      const result = await probe(
        target.execution,
        target.machine.os,
        entry.check,
        options.signal,
      );
      if (search && !result.ok)
        failures.push({
          key: entry.key,
          search_locations: search.scopes
            .slice(0, result.attempted ?? 0)
            .map((scope) => scope.label),
          ...(result.attempted !== search.scopes.length ||
          result.incomplete !== false
            ? { search_incomplete: true }
            : {}),
        });
      if (
        !result.ok ||
        (entry.acceptsOutput && !entry.acceptsOutput(result.output))
      ) {
        const reason = entry.failureReason?.(
          result.ok ? result.output : undefined,
        );
        if (reason)
          failures.push({ key: entry.key, search_locations: [], reason });
        continue;
      }
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
    // C-813: each device provider whose prerequisite capability was just
    // verified lists its devices. A failed listing keeps only devices a Run
    // holds and is reported, instead of failing the whole machine check.
    const providers =
      options.deviceProviders ??
      (options.catalog === undefined ? DEVICE_PROVIDERS : []);
    let devices: DeviceObservation[] | undefined;
    for (const provider of providers) {
      options.signal?.throwIfAborted();
      if (
        !provider.os.includes(target.machine.os) ||
        (provider.requires_capability &&
          !capabilities.some((c) => c.key === provider.requires_capability))
      )
        continue;
      let raw: readonly unknown[] | undefined;
      try {
        raw = await provider.list({
          execution: target.execution,
          os: target.machine.os,
          probe,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch {
        raw = undefined;
      }
      const listed = mergeHeldDevices(
        normalizeDeviceInventory(provider.type, raw ?? []),
        previousHealth?.devices?.filter((d) => d.type === provider.type),
        heldDevices(store, machine, provider.type),
      );
      devices = [...(devices ?? []), ...listed];
      if (!raw)
        failures.push({
          key: provider.type,
          search_locations: [],
          reason: `无法列出${provider.label}`,
        });
      const verified_at = now();
      for (const key of deviceCapabilities(listed))
        capabilities.push({
          key,
          version: null,
          verified_at,
          evidence_ref: `machine-observation:${observation}#${provider.type}`,
        });
    }
    if (devices) health = { ...health, devices };
    // C-815: an alternative (安卓设备任一) holds once any option was verified.
    for (const key of alternativeCapabilities(capabilities.map((c) => c.key)))
      if (!capabilities.some((c) => c.key === key))
        capabilities.push({
          key,
          version: null,
          verified_at: now(),
          evidence_ref: `machine-observation:${observation}#${key}`,
        });
    if (failures.length) health = { ...health, capability_failures: failures };
    const observe =
      options.readiness ?? (options.catalog === undefined && observeReadiness);
    if (
      observe &&
      target.execution.mode === "agent-ssh" &&
      readinessReachable(health.blockers)
    ) {
      try {
        readiness = await observe({
          store,
          project,
          machine,
          now,
          os: target.machine.os,
          execution: target.execution,
          health,
          capabilities: capabilities.map((c) => c.key),
          signal: options.signal,
          env: options.env,
        });
        health = { ...health, readiness: readiness.readiness };
      } catch {
        // Readiness is advisory; it never changes the machine check outcome.
      }
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
      throw new RuntimeTargetError("target_changed");
    checkedTarget = current;
    if (health.status === "passed")
      targetFingerprint = observationFingerprint(
        target.execution.target?.fingerprint,
        target.machine,
      );
  } catch (error) {
    // Do not echo configuration, command output, SSH parameters, or exceptions.
    health = {
      status: "failed",
      checked_at: now(),
      blockers:
        error instanceof RuntimeTargetError
          ? [error.code, safeTargetReason(error)]
          : ["machine_observation_failed"],
      launch_enabled: false,
    };
    capabilities = [];
  }
  const recorded = completeMachineObservation(
    store,
    actor,
    project,
    machine,
    observation,
    health,
    capabilities,
    targetFingerprint,
    observedBrowserDigest,
  );
  if (recorded && readiness) {
    const outcome = readiness;
    try {
      store.uow.run((tx) =>
        recordReadiness(
          tx,
          project,
          machine,
          previousReadiness,
          outcome,
          now(),
        ),
      );
    } catch {
      // A failed timeline write never invalidates the recorded observation.
    }
  }
  const owns = () =>
    readMachineObservationsInTransaction(store, project, machine, now()).health
      ?.evidence_ref === `machine-observation:${observation}`;
  const tools = recorded
    ? await reconcileAgentToolsAction({
        store,
        project,
        machine,
        observation,
        health,
        capabilities,
        target: checkedTarget,
        currentBinding: async () =>
          (await options.target()).execution.target?.fingerprint,
        stillCurrent: owns,
        ...(options.env ? { env: options.env } : {}),
        ...(options.stageUpgrade ? { stage: options.stageUpgrade } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        now,
      })
    : undefined;
  const observed = () => ({
    ...readMachineObservations(store, project, machine, now()),
    ...(tools ? { agent_tools: tools } : {}),
  });
  const mismatch = [...health.blockers, ...(health.warnings ?? [])].find(
    helperMismatch,
  );
  const manualAllowed = () =>
    manualWorkerUpgradeAllowed(
      dirname(runtimeWorkersPath(options.env)),
      project,
      machine,
    );
  if (
    recorded &&
    machine !== "local" &&
    mismatch &&
    checkedTarget &&
    manualAllowed()
  ) {
    const { execution } = checkedTarget;
    const pinned = execution.target;
    const bound =
      pinned &&
      pinned.machine_id === machine &&
      pinned.project_id === project &&
      execution.mode === "agent-ssh";
    let terminal: ActionCommand | undefined;
    if (bound) {
      try {
        terminal = await (options.stageUpgrade ?? stageWorkerUpgrade)(
          execution,
          checkedTarget.machine.os,
          options.signal,
        );
      } catch {
        /* Never surface raw SSH diagnostics or advertise unstaged files. */
      }
      if (
        (await options.target()).execution.target?.fingerprint !==
        pinned.fingerprint
      )
        return observed();
    }
    const fields = {
      helper_upgrade: {
        machine_id: machine,
        binding: bound ? pinned.fingerprint : null,
      },
      ...(terminal ? { terminal } : {}),
    };
    store.uow.run((tx) => {
      const current = readMachineObservationsInTransaction(
        store,
        project,
        machine,
        now(),
      );
      if (
        current.health?.evidence_ref === `machine-observation:${observation}` &&
        manualAllowed()
      )
        notifyHelperMismatch(tx, project, machine, { now }, mismatch, fields);
    });
  }
  return observed();
}
