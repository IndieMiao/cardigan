import type { DatabaseSync } from "node:sqlite";
import type { CapacityOverride, CapacityOverrideBase } from "@cardigan/domain";
import { readCapacityOverrideText } from "@cardigan/store";
import type { ProjectQuota } from "./project-quotas.js";
import type { RunCapacityConfiguration } from "./run-capacity-config.js";

/**
 * C-792: resource slots and project ceilings read live from the database on
 * every call, falling back to run-capacity.yaml. Invalid YAML still fails
 * closed: no override can reopen a machine the trusted file has stopped.
 */
export function withCapacityOverrides(
  config: RunCapacityConfiguration,
  database: DatabaseSync,
): RunCapacityConfiguration {
  if (config.errors.length) return config;
  const parsed = new Map<
    string,
    {
      text: string;
      resources: ReadonlyMap<string, number>;
      projects: ReadonlyMap<string, ProjectQuota>;
    }
  >();
  const read = (machine: string) => {
    let text: string | undefined;
    try {
      text = readCapacityOverrideText(database, machine);
    } catch {
      return undefined; // A store without the table keeps the YAML values.
    }
    if (text === undefined) {
      parsed.delete(machine);
      return undefined;
    }
    const cached = parsed.get(machine);
    if (cached?.text === text) return cached;
    const doc = JSON.parse(text) as CapacityOverride;
    const base = config.resourcesForMachine(machine);
    const resources = new Map(base);
    for (const [key, slots] of Object.entries(doc.resources ?? {}))
      resources.set(key, slots);
    const projects = new Map<string, ProjectQuota>();
    for (const [project, quota] of Object.entries(doc.projects ?? {}))
      projects.set(project, {
        resources: new Map(Object.entries(quota.resources ?? {})),
        ...(quota.limit === undefined ? {} : { limit: quota.limit }),
      });
    const next = { text, resources, projects };
    parsed.set(machine, next);
    return next;
  };
  return {
    ...config,
    resourcesForMachine: (machine) =>
      read(machine)?.resources ?? config.resourcesForMachine(machine),
    projectQuota: (machine, project) =>
      read(machine)?.projects.get(project) ??
      config.projectQuota(machine, project),
  };
}

/** C-792: the YAML view an override of `machine` is validated against. */
export function capacityOverrideBase(
  config: RunCapacityConfiguration,
  machine: string,
): CapacityOverrideBase {
  const pinned = new Set<string>();
  for (const [key, policy] of config.policies(machine) ?? new Map())
    if (policy.bindings.size) pinned.add(key);
  for (const key of config.adbSlots(machine)?.resources ?? []) pinned.add(key);
  return {
    valid: !config.errors.length,
    resources: config.resourcesForMachine(machine),
    pinned,
    maximum: config.maxForMachine(machine),
  };
}
