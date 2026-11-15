import type { Assignment } from "../entities.js";
import type { CommandDraft } from "./core.js";
import { handoffUnauthorizedDecisions, hasActivePmOps } from "./delegation.js";
import { syncHumanDecidedMerges } from "./merge.js";

/** Coordinate decision, merge and human-action handoffs after PM Ops stops. */
export function handoffWithoutOps(d: CommandDraft, assignment: Assignment) {
  if (
    assignment.scope !== "standing" ||
    assignment.role_id !== "pm" ||
    assignment.standing_mode !== "ops"
  )
    return;
  const reason = `后台项目经理 ${assignment.id} 已${assignment.status === "suspended" ? "暂停" : "释放"}，项目已无活跃后台，待处理事项转交给你。`;
  handoffUnauthorizedDecisions(d, reason, assignment.id);
  syncHumanDecidedMerges(d);
  if (hasActivePmOps(d, "triage_human_action")) return;
  for (const action of d.list("human_actions")) {
    if (action.status !== "open") continue;
    // C-212: nobody is left to release a manual condition, so it is released
    // now; triaged actions waiting for it would otherwise stay hidden.
    const unreleased =
      action.ready_when?.kind === "manual" && !action.ready_released;
    if (action.triage !== "pm_ops" && !unreleased) continue;
    const released = unreleased
      ? { ready_released: { at: d.now, by: d.author, reason } }
      : {};
    if (action.triage !== "pm_ops") {
      d.put("human_actions", { ...action, ...released });
      d.emit(
        "human_action_requested",
        action.card_id,
        {
          human_action_id: action.id,
          disposition: action.triage ?? "human",
          released: true,
          reason,
        },
        { type: "human_action", human_action_id: action.id, body: reason },
      );
      continue;
    }
    d.put("human_actions", {
      ...action,
      ...released,
      triage: "human",
      triage_rationale: reason,
    });
    d.emit(
      "human_action_requested",
      action.card_id,
      { human_action_id: action.id, reason },
      { type: "human_action", human_action_id: action.id, body: reason },
    );
  }
}
