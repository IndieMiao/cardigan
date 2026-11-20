import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_INACTIVE_CANCEL_AFTER_MS,
  DEFAULT_INBOX_STALL_AFTER_MS,
  DEFAULT_MAX_RUN_LIMIT,
  DEFAULT_RUN_LIMIT,
  parseCapabilityRequirement,
} from "@cardigan/domain";
import { parseDocument } from "yaml";

import {
  type ProjectQuota,
  parseProjectQuotas,
  type ReadProjectQuota,
} from "./project-quotas.js";

export interface RunCapacityConfiguration {
  readonly errors: readonly string[];
  forMachine(machine: string): number;
  resourcesForMachine(machine: string): ReadonlyMap<string, number>;
  readonly projectQuota: ReadProjectQuota;
  maxForMachine(machine: string): number;
  displayNameForMachine(machine: string): string | undefined;
  readonly inboxStallAfterMs: number;
  readonly inactiveCancelAfterMs: number | null;
}

/** Trusted YAML defaults read at startup; effectiveRunLimit applies live database overrides. */
export async function loadRunCapacityConfig(
  input: {
    readonly configDir?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<RunCapacityConfiguration> {
  const env = input.env ?? process.env;
  const file = join(
    resolve(
      input.configDir ??
        env.CARDIGAN_CONFIG_DIR ??
        join(homedir(), ".config", "cardigan"),
    ),
    "run-capacity.yaml",
  );
  const limits = new Map<string, number>();
  const maximums = new Map<string, number>();
  const resources = new Map<string, ReadonlyMap<string, number>>();
  const projects = new Map<string, ReadonlyMap<string, ProjectQuota>>();
  const unlimited: ReadonlyMap<string, number> = new Map();
  const names = new Map<string, string>();
  const errors: string[] = [];
  let inactiveCancelAfterMs = DEFAULT_INACTIVE_CANCEL_AFTER_MS;
  let inboxStallAfterMs = DEFAULT_INBOX_STALL_AFTER_MS;
  const result = (): RunCapacityConfiguration => ({
    errors,
    inboxStallAfterMs: errors.length
      ? DEFAULT_INBOX_STALL_AFTER_MS
      : inboxStallAfterMs,
    inactiveCancelAfterMs: errors.length ? null : inactiveCancelAfterMs,
    // Invalid configuration stops automatic work items; standing PMs remain exempt.
    forMachine: (machine) =>
      errors.length ? 0 : (limits.get(machine) ?? DEFAULT_RUN_LIMIT),
    resourcesForMachine: (machine) =>
      errors.length ? unlimited : (resources.get(machine) ?? unlimited),
    projectQuota: (machine, project) =>
      errors.length ? undefined : projects.get(machine)?.get(project),
    maxForMachine: (machine) =>
      errors.length ? 0 : (maximums.get(machine) ?? DEFAULT_MAX_RUN_LIMIT),
    displayNameForMachine: (machine) =>
      errors.length ? undefined : names.get(machine),
  });
  let source: string;
  try {
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        ![0, process.getuid?.()].includes(info.uid) ||
        info.mode & 0o022 ||
        info.size > 1024 * 1024
      )
        throw new Error("Unsafe config file");
      for (let parent = dirname(file); ; parent = dirname(parent)) {
        const entry = await lstat(parent);
        if (
          !entry.isDirectory() ||
          ![0, process.getuid?.()].includes(entry.uid) ||
          (entry.mode & 0o022 && !(entry.mode & 0o1000))
        )
          throw new Error("Unsafe config directory");
        if (parent === dirname(parent)) break;
      }
      source = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      errors.push(
        "无法安全读取 run-capacity.yaml，暂停普通 Run 自动派发及失活回收",
      );
    return result();
  }
  try {
    const doc = parseDocument(source, { uniqueKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length)
      throw new Error("Invalid YAML");
    const raw: unknown = doc.toJS({ maxAliasCount: 0 });
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    if (
      !object(raw) ||
      Object.keys(raw).some(
        (key) =>
          ![
            "machines",
            "inactive_cancel_after_minutes",
            "inbox_stall_after_minutes",
          ].includes(key),
      ) ||
      !object(raw.machines)
    )
      throw new Error("Invalid machines");
    for (const key of [
      "inactive_cancel_after_minutes",
      "inbox_stall_after_minutes",
    ]) {
      const minutes = raw[key];
      if (minutes === undefined) continue;
      if (
        typeof minutes !== "number" ||
        !Number.isSafeInteger(minutes) ||
        minutes < 1 ||
        minutes > Math.floor(2147483647 / 60_000)
      )
        throw new Error("Invalid inactivity grace");
      if (key === "inbox_stall_after_minutes")
        inboxStallAfterMs = minutes * 60_000;
      else inactiveCancelAfterMs = minutes * 60_000;
    }
    for (const [machine, entry] of Object.entries(raw.machines)) {
      const settings = object(entry) ? entry : { limit: entry };
      if (
        Object.keys(settings).some(
          (key) =>
            ![
              "limit",
              "max_limit",
              "display_name",
              "resources",
              "projects",
            ].includes(key),
        )
      )
        throw new Error("Invalid machine fields");
      const limit = settings.limit ?? DEFAULT_RUN_LIMIT;
      const maximum = settings.max_limit ?? DEFAULT_MAX_RUN_LIMIT;
      if (
        !machine.trim() ||
        settings.limit === null ||
        settings.max_limit === null ||
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        typeof maximum !== "number" ||
        !Number.isSafeInteger(maximum) ||
        maximum < 1 ||
        limit > maximum
      )
        throw new Error("Invalid limit");
      if (settings.resources !== undefined) {
        if (
          !object(settings.resources) ||
          Object.getPrototypeOf(settings.resources) !== Object.prototype
        )
          throw new Error("Invalid resources");
        const slots = new Map<string, number>();
        for (const [key, value] of Object.entries(settings.resources)) {
          const parsed = parseCapabilityRequirement(key);
          if (
            !parsed.ok ||
            parsed.value.key !== key ||
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value < 1
          )
            throw new Error("Invalid resource limit");
          slots.set(key, value);
        }
        resources.set(machine, slots);
      }
      if (settings.projects !== undefined)
        projects.set(
          machine,
          parseProjectQuotas(
            settings.projects,
            maximum,
            resources.get(machine) ?? unlimited,
          ),
        );
      if (settings.display_name !== undefined) {
        const name = settings.display_name;
        if (
          typeof name !== "string" ||
          !name.trim() ||
          name.length > 200 ||
          /[\p{Cc}\p{Cf}]/u.test(name)
        )
          throw new Error("Invalid display name");
        names.set(machine, name.trim());
      }
      limits.set(machine, limit);
      maximums.set(machine, maximum);
    }
  } catch {
    // Never include YAML contents (which could contain credentials) in diagnostics.
    errors.push(
      "run-capacity.yaml 必须包含 machines 映射；limit 不得超过 max_limit（默认 16），两者及可选 inactive_cancel_after_minutes、inbox_stall_after_minutes 须为允许范围的正整数，display_name 须为有效文字，resources 须按能力名设置正整数上限。配置无效，暂停普通 Run 自动派发及失活回收",
    );
  }
  return result();
}
