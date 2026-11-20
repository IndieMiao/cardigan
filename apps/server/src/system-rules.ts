import {
  autoAssignProducer,
  autoAssignVerifier,
  beginSystemReviewLimitRaise,
  type Clock,
  cardCriticalPathLengths,
  finishSystemReviewLimitRaise,
  flowAtLeast,
  maintainPmCoordination,
  type ProjectId,
  refreshCancelledHumanActions,
  refreshCardDependencies,
  refreshHumanActionFollowUps,
  refreshRequiredVerifiers,
  refreshTestReviewLimits,
  remindSystemWaits,
  resumeWorkWaits,
  type SystemReviewLimitOutcome,
  systemCompleteCard,
  validRoleRulePaths,
  validSystemReviewLimitMax,
} from "@cardigan/domain";
import {
  rotateIdleDeployedRoles,
  systemReviewLimitFailure,
} from "@cardigan/host";
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
  baseline?: { branch: string; sha: string },
  {
    baselineConflictMaxResumes: conflictMaxResumes,
    authorPrecheckFailureLimit,
    frameworkWaitReminderMs,
  }: {
    baselineConflictMaxResumes?: number;
    authorPrecheckFailureLimit?: number;
    frameworkWaitReminderMs?: number;
  } = {},
) {
  rotateIdleDeployedRoles(store, project, loadState);
  store.uow.run((tx) => {
    const actor = { kind: "system" as const, project_id: project };
    const ports = { clock, ids: tx.ids };
    let state = loadState(tx, project);
    const dependencies = refreshCardDependencies(
      state,
      actor,
      ports,
      frameworkWaitReminderMs,
    );
    if (!dependencies.ok) throw new Error(dependencies.error.message);
    persistEffect(tx, project, dependencies.value);
    if (dependencies.value.changes.length || dependencies.value.events.length)
      state = loadState(tx, project);
    const cancelledCards = new Set(
      state.cards.filter((c) => c.status === "cancelled").map((c) => c.id),
    );
    if (
      state.human_actions.some(
        (h) =>
          h.status === "open" && h.card_id && cancelledCards.has(h.card_id),
      )
    ) {
      const cancelled = refreshCancelledHumanActions(state, actor, ports);
      if (!cancelled.ok) throw new Error(cancelled.error.message);
      persistEffect(tx, project, cancelled.value);
      state = loadState(tx, project);
    }
    const waits = resumeWorkWaits(
      state,
      actor,
      {
        ...(baseline ? { baseline } : {}),
        ...(authorPrecheckFailureLimit !== undefined
          ? { precheck_failure_limit: authorPrecheckFailureLimit }
          : {}),
        ...(conflictMaxResumes !== undefined
          ? { conflict_max_resumes: conflictMaxResumes }
          : {}),
      },
      ports,
    );
    if (!waits.ok) throw new Error(waits.error.message);
    persistEffect(tx, project, waits.value);
    if (waits.value.events.length) state = loadState(tx, project);
    const coordination = maintainPmCoordination(state, actor, ports);
    if (!coordination.ok) throw new Error(coordination.error.message);
    persistEffect(tx, project, coordination.value);
    if (coordination.value.events.length) state = loadState(tx, project);
    const lengths = cardCriticalPathLengths(state);
    const priorities = new Map(state.cards.map((c) => [c.id, c.priority]));
    for (const item of [...state.work_items].sort(
      (a, b) =>
        (priorities.get(b.card_id) ?? 0) - (priorities.get(a.card_id) ?? 0) ||
        (lengths.get(b.card_id) ?? 0) - (lengths.get(a.card_id) ?? 0),
    )) {
      if (item.kind !== "produce" || item.assignment_id || item.manual_assign)
        continue;
      const assigned = autoAssignProducer(
        state,
        actor,
        { work_item_id: item.id },
        ports,
      );
      if (!assigned.ok) throw new Error(assigned.error.message);
      persistEffect(tx, project, assigned.value);
      if (assigned.value.changes.length || assigned.value.events.length)
        state = loadState(tx, project);
    }
    if (
      state.human_actions.some(
        (h) =>
          h.status === "open" &&
          h.blocked_work_items.length &&
          h.blocks_merge === undefined,
      )
    ) {
      const followUps = refreshHumanActionFollowUps(state, actor, ports);
      if (!followUps.ok) throw new Error(followUps.error.message);
      persistEffect(tx, project, followUps.value);
      if (followUps.value.changes.length) state = loadState(tx, project);
    }
    if (
      state.deliveries.length &&
      state.work_items.some(
        (w) =>
          w.kind === "verify" &&
          w.required &&
          w.target_work_item_id &&
          w.status === "todo",
      )
    ) {
      const bindings = refreshRequiredVerifiers(state, actor, ports);
      if (!bindings.ok) throw new Error(bindings.error.message);
      persistEffect(tx, project, bindings.value);
      if (bindings.value.changes.length) state = loadState(tx, project);
    }
    if (
      state.deliveries.length &&
      state.work_items.some(
        (w) =>
          w.kind === "verify" &&
          ["ready", "waiting_decision"].includes(w.status),
      )
    ) {
      const limits = refreshTestReviewLimits(state, actor, ports);
      if (!limits.ok) throw new Error(limits.error.message);
      persistEffect(tx, project, limits.value);
      if (limits.value.changes.length) state = loadState(tx, project);
    }
    for (const card of state.cards) {
      if (
        !flowAtLeast(card, 5) ||
        ["backlog", "todo", "done", "cancelled"].includes(card.status)
      )
        continue;
      const completion = systemCompleteCard(
        state,
        actor,
        { card_id: card.id },
        ports,
      );
      if (!completion.ok) throw new Error(completion.error.message);
      persistEffect(tx, project, completion.value);
      if (completion.value.changes.length || completion.value.events.length)
        state = loadState(tx, project);
    }
    if (
      state.cards.some((card) => flowAtLeast(card, 5)) ||
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
