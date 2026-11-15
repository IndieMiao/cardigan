import {
  autoAssignVerifier,
  beginSystemReviewLimitRaise,
  type Clock,
  finishSystemReviewLimitRaise,
  type ProjectId,
  remindSystemWaits,
  type SystemReviewLimitOutcome,
  validRoleRulePaths,
  validSystemReviewLimitMax,
} from "@cardigan/domain";
import { systemReviewLimitFailure } from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import type { StateLoader } from "./dispatch-state.js";
import type { MergeGit } from "./git.js";

/** Run before routing: successful assignment sends the delivery straight to its owner. */
export function runSystemRules(
  store: Store,
  project: ProjectId,
  clock: Clock,
  loadState: StateLoader = loadCommandState,
) {
  store.uow.run((tx) => {
    const actor = { kind: "system" as const, project_id: project };
    const ports = { clock, ids: tx.ids };
    let state = loadState(tx, project);
    if (
      state.project_preferences?.find((p) => p.id === project)
        ?.system_auto_assign_verifiers === true
    ) {
      for (const item of [...state.work_items].sort(
        (a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)),
      )) {
        if (item.kind !== "verify" || item.assignment_id || item.manual_assign)
          continue;
        const result = autoAssignVerifier(
          state,
          actor,
          { work_item_id: item.id },
          ports,
        );
        if (!result.ok) throw new Error(result.error.message);
        persistEffect(tx, project, result.value);
        if (result.value.events.length || result.value.changes.length)
          state = loadState(tx, project);
      }
    }
    const reminders = remindSystemWaits(state, actor, ports);
    if (!reminders.ok) throw new Error(reminders.error.message);
    persistEffect(tx, project, reminders.value);
  });
}

/** Git IO stays outside SQLite; the second transaction repeats all eligibility checks. */
export async function runSystemReviewLimits(
  store: Store,
  project: ProjectId,
  clock: Clock,
  prove: NonNullable<MergeGit["proveReviewLimit"]>,
  loadState: StateLoader = loadCommandState,
) {
  const actor = { kind: "system" as const, project_id: project };
  const decisions = store.uow.read((tx) => {
    const state = loadState(tx, project);
    const pref = state.project_preferences?.find((p) => p.id === project);
    if (
      pref?.system_review_limit_raise !== true ||
      !pref.system_review_limit_max_raises ||
      !validSystemReviewLimitMax(pref.system_review_limit_max_raises) ||
      !pref.role_rule_paths?.length ||
      !validRoleRulePaths(pref.role_rule_paths)
    )
      return [];
    const attempted = new Set(
      state.events
        .filter((e) => e.type === "system_review_limit_attempted")
        .map((e) => (e.payload as Record<string, unknown>).decision_id),
    );
    return state.decisions.filter(
      (q) =>
        q.trigger === "review_limit" &&
        q.status === "open" &&
        q.decider === "role:pm" &&
        !q.resolution &&
        !q.human_required_reason &&
        !attempted.has(q.id),
    );
  });
  for (const decision of decisions) {
    const claimed = store.uow.run((tx) => {
      const result = beginSystemReviewLimitRaise(
        loadState(tx, project),
        actor,
        { decision_id: decision.id },
        { clock, ids: tx.ids },
      );
      if (!result.ok) throw new Error(result.error.message);
      persistEffect(tx, project, result.value);
      return result.value.data;
    });
    if (!claimed) continue;
    let outcome: SystemReviewLimitOutcome;
    try {
      outcome = await prove(project, claimed.candidate);
    } catch (error) {
      // Also covers synchronous throws from a host adapter before it returns a Promise.
      outcome = systemReviewLimitFailure(error, "proof");
    }
    const failure =
      outcome && "failure" in outcome ? outcome.failure : undefined;
    const proof = outcome && "failure" in outcome ? null : outcome;
    store.uow.run((tx) => {
      const result = finishSystemReviewLimitRaise(
        loadState(tx, project),
        actor,
        {
          attempt_id: claimed.attempt_id,
          proof,
          ...(failure === undefined ? {} : { failure }),
        },
        { clock, ids: tx.ids },
      );
      if (!result.ok) throw new Error(result.error.message);
      persistEffect(tx, project, result.value);
    });
  }
}
