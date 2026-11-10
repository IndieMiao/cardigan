import type { Actor } from "../entities.js";
import { validAutoMergeMinutes } from "../preferences.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

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
  input: { auto_merge_after_minutes: number | null },
  ports: CommandPorts,
) {
  return command(state, actor, "set_project_preferences", ports, (d) => {
    ensure(
      actor.kind === "human",
      "unauthorized",
      "Only the human can change project preferences",
    );
    ensure(
      validAutoMergeMinutes(input.auto_merge_after_minutes),
      "validation_failed",
      "自动合并等待时间须为 1 到 1440 的整数分钟，或 null（关闭）",
    );
    const old = projectPreferences(state);
    const next = {
      id: state.project_id,
      auto_merge_after_minutes: input.auto_merge_after_minutes,
    };
    if (old.auto_merge_after_minutes === next.auto_merge_after_minutes)
      return old;
    d.put("project_preferences", next);
    d.emit("project_preferences_updated", undefined, {
      old_value: old.auto_merge_after_minutes,
      new_value: next.auto_merge_after_minutes,
      preference: "auto_merge_after_minutes",
    });
    return next;
  });
}
