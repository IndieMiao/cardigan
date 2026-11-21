/** Private per-machine, per-project ceilings. They can tighten, never grant, capacity. */
export interface ProjectQuota {
  readonly limit?: number;
  readonly resources: ReadonlyMap<string, number>;
}

export type ReadProjectQuota = (
  machine: string,
  project: string,
) => ProjectQuota | undefined;

const mapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;

function ceiling(value: unknown, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new Error("Invalid project quota");
  return value;
}

export function parseProjectQuotas(
  raw: unknown,
  maximum: number,
  slots: ReadonlyMap<string, number>,
): ReadonlyMap<string, ProjectQuota> {
  if (!mapping(raw)) throw new Error("Invalid project quotas");
  const projects = new Map<string, ProjectQuota>();
  for (const [project, quota] of Object.entries(raw)) {
    if (
      !project.trim() ||
      !mapping(quota) ||
      !Object.keys(quota).length ||
      Object.keys(quota).some((k) => k !== "limit" && k !== "resources")
    )
      throw new Error("Invalid project quota");
    const resources = new Map<string, number>();
    if (quota.resources !== undefined) {
      if (!mapping(quota.resources))
        throw new Error("Invalid project resources");
      for (const [key, value] of Object.entries(quota.resources)) {
        const total = slots.get(key);
        if (total === undefined) throw new Error("Unknown quota resource");
        resources.set(key, ceiling(value, total));
      }
    }
    projects.set(project, {
      resources,
      ...(quota.limit === undefined
        ? {}
        : { limit: ceiling(quota.limit, maximum) }),
    });
  }
  return projects;
}
