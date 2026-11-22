import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ActionCommand, Machine } from "@cardigan/domain";
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
import {
  AGENT_TOOLS_CAPABILITY,
  agentToolsCapability,
  agentToolsReinstallable,
} from "./agent-tools.js";
import { requestAgentToolsMigration } from "./agent-tools-maintenance.js";
import {
  type CapabilityDefinition,
  loadMachineCapabilityCatalog,
} from "./machine-capability-catalog.js";
import {
  type CapabilityProbe,
  probeMachineCapability,
} from "./machine-capability-probe.js";
import {
  RuntimeTargetError,
  safeTargetReason,
} from "./runtime-target-error.js";
import { runtimeWorkersPath } from "./runtime-workers-config.js";
import {
  helperMismatch,
  observationFingerprint,
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
    Pick<MachineHealth, "blockers" | "launch_enabled">
  >;
  /** Same launch configuration that supplies the browser MCP on this host. */
  readonly browsersPath?: () =>
    | string
    | undefined
    | Promise<string | undefined>;
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
  const observation = options.observationId ?? randomUUID();
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
    if (failures.length) health = { ...health, capability_failures: failures };
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
  const mismatch = health.blockers.find(helperMismatch);
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
        return readMachineObservations(store, project, machine, now());
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
  // C-595: helpers current but tools missing/stale on a manually maintained
  // worker. Enrolled bindings are handled by the patrol's signed upgrade.
  const tools = health.capability_failures?.find(
    (f) => f.key === AGENT_TOOLS_CAPABILITY,
  )?.reason;
  const execution = checkedTarget?.execution;
  if (
    recorded &&
    machine !== "local" &&
    !mismatch &&
    tools &&
    agentToolsReinstallable(tools) &&
    execution?.mode === "agent-ssh" &&
    execution.target?.machine_id === machine &&
    execution.target.project_id === project &&
    manualAllowed()
  )
    await requestAgentToolsMigration(
      store,
      project,
      machine,
      execution,
      checkedTarget?.machine.os ?? "",
      tools,
      options.signal,
      options.stageUpgrade,
    );
  return readMachineObservations(store, project, machine, now());
}
