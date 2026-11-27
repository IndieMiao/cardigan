import { type Result, validationFailed } from "./errors.js";

/** Scheduling constraints, separate from a role's execution permissions. */
export interface WorkItemRequirements {
  readonly os?: string;
  readonly arch?: string;
  readonly capabilities?: readonly string[];
  readonly tags?: readonly string[];
}

export interface CapabilityRequirement {
  readonly key: string;
  readonly operator?: "=" | ">=";
  readonly version?: string;
}

/**
 * Deliberately not a semver range language: only numeric dotted versions.
 * C-813: a key may name one device as `<type>:<device id>` (see
 * device-provider.ts); the id keeps its case.
 */
export function parseCapabilityRequirement(
  input: unknown,
): Result<CapabilityRequirement> {
  const match =
    typeof input === "string"
      ? /^([a-z0-9][a-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63})?)(?:(>=|=)([0-9]+(?:\.[0-9]+)*))?$/.exec(
          input,
        )
      : null;
  if (!match || match[0] !== input)
    return validationFailed(
      "能力需求只接受能力名、能力名=版本、能力名>=版本或 设备类型:设备编号",
    );
  return {
    ok: true,
    value: {
      key: match[1] as string,
      ...(match[2]
        ? { operator: match[2] as "=" | ">=", version: match[3] as string }
        : {}),
    },
  };
}

export function validateWorkItemRequirements(
  input: unknown,
): Result<WorkItemRequirements> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return validationFailed("requirements 必须是对象");
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["os", "arch", "capabilities", "tags"].includes(key),
    )
  )
    return validationFailed("requirements 只接受 os、arch、capabilities、tags");
  for (const field of ["os", "arch"] as const) {
    const value = record[field];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        value.trim() !== value ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value))
    )
      return validationFailed(`requirements.${field} 不合法`);
  }
  for (const field of ["capabilities", "tags"] as const) {
    const values = record[field];
    if (values === undefined) continue;
    if (!Array.isArray(values))
      return validationFailed(`requirements.${field} 必须是数组`);
    for (const value of values) {
      if (field === "capabilities") {
        const parsed = parseCapabilityRequirement(value);
        if (!parsed.ok) return parsed;
      } else if (
        typeof value !== "string" ||
        value.trim() !== value ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value)
      )
        return validationFailed("requirements.tags 不合法");
    }
  }
  return {
    ok: true,
    value: {
      ...(record.os === undefined ? {} : { os: record.os as string }),
      ...(record.arch === undefined ? {} : { arch: record.arch as string }),
      ...(record.capabilities === undefined
        ? {}
        : { capabilities: [...new Set(record.capabilities as string[])] }),
      ...(record.tags === undefined
        ? {}
        : { tags: [...new Set(record.tags as string[])] }),
    },
  };
}

/** Every distinct capability constraint must hold, including constraints on the same key. */
export function mergeMachineRequirements(
  ...sources: readonly (WorkItemRequirements | undefined)[]
): Result<WorkItemRequirements> {
  let merged: WorkItemRequirements = {};
  for (const source of sources) {
    if (source === undefined) continue;
    const checked = validateWorkItemRequirements(source);
    if (!checked.ok) return checked;
    const next = checked.value;
    for (const field of ["os", "arch"] as const)
      if (merged[field] && next[field] && merged[field] !== next[field])
        return validationFailed(`机器需求 ${field} 冲突，不能覆盖已有要求`);
    merged = {
      ...merged,
      ...next,
      ...(merged.capabilities || next.capabilities
        ? {
            capabilities: [
              ...new Set([
                ...(merged.capabilities ?? []),
                ...(next.capabilities ?? []),
              ]),
            ],
          }
        : {}),
      ...(merged.tags || next.tags
        ? { tags: [...new Set([...(merged.tags ?? []), ...(next.tags ?? [])])] }
        : {}),
    };
  }
  return { ok: true, value: merged };
}

/** Pass the pinned role for an existing Assignment, or the selected role for a new one. */
export function effectiveWorkItemRequirements(
  requirements: WorkItemRequirements | undefined,
  role: {
    readonly required_capabilities?: readonly string[];
    readonly required_machine_tags?: readonly string[];
  },
  templateDefaults?: WorkItemRequirements,
): Result<WorkItemRequirements> {
  return mergeMachineRequirements(templateDefaults, requirements, {
    ...(role.required_capabilities === undefined
      ? {}
      : { capabilities: role.required_capabilities }),
    ...(role.required_machine_tags === undefined
      ? {}
      : { tags: role.required_machine_tags }),
  });
}
