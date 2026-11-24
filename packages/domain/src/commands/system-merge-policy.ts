import { autoRiskMergeReason, autoRiskPaths } from "../auto-risk.js";
import { categoryDelegated } from "../decision-authorization.js";
import type { Decision } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import {
  autoMergeOn,
  mergePathMatches,
  validMergePathList,
} from "../preferences.js";
import type { CommandState } from "./core.js";
import { mergeNeedsHuman } from "./delegation.js";
import { roleRuleDeliveries } from "./role-rule-implementation.js";

// C-670: read only preference updates through the typed index, never a scan
// over the whole history on every merge decision.
const preferenceEvents = (state: CommandState) =>
  eventsOfType(state.events, "project_preferences_updated");
/** Bind the current human opt-in; legacy A3 retains its original audited policy. */
export function systemMergeAuthority(state: CommandState): string | undefined {
  const p = state.project_preferences?.find((p) => p.id === state.project_id);
  if (autoMergeOn(p)) {
    const audit = preferenceEvents(state).findLast(
      (e) =>
        e.actor.project_id === state.project_id &&
        (e.payload as { preference?: string })?.preference === "auto_merge",
    );
    if (
      audit?.actor.kind !== "human" ||
      (audit.payload as { new_value?: unknown }).new_value !== "on"
    )
      return;
    return JSON.stringify({
      source: "project_preferences.auto_merge",
      project_id: state.project_id,
      event_id: audit.id,
    });
  }
  if (p?.auto_merge === "off") return;
  const paths = p?.system_merge_shadow_policy?.release_paths;
  if ((p?.flow_version ?? 1) < 4 || !validMergePathList(paths)) return;
  const audit = (key: string) =>
    preferenceEvents(state).findLast(
      (e) =>
        e.actor.project_id === state.project_id &&
        (e.payload as { preference?: string } | null)?.preference === key,
    );
  const flow = audit("flow_version"),
    policy = audit("system_merge_shadow_policy");
  if (
    flow?.actor.kind !== "human" ||
    policy?.actor.kind !== "human" ||
    (flow.payload as { new_value?: unknown }).new_value !== p?.flow_version ||
    JSON.stringify(
      (
        (policy.payload as { new_value?: unknown }).new_value as {
          release_paths?: unknown;
        } | null
      )?.release_paths,
    ) !== JSON.stringify(paths)
  )
    return;
  return JSON.stringify({
    source: "project_preferences.flow_version",
    project_id: state.project_id,
    flow_event_id: flow.id,
    release_policy_event_id: policy.id,
  });
}

export const DISABLED_MERGE_GATE_REASON =
  "项目未启用合并检查，须由人确认合并。";

/** Derive personal consent requirements; ordinary readiness belongs to merge blockers. */
export function systemMergeHumanReason(
  state: CommandState,
  q: Decision,
): string | undefined {
  const card = state.cards.find((c) => c.id === q.card_id);
  if (state.project_settings?.merge_gate_enabled === false)
    return DISABLED_MERGE_GATE_REASON;
  if (!card) return "缺少当前卡片，合并须交人确认。";
  if (q.source_unrelated_human_required)
    return (
      q.human_required_reason ?? "来源无关标记保留的其它原因仍须由人确认。"
    );
  const preference = state.project_preferences?.find(
    (p) => p.id === state.project_id,
  );
  const personal = mergeNeedsHuman(
    state.decisions,
    state.cards,
    card.id,
    preference,
    state.events,
  );
  if (personal) return personal;
  const lite = autoMergeOn(
    state.project_preferences?.find((p) => p.id === state.project_id),
  );
  if (!lite) {
    const evidence = autoRiskMergeReason(state, card.id);
    if (evidence) return evidence;
  }
  const deliveries = roleRuleDeliveries(state, q);
  const paths =
    state.project_preferences?.find((p) => p.id === state.project_id)
      ?.system_merge_shadow_policy?.release_paths ?? (lite ? [] : undefined);
  if (!validMergePathList(paths))
    return "尚未由人显式配置发布路径，合并须交人确认。";
  if (
    !categoryDelegated(preference, state.events, "publish") &&
    deliveries.some((v) =>
      autoRiskPaths(v)?.some((path) =>
        paths.some((pattern) => mergePathMatches(path, pattern)),
      ),
    )
  )
    return "当前交付命中对外发布路径，合并须由人确认。";
  if (!lite && !systemMergeAuthority(state))
    return "缺少当前项目流程版本或发布路径的人授权事件，合并须交人确认。";
  return undefined;
}

export function systemMergeEnabled(
  state: Pick<CommandState, "project_id" | "project_preferences">,
  card: import("../entities.js").Card,
) {
  const p = state.project_preferences?.find((p) => p.id === state.project_id);
  return (
    autoMergeOn(p) ||
    (p?.auto_merge === undefined && (card.flow_version ?? 1) >= 4)
  );
}
