import {
  autoAssignProducer,
  autoAssignVerifier,
  beginSystemReviewLimitRaise,
  type Clock,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  cardCriticalPathLengths,
  cardWatchesPending,
  finishSystemReviewLimitRaise,
  flowAtLeast,
  maintainPmCoordination,
  maintainStorySummaries,
  type ProjectId,
  preparationAwaitsDeployment,
  type Result,
  refreshCancelledHumanActions,
  refreshCardDependencies,
  refreshHumanActionFollowUps,
  refreshRequiredVerifiers,
  refreshTestReviewLimits,
  remindSystemWaits,
  resumeWorkWaits,
  retryPreparationAfterDeployment,
  type SystemReviewLimitOutcome,
  settleCardWatches,
  systemCompleteCard,
  validRoleRulePaths,
  validSystemReviewLimitMax,
} from "@cardigan/domain";
import {
  rotateIdleDeployedRoles,
  systemReviewLimitFailure,
} from "@cardigan/host";
import {
  effectWrites,
  loadCommandState,
  persistEffect,
} from "@cardigan/mcp-server";
import { latestReadyDeploymentSha, type Store } from "@cardigan/store";
import type { StateLoader } from "./dispatch-state.js";
import type { MergeGit } from "./git.js";

type SystemStep = (
  state: CommandState,
  ports: CommandPorts,
) => Result<CommandEffect<unknown>> | undefined;

/**
 * C-641: run `steps` in order, each against the state left by the previous
 * one. A run of steps without effect shares one read snapshot and takes no
 * writer lock; each non-empty effect commits alone through `Store.optimistic`
 * (read set revalidated, bounded retries, then the pessimistic fallback) and
 * the next step reads the committed state. A rejected rule throws; the effects
 * already committed by earlier steps stay, like separate system commands.
 */
function runSystemSteps(
  store: Store,
  project: ProjectId,
  clock: Clock,
  loadState: StateLoader,
  steps: readonly SystemStep[],
): void {
  let next = 0;
  while (next < steps.length) {
    const from = next;
    next = store.uow.optimistic(project, (tx) => {
      const state = loadState(tx, project);
      const ports = {
        clock,
        ids: tx.ids,
        ...(tx.platformDeployments
          ? { platform_deployments: tx.platformDeployments }
          : {}),
      };
      for (let index = from; index < steps.length; index++) {
        const result = steps[index]?.(state, ports);
        if (!result) continue;
        if (!result.ok) throw new Error(result.error.message);
        const effect = result.value;
        if (effectWrites(effect))
          return {
            value: index + 1,
            write: (w) => persistEffect(w, project, effect),
          };
      }
      return { value: steps.length };
    });
  }
}

/** Run before routing: successful assignment sends the delivery straight to its owner. */
export function runSystemRules(
  store: Store,
  project: ProjectId,
  clock: Clock,
  loadState: StateLoader = loadCommandState,
  baseline?: { branch: string; sha: string },
  {
    mergeGateEnabled,
    baselineConflictMaxResumes: conflictMaxResumes,
    authorPrecheckFailureLimit,
    frameworkWaitReminderMs,
    storySummaryHandoffMs,
  }: {
    mergeGateEnabled?: (project: ProjectId) => boolean;
    baselineConflictMaxResumes?: number;
    authorPrecheckFailureLimit?: number;
    frameworkWaitReminderMs?: number;
    storySummaryHandoffMs?: number;
  } = {},
) {
  rotateIdleDeployedRoles(store, project, loadState);
  const actor = { kind: "system" as const, project_id: project };
  const run = (steps: readonly SystemStep[]) =>
    runSystemSteps(store, project, clock, loadState, steps);
  const read = () => store.uow.read((tx) => loadState(tx, project));
  run([
    (state, ports) =>
      refreshCardDependencies(state, actor, ports, frameworkWaitReminderMs),
    // C-763: one bell per settled PM watch; never changes either card.
    (state, ports) =>
      cardWatchesPending(state)
        ? settleCardWatches(state, actor, ports)
        : undefined,
    (state, ports) => {
      const cancelledCards = new Set(
        state.cards.filter((c) => c.status === "cancelled").map((c) => c.id),
      );
      return state.human_actions.some(
        (h) =>
          h.status === "open" && h.card_id && cancelledCards.has(h.card_id),
      )
        ? refreshCancelledHumanActions(state, actor, ports)
        : undefined;
    },
    (state, ports) =>
      resumeWorkWaits(
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
      ),
    (state, ports) => maintainPmCoordination(state, actor, ports),
    // C-762: external Office summary waits; cheap when no story settled.
    (state, ports) =>
      state.cards.some((c) => c.story && !c.story.summary_entry_id)
        ? maintainStorySummaries(state, actor, ports, storySummaryHandoffMs)
        : undefined,
    // C-738: once per ready deployment, retry preparation failures from before it.
    (state, ports) => {
      if (!preparationAwaitsDeployment(state, clock.now())) return undefined;
      const sha = latestReadyDeploymentSha(store.database);
      return sha
        ? retryPreparationAfterDeployment(state, actor, { sha }, ports)
        : undefined;
    },
  ]);
  // Order and candidates come from the state at the start of each loop; every
  // command rechecks its item against the state it actually runs on.
  let state = read();
  const lengths = cardCriticalPathLengths(state);
  const priorities = new Map(state.cards.map((c) => [c.id, c.priority]));
  run(
    [...state.work_items]
      .sort(
        (a, b) =>
          (priorities.get(b.card_id) ?? 0) - (priorities.get(a.card_id) ?? 0) ||
          (lengths.get(b.card_id) ?? 0) - (lengths.get(a.card_id) ?? 0),
      )
      .filter(
        (item) =>
          item.kind === "produce" && !item.assignment_id && !item.manual_assign,
      )
      .map(
        (item): SystemStep =>
          (current, ports) =>
            autoAssignProducer(
              current,
              actor,
              { work_item_id: item.id },
              ports,
            ),
      ),
  );
  run([
    (current, ports) =>
      current.human_actions.some(
        (h) =>
          h.status === "open" &&
          h.blocked_work_items.length &&
          h.blocks_merge === undefined,
      )
        ? refreshHumanActionFollowUps(current, actor, ports)
        : undefined,
    (current, ports) =>
      current.deliveries.length &&
      current.work_items.some(
        (w) =>
          w.kind === "verify" &&
          w.required &&
          w.target_work_item_id &&
          w.status === "todo",
      )
        ? refreshRequiredVerifiers(current, actor, ports)
        : undefined,
    (current, ports) =>
      current.deliveries.length &&
      current.work_items.some(
        (w) =>
          w.kind === "verify" &&
          ["ready", "waiting_decision"].includes(w.status),
      )
        ? refreshTestReviewLimits(current, actor, ports)
        : undefined,
  ]);
  state = read();
  run(
    state.cards
      .filter(
        (card) =>
          flowAtLeast(card, 5) &&
          !["backlog", "todo", "done", "cancelled"].includes(card.status),
      )
      .map(
        (card): SystemStep =>
          (current, ports) =>
            systemCompleteCard(
              mergeGateEnabled
                ? {
                    ...current,
                    project_settings: {
                      ...current.project_settings,
                      merge_gate_enabled: mergeGateEnabled(project),
                    },
                  }
                : current,
              actor,
              { card_id: card.id },
              ports,
            ),
      ),
  );
  state = read();
  if (
    state.cards.some((card) => flowAtLeast(card, 5)) ||
    state.project_preferences?.find((p) => p.id === project)
      ?.system_auto_assign_verifiers === true
  )
    run(
      [...state.work_items]
        .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
        .filter(
          (item) =>
            item.kind === "verify" &&
            !item.assignment_id &&
            !item.manual_assign,
        )
        .map(
          (item): SystemStep =>
            (current, ports) =>
              autoAssignVerifier(
                current,
                actor,
                { work_item_id: item.id },
                ports,
              ),
        ),
    );
  run([(current, ports) => remindSystemWaits(current, actor, ports)]);
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
