import type { Clock } from "../clock.js";
import type { JsonValue, Machine } from "../entities.js";
import type { Result } from "../errors.js";
import type { GlobalActor, GlobalEvent, GlobalIdAllocator } from "../global.js";
import type { MemberId } from "../ids.js";
import { parseCapabilityRequirement } from "../machine-requirements.js";
import { attempt, ensure } from "./core.js";

/** C-792: one project's ceiling on one machine; it replaces the YAML entry. */
export interface ProjectQuotaOverride {
  readonly limit?: number;
  readonly resources: Readonly<Record<string, number>>;
}
/**
 * C-792: live database overrides of a machine's resource slots and project
 * ceilings. YAML stays the default for everything not listed here.
 */
export interface CapacityOverride {
  readonly machine_id: string;
  readonly resources: Readonly<Record<string, number>>;
  readonly projects: Readonly<Record<string, ProjectQuotaOverride>>;
  readonly updated_at: string;
  readonly updated_by: MemberId;
}
export type CapacityOverrideChange =
  | {
      readonly kind: "set_resource";
      readonly machine_id: string;
      readonly key: string;
      readonly slots: number;
    }
  | {
      readonly kind: "clear_resource";
      readonly machine_id: string;
      readonly key: string;
    }
  | {
      readonly kind: "set_project_quota";
      readonly machine_id: string;
      readonly project_id: string;
      readonly limit?: number;
      readonly resources?: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: "clear_project_quota";
      readonly machine_id: string;
      readonly project_id: string;
    };
export interface CapacityOverrideEffect {
  /** null: nothing is overridden any more; the row is removed. */
  readonly override: CapacityOverride | null;
  readonly event: GlobalEvent;
}
/** The trusted YAML view of one machine that an override is checked against. */
export interface CapacityOverrideBase {
  readonly valid: boolean;
  /** YAML resource slots of this machine. */
  readonly resources: ReadonlyMap<string, number>;
  /** Keys tied to adb slots or fixed device bindings; only YAML may change them. */
  readonly pinned: ReadonlySet<string>;
  /** YAML max_limit of this machine. */
  readonly maximum: number;
}

const within = (value: unknown, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= max;

/** Global host setting: no assignment role or tool grant can delegate this authority. */
export function changeCapacityOverride(
  actor: GlobalActor,
  input: CapacityOverrideChange,
  context: {
    readonly machines: readonly Pick<Machine, "id">[];
    readonly projects: readonly string[];
    readonly current: CapacityOverride | undefined;
    readonly base: CapacityOverrideBase;
    readonly member_id: MemberId;
    readonly clock: Clock;
    readonly ids: Pick<GlobalIdAllocator, "nextEventId" | "nextEventSequence">;
  },
): Result<CapacityOverrideEffect> {
  return attempt(() => {
    ensure(
      actor.kind === "human",
      "forbidden_tool",
      "只有人可以修改资源名额和项目上限",
    );
    ensure(
      context.machines.some((machine) => machine.id === input.machine_id),
      "not_found",
      "Agent 机器未登记或使用",
    );
    const base = context.base;
    ensure(
      base.valid && Number.isSafeInteger(base.maximum) && base.maximum > 0,
      "validation_failed",
      "主机并发配置无效，请联系主机管理员",
    );
    const current = context.current;
    const resources: Record<string, number> = { ...current?.resources };
    const projects: Record<string, ProjectQuotaOverride> = {
      ...current?.projects,
    };
    let old_value: JsonValue = null;
    let new_value: JsonValue = null;
    if (input.kind === "set_resource" || input.kind === "clear_resource") {
      const parsed = parseCapabilityRequirement(input.key);
      ensure(
        parsed.ok && parsed.value.key === input.key,
        "validation_failed",
        "资源名必须是能力名",
      );
      ensure(
        !base.pinned.has(input.key),
        "validation_failed",
        `资源 ${input.key} 绑定了 adb 端口或固定设备，名额仍需在 run-capacity.yaml 修改`,
      );
      old_value = resources[input.key] ?? null;
      if (input.kind === "set_resource") {
        ensure(
          within(input.slots) && input.slots > 0,
          "validation_failed",
          "资源名额必须为正整数",
        );
        resources[input.key] = input.slots;
        new_value = input.slots;
      } else {
        ensure(
          old_value !== null,
          "not_found",
          `资源 ${input.key} 没有数据库覆盖值`,
        );
        ensure(
          base.resources.has(input.key) ||
            !Object.values(projects).some(
              (quota) => quota.resources[input.key] !== undefined,
            ),
          "validation_failed",
          `资源 ${input.key} 仍被项目上限引用，请先清除这些项目上限`,
        );
        delete resources[input.key];
      }
    } else {
      ensure(
        context.projects.includes(input.project_id),
        "not_found",
        "项目未登记",
      );
      old_value = (projects[input.project_id] ?? null) as JsonValue;
      if (input.kind === "set_project_quota") {
        ensure(
          input.limit !== undefined ||
            Object.keys(input.resources ?? {}).length > 0,
          "validation_failed",
          "项目上限至少要设置并发上限或一项资源上限",
        );
        ensure(
          input.limit === undefined || within(input.limit, base.maximum),
          "validation_failed",
          `项目并发上限必须是 0 到 ${base.maximum} 的整数`,
        );
        const quota: Record<string, number> = {};
        for (const [key, value] of Object.entries(input.resources ?? {})) {
          const total = resources[key] ?? base.resources.get(key);
          ensure(
            total !== undefined,
            "validation_failed",
            `资源 ${key} 不在这台机器的资源名额中`,
          );
          ensure(
            within(value, total),
            "validation_failed",
            `项目的资源 ${key} 上限必须是 0 到 ${total} 的整数`,
          );
          quota[key] = value;
        }
        const next: ProjectQuotaOverride = {
          resources: quota,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        };
        projects[input.project_id] = next;
        new_value = next as unknown as JsonValue;
      } else {
        ensure(
          old_value !== null,
          "not_found",
          `项目 ${input.project_id} 没有数据库覆盖的上限`,
        );
        delete projects[input.project_id];
      }
    }
    const now = context.clock.now();
    const empty =
      !Object.keys(resources).length && !Object.keys(projects).length;
    return {
      override: empty
        ? null
        : {
            machine_id: input.machine_id,
            resources,
            projects,
            updated_at: now,
            updated_by: context.member_id,
          },
      event: {
        id: context.ids.nextEventId(),
        seq: context.ids.nextEventSequence(),
        type: "run_capacity_override_updated",
        actor: { kind: "human" },
        created_at: now,
        payload: {
          machine_id: input.machine_id,
          member_id: context.member_id,
          change: input.kind,
          ...("key" in input ? { key: input.key } : {}),
          ...("project_id" in input ? { project_id: input.project_id } : {}),
          old_value,
          new_value,
        },
      },
    };
  });
}
