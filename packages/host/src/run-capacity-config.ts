import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_INACTIVE_CANCEL_AFTER_MS,
  DEFAULT_INBOX_STALL_AFTER_MS,
  DEFAULT_MAX_RUN_LIMIT,
  DEFAULT_QUEUED_MIGRATE_AFTER_MS,
  DEFAULT_QUEUED_MIGRATION_COOLDOWN_MS,
  DEFAULT_QUEUED_RECHECK_AFTER_MS,
  DEFAULT_RUN_LIMIT,
  parseCapabilityRequirement,
} from "@cardigan/domain";
import { parseDocument } from "yaml";
import { type AdbSlotPolicy, parseAdbSlots } from "./adb-slots.js";
import {
  type ProjectQuota,
  parseProjectQuotas,
  type ReadProjectQuota,
} from "./project-quotas.js";
import {
  type MachinePolicy,
  parseResourcePolicies,
} from "./resource-policy.js";
export interface RunCapacityConfiguration {
  readonly errors: readonly string[];
  forMachine(machine: string): number;
  resourcesForMachine(machine: string): ReadonlyMap<string, number>;
  policies(machine: string): MachinePolicy | undefined;
  /** C-679: per-Run adb server and emulator ports for this machine. */
  adbSlots(machine: string): AdbSlotPolicy | undefined;
  preferred(machine: string): string | undefined;
  readonly projectQuota: ReadProjectQuota;
  maxForMachine(machine: string): number;
  displayNameForMachine(machine: string): string | undefined;
  readonly queuedRecheckAfterMs: number;
  /** C-826: wait before a never-started queued Run may move to another machine. */
  readonly queuedMigrateAfterMs: number;
  /** C-826: no second migration of the same work item within this interval. */
  readonly queuedMigrationCooldownMs: number;
  readonly inboxStallAfterMs: number;
  readonly inactiveCancelAfterMs: number | null;
  /** C-752: shorter grace for Runs holding scarce resources; null (off) unless configured. */
  readonly scarceInactiveCancel: ScarceInactiveCancelConfig | null;
}
export interface ScarceInactiveCancelConfig {
  readonly afterMs: number;
  readonly resources: readonly string[];
}
/** Resources whose holder blocks others for long; used only when the grace is configured. */
export const DEFAULT_SCARCE_RESOURCES = [
  "android.emulator",
  "android.device",
  "ios.simulator",
  "godot",
] as const;

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
  const policies = new Map<string, MachinePolicy>(),
    adbSlots = new Map<string, AdbSlotPolicy>(),
    preferred = new Map<string, string>();
  const names = new Map<string, string>();
  const errors: string[] = [];
  let inactiveCancelAfterMs = DEFAULT_INACTIVE_CANCEL_AFTER_MS;
  let queuedRecheckAfterMs = DEFAULT_QUEUED_RECHECK_AFTER_MS;
  let queuedMigrateAfterMs = DEFAULT_QUEUED_MIGRATE_AFTER_MS;
  let queuedMigrationCooldownMs = DEFAULT_QUEUED_MIGRATION_COOLDOWN_MS;
  let inboxStallAfterMs = DEFAULT_INBOX_STALL_AFTER_MS;
  let scarceAfterMs: number | undefined;
  let scarceResources: readonly string[] = DEFAULT_SCARCE_RESOURCES;
  const result = (): RunCapacityConfiguration => ({
    errors,
    scarceInactiveCancel:
      errors.length || scarceAfterMs === undefined
        ? null
        : { afterMs: scarceAfterMs, resources: scarceResources },
    queuedRecheckAfterMs: errors.length
      ? DEFAULT_QUEUED_RECHECK_AFTER_MS
      : queuedRecheckAfterMs,
    queuedMigrateAfterMs: errors.length
      ? DEFAULT_QUEUED_MIGRATE_AFTER_MS
      : queuedMigrateAfterMs,
    queuedMigrationCooldownMs: errors.length
      ? DEFAULT_QUEUED_MIGRATION_COOLDOWN_MS
      : queuedMigrationCooldownMs,
    inboxStallAfterMs: errors.length
      ? DEFAULT_INBOX_STALL_AFTER_MS
      : inboxStallAfterMs,
    inactiveCancelAfterMs: errors.length ? null : inactiveCancelAfterMs,
    // Invalid configuration stops automatic work items; standing PMs remain exempt.
    forMachine: (machine) =>
      errors.length ? 0 : (limits.get(machine) ?? DEFAULT_RUN_LIMIT),
    resourcesForMachine: (machine) =>
      errors.length ? unlimited : (resources.get(machine) ?? unlimited),
    policies: (machine) => (errors.length ? undefined : policies.get(machine)),
    adbSlots: (machine) => (errors.length ? undefined : adbSlots.get(machine)),
    preferred: (machine) =>
      errors.length ? undefined : preferred.get(machine),
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
            "queued_recheck_after_minutes",
            "queued_migrate_after_minutes",
            "queued_migration_cooldown_minutes",
            "scarce_inactive_cancel_after_minutes",
            "scarce_resources",
          ].includes(key),
      ) ||
      !object(raw.machines)
    )
      throw new Error("Invalid machines");
    for (const key of [
      "inactive_cancel_after_minutes",
      "inbox_stall_after_minutes",
      "queued_recheck_after_minutes",
      "queued_migrate_after_minutes",
      "queued_migration_cooldown_minutes",
      "scarce_inactive_cancel_after_minutes",
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
      else if (key === "queued_recheck_after_minutes")
        queuedRecheckAfterMs = minutes * 60_000;
      else if (key === "queued_migrate_after_minutes")
        queuedMigrateAfterMs = minutes * 60_000;
      else if (key === "queued_migration_cooldown_minutes")
        queuedMigrationCooldownMs = minutes * 60_000;
      else if (key === "scarce_inactive_cancel_after_minutes")
        scarceAfterMs = minutes * 60_000;
      else inactiveCancelAfterMs = minutes * 60_000;
    }
    if (raw.scarce_resources !== undefined) {
      const list = raw.scarce_resources;
      if (
        !Array.isArray(list) ||
        !list.length ||
        list.some((key) => {
          const parsed = parseCapabilityRequirement(key);
          return !parsed.ok || parsed.value.key !== key;
        })
      )
        throw new Error("Invalid scarce resources");
      scarceResources = [...new Set(list as string[])];
    }
    // Only a shorter deadline is meaningful; it never lengthens the normal one.
    if (scarceAfterMs !== undefined && scarceAfterMs >= inactiveCancelAfterMs)
      throw new Error("Invalid scarce inactivity grace");
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
              "resource_policies",
              "adb_slots",
              "preferred_project",
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
      if (settings.resource_policies !== undefined)
        policies.set(
          machine,
          parseResourcePolicies(
            settings.resource_policies,
            resources.get(machine) ?? unlimited,
          ),
        );
      if (settings.adb_slots !== undefined)
        adbSlots.set(
          machine,
          parseAdbSlots(
            settings.adb_slots,
            resources.get(machine) ?? unlimited,
            policies.get(machine),
          ),
        );
      if (settings.preferred_project !== undefined) {
        if (
          typeof settings.preferred_project !== "string" ||
          !settings.preferred_project.trim()
        )
          throw new Error("Invalid preferred project");
        preferred.set(machine, settings.preferred_project);
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
      "run-capacity.yaml 必须包含 machines 映射；limit 不得超过 max_limit（默认 16），两者及可选 inactive_cancel_after_minutes、inbox_stall_after_minutes、queued_recheck_after_minutes、queued_migrate_after_minutes、queued_migration_cooldown_minutes、scarce_inactive_cancel_after_minutes 须为允许范围的正整数（最后一项须短于 inactive_cancel_after_minutes），scarce_resources 须为非空能力名列表，display_name 须为有效文字，resources 须按能力名设置正整数上限，adb_slots 的资源须已在 resources 中、端口范围有效且不与其它端口重叠。配置无效，暂停普通 Run 自动派发及失活回收",
    );
  }
  return result();
}
