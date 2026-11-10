import type { Actor } from "../entities.js";
import {
  type DecisionCategory,
  decisionCategories,
  decisionDelegation,
  highRiskCategories,
  isBoardLane,
  pmMergeConfirmation,
  validAutoMergeMinutes,
} from "../preferences.js";
import { states } from "../states.js";
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
    pm_merge_confirmation?: boolean;
    /** A patch: only the listed lanes change; null forgets the human setting. */
    board_collapsed_lanes?: Readonly<Record<string, boolean | null>>;
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
        input.decision_delegation !== undefined ||
        input.pm_merge_confirmation !== undefined ||
        input.board_collapsed_lanes !== undefined,
      "validation_failed",
      "No preference supplied",
    );
    ensure(
      input.pm_merge_confirmation === undefined ||
        typeof input.pm_merge_confirmation === "boolean",
      "validation_failed",
      "pm_merge_confirmation must be a boolean",
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
        "高风险类别固定由人确认（Workbench 或本机 CLI）",
      );
      delegation[category as DecisionCategory] = enabled;
    }
    const lanes: Partial<Record<string, boolean>> = {
      ...old.board_collapsed_lanes,
    };
    for (const [lane, collapsed] of Object.entries(
      input.board_collapsed_lanes ?? {},
    )) {
      ensure(
        isBoardLane(lane) &&
          (collapsed === null || typeof collapsed === "boolean"),
        "validation_failed",
        "Unknown board lane or collapse setting",
      );
      if (collapsed === null) delete lanes[lane];
      else lanes[lane] = collapsed;
    }
    const next = {
      ...old,
      auto_merge_after_minutes:
        input.auto_merge_after_minutes === undefined
          ? old.auto_merge_after_minutes
          : input.auto_merge_after_minutes,
      ...(input.decision_delegation ? { decision_delegation: delegation } : {}),
      ...(input.pm_merge_confirmation !== undefined
        ? { pm_merge_confirmation: input.pm_merge_confirmation }
        : {}),
      ...(input.board_collapsed_lanes ? { board_collapsed_lanes: lanes } : {}),
    };
    const mergeChanged =
      old.auto_merge_after_minutes !== next.auto_merge_after_minutes;
    const delegationChanged = decisionCategories.some(
      (c) => decisionDelegation(old)[c] !== delegation[c],
    );
    const pmMergeChanged =
      pmMergeConfirmation(old) !== pmMergeConfirmation(next);
    const oldLanes: Partial<Record<string, boolean>> =
      old.board_collapsed_lanes ?? {};
    const lanesChanged =
      input.board_collapsed_lanes !== undefined &&
      states.card.some((lane) => oldLanes[lane] !== lanes[lane]);
    if (!mergeChanged && !delegationChanged && !pmMergeChanged && !lanesChanged)
      return old;
    // Lane folding is a view setting: it is stored for every device but emits
    // no audit event, so toggling a lane never feeds the activity stream.
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
    if (pmMergeChanged) {
      d.emit("project_preferences_updated", undefined, {
        old_value: pmMergeConfirmation(old),
        new_value: pmMergeConfirmation(next),
        preference: "pm_merge_confirmation",
      });
      // Turning it off returns open PM merge confirmations to the human.
      handoffUnauthorizedDecisions(
        d,
        "合并由 PM 代确认已关闭，此合并确认转交给你。",
      );
    }
    return next;
  });
}
