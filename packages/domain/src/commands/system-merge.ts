import type { Actor, Decision } from "../entities.js";
import { flowAtLeast } from "../flow.js";
import type { DecisionId } from "../ids.js";
import { autoMergePaused } from "../preferences.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import {
  mergePlan,
  syncRiskTagMerge,
  syncScreenshotMerge,
  syncSystemMerge,
} from "./merge.js";
import { systemMergeBlockers } from "./merge-delegation.js";
import {
  systemMergeAuthority,
  systemMergeHumanReason,
} from "./system-merge-policy.js";

/** Internal only: the caller supplies neither an answer nor authorization evidence. */
export function systemConfirmMerge(
  state: CommandState,
  actor: Actor,
  p: { decision_id: DecisionId },
  ports: CommandPorts,
) {
  return command(state, actor, "system_confirm_merge", ports, (d) => {
    const q = state.decisions.find((q) => q.id === p.decision_id);
    const card = state.cards.find((c) => c.id === q?.card_id);
    ensure(
      q?.trigger === "merge_confirmation" &&
        q.decider === "system" &&
        card &&
        flowAtLeast(card, 4),
      "illegal_transition",
      "不是当前系统合并确认",
    );
    // These synchronize only stale authority, never ordinary not-yet-ready gates.
    syncSystemMerge(d, card);
    syncRiskTagMerge(d, card);
    syncScreenshotMerge(d, card);
    const current = d.list("decisions").find((v) => v.id === q.id);
    if (current?.status === "superseded" || current?.decider !== "system")
      return current ?? q;
    if (q.status === "resolved") return q;
    ensure(q.status === "open", "illegal_transition", "系统合并确认尚未就绪");
    ensure(
      !autoMergePaused(
        state.project_preferences?.find((p) => p.id === state.project_id),
      ),
      "illegal_transition",
      "自动合并已暂停",
    );
    ensure(
      !systemMergeHumanReason(state, q),
      "illegal_transition",
      "系统合并须交人确认",
    );
    const blockers = systemMergeBlockers(state, q);
    ensure(!blockers.length, "illegal_transition", blockers.join("；"));
    const proxy_authority = systemMergeAuthority(state);
    ensure(proxy_authority, "illegal_transition", "缺少人的项目授权事件");
    const notice = `${card.id} 已满足全部合并门禁，系统确认合并；发布仍须通过当前检查和发布前重查。`;
    const result: Decision = {
      ...q,
      status: "resolved",
      resolution: {
        option: "merge",
        rationale: notice,
        raw_quote: "",
        resolved_by: "system",
        via: "system_rule",
        via_chain: ["system"],
        proxy_authority,
        notice,
        at: d.now,
      },
    };
    const plan = mergePlan(
      {
        ...state,
        decisions: state.decisions.map((v) => (v.id === q.id ? result : v)),
      },
      card.id,
    );
    ensure(plan.ok, "illegal_transition", plan.ok ? "" : plan.error.message);
    d.put("decisions", result);
    d.emit(
      "decision_resolved",
      card.id,
      {
        decision_id: q.id,
        option: "merge",
        status: "resolved",
        via: "system_rule",
        rule: "flow-v2/A3",
        proxy_authority,
        notice,
        resume_work_items: [],
      },
      { type: "decision_resolved", decision_id: q.id, body: notice },
    );
    return result;
  });
}
