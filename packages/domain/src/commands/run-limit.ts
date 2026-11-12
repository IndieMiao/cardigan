import type { Clock } from "../clock.js";
import type { Machine } from "../entities.js";
import type { Result } from "../errors.js";
import type { GlobalActor, GlobalEvent, GlobalIdAllocator } from "../global.js";
import type { MemberId } from "../ids.js";
import {
  DEFAULT_MAX_RUN_LIMIT,
  runLimitMaximumMessage,
} from "../run-capacity.js";
import { attempt, ensure } from "./core.js";

export interface RunLimitSetting {
  readonly machine_id: string;
  readonly limit: number;
  readonly updated_at: string;
  readonly updated_by: MemberId;
}
export interface RunLimitEffect {
  readonly setting: RunLimitSetting;
  readonly event: GlobalEvent;
}

/** Global host setting: no assignment role or tool grant can delegate this authority. */
export function setRunLimit(
  actor: GlobalActor,
  input: { readonly machine_id: string; readonly limit: number },
  context: {
    readonly machines: readonly Pick<Machine, "id">[];
    readonly previous: number;
    readonly maximum?: number;
    readonly member_id: MemberId;
    readonly clock: Clock;
    readonly ids: Pick<GlobalIdAllocator, "nextEventId" | "nextEventSequence">;
  },
): Result<RunLimitEffect> {
  return attempt(() => {
    ensure(
      actor.kind === "human",
      "forbidden_tool",
      "只有人可以修改 Agent 并发上限",
    );
    ensure(
      context.machines.some((machine) => machine.id === input.machine_id),
      "not_found",
      "Agent 机器未登记或使用",
    );
    ensure(
      Number.isSafeInteger(input.limit) && input.limit > 0,
      "validation_failed",
      "并发上限必须为正整数",
    );
    ensure(
      context.previous > 0,
      "validation_failed",
      "主机并发配置无效，请联系主机管理员",
    );
    const maximum = context.maximum ?? DEFAULT_MAX_RUN_LIMIT;
    ensure(
      Number.isSafeInteger(maximum) && maximum > 0,
      "validation_failed",
      "主机并发配置无效，请联系主机管理员",
    );
    ensure(
      input.limit <= maximum,
      "validation_failed",
      runLimitMaximumMessage(maximum),
    );
    const now = context.clock.now();
    return {
      setting: { ...input, updated_at: now, updated_by: context.member_id },
      event: {
        id: context.ids.nextEventId(),
        seq: context.ids.nextEventSequence(),
        type: "run_capacity_updated",
        actor: { kind: "human" },
        created_at: now,
        payload: {
          machine_id: input.machine_id,
          member_id: context.member_id,
          old_value: context.previous,
          new_value: input.limit,
        },
      },
    };
  });
}
