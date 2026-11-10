import type { Actor } from "../entities.js";
import {
  type DecisionCategory,
  decisionCategories,
  decisionDelegation,
  highRiskCategories,
  validAutoMergeMinutes,
} from "../preferences.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { handoffUnauthorizedDecisions } from "./delegation.js";

export function projectPreferences(state: CommandState) {
  return (
    state.project_preferences?.find((p) => p.id === state.project_id) ?? {
      id: state.project_id,
      auto_merge_after_minutes: null,
    }
  );
}

export function setProjectPreferences(
  state: CommandState,
  actor: Actor,
  input: {
    auto_merge_after_minutes?: number | null;
    decision_delegation?: Partial<Record<DecisionCategory, boolean>>;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "set_project_preferences", ports, (d) => {
    ensure(
      actor.kind === "human",
      "unauthorized",
      "Only the human can change project preferences",
    );
    ensure(
      input.auto_merge_after_minutes === undefined ||
        validAutoMergeMinutes(input.auto_merge_after_minutes),
      "validation_failed",
      "自动合并等待时间须为 1 到 1440 的整数分钟，或 null（关闭）",
    );
    const old = projectPreferences(state);
    ensure(
      input.auto_merge_after_minutes !== undefined ||
        input.decision_delegation !== undefined,
      "validation_failed",
      "No preference supplied",
    );
    const delegation = { ...decisionDelegation(old) };
    for (const [category, enabled] of Object.entries(
      input.decision_delegation ?? {},
    )) {
      ensure(
        decisionCategories.includes(category as DecisionCategory) &&
          typeof enabled === "boolean",
        "validation_failed",
        "Unknown decision category or authorization",
      );
      ensure(
        !highRiskCategories.includes(category as DecisionCategory),
        "unauthorized",
        "高风险类别固定由人在 Workbench 确认",
      );
      delegation[category as DecisionCategory] = enabled;
    }
    const next = {
      ...old,
      auto_merge_after_minutes:
        input.auto_merge_after_minutes === undefined
          ? old.auto_merge_after_minutes
          : input.auto_merge_after_minutes,
      ...(input.decision_delegation ? { decision_delegation: delegation } : {}),
    };
    const mergeChanged =
      old.auto_merge_after_minutes !== next.auto_merge_after_minutes;
    const delegationChanged = decisionCategories.some(
      (c) => decisionDelegation(old)[c] !== delegation[c],
    );
    if (!mergeChanged && !delegationChanged) return old;
    d.put("project_preferences", next);
    if (mergeChanged)
      d.emit("project_preferences_updated", undefined, {
        old_value: old.auto_merge_after_minutes,
        new_value: next.auto_merge_after_minutes,
        preference: "auto_merge_after_minutes",
      });
    if (delegationChanged) {
      d.emit("project_preferences_updated", undefined, {
        old_value: decisionDelegation(old),
        new_value: delegation,
        preference: "decision_delegation",
      });
      handoffUnauthorizedDecisions(d, "项目授权已关闭，此拍板转交给你。");
    }
    return next;
  });
}
