import {
  cardCriticalPathLengths,
  cardDependencyView,
} from "../card-dependencies.js";
import { type CardDerivedFields, deriveCardFields } from "../card-derived.js";
import {
  CROSS_CARD_REFERENCE_NOTICE,
  cardReadAccess,
  isReferenceCard,
  referenceReadState,
} from "../card-read.js";
import { groupHumanDecisions } from "../decision-groups.js";
import {
  deriveCardStatus,
  deriveReviewMatrix,
  isReviewStale,
} from "../derived.js";
import type {
  Actor,
  Card,
  CardView,
  Decision,
  Delivery,
  HumanAction,
  Review,
  WorkItem,
} from "../entities.js";
import { eventsForDecision } from "../event-index.js";
import { cardFlowVersion } from "../flow.js";
import type { CardId, WorkItemId } from "../ids.js";
import { effectiveWorkItemRequirements } from "../machine-requirements.js";
import { mergeBatches } from "../merge-batch.js";
import { mergeStage } from "../merge-stage.js";
import { requesterNotificationRecipient } from "../notification.js";
import type { Clock } from "../ports.js";
import { prechecks, precheckView } from "../precheck.js";
import { crossCardRead } from "../preferences.js";
import { providerIncidents } from "../provider-start.js";
import { needsYouItemReady, readyConditionLabel } from "../readiness.js";
import { reviewLimitAttention } from "../review-limit-attention.js";
import { isRoleActive, type Role, roleKind } from "../role.js";
import {
  builtinCardTemplatesForFlow,
  type CardTemplate,
  latestCardTemplate,
  requiresUiStateAndSave,
} from "../templates.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { decisionFollowupNeedsHuman } from "./decision-followup.js";
import { suggestionView } from "./decision-suggestion.js";
import { hasActivePmOps, isPmOps } from "./delegation.js";
import { availableWorkItemEmployees } from "./employee-assignment.js";
import { failedConfirmedMergeCheck, latestMergeCheck } from "./merge-check.js";
import { mergeCheckBlockers } from "./merge-check-blockers.js";
import { mergeClassificationView } from "./merge-classification.js";
import {
  currentMergeConfirmations,
  humanMergeBlockers,
  mergeCheckEndedWithoutPass,
  mergeConfirmationWaitingForCheck,
  pmFailedMergeCheck,
  pmFailedMergeCheckOptions,
  pmMergeBlockers,
} from "./merge-delegation.js";
import { notices } from "./notices.js";
import { latestPreMergeCheckReminder } from "./pre-merge-checks.js";
import { projectPreferences } from "./preferences.js";
import {
  DEFAULT_RUNTIME_UNKNOWN_GRACE_MS,
  runtimeUnknownDeferred,
} from "./runtime-incident.js";
import { sourceMergeSuggestionView } from "./source-merge.js";
import { systemRuleAttention } from "./system-rules.js";
import { resolveCardTemplate } from "./templates.js";

function affects(d: CommandDraft, q: Decision, id: CardId) {
  return (
    q.card_id === id ||
    q.affected_cards.includes(id) ||
    q.affected_work_items.some((wi) => d.get("work_items", wi).card_id === id)
  );
}
type CommandCardView = Omit<CardView, "waiting_on" | "next_owners" | "why"> &
  CardDerivedFields;
function cardView(
  d: CommandDraft,
  id: CardId,
  reference = false,
): CommandCardView {
  const card = reference ? d.get("cards", id) : d.card(id);
  const items = d.list("work_items").filter((w) => w.card_id === id);
  const deliveries = d
    .list("deliveries")
    .filter((v) => items.some((w) => w.id === v.work_item_id));
  const open = d
    .list("decisions")
    .filter(
      (q) =>
        ["open", "provisional", "snoozed"].includes(q.status) &&
        affects(d, q, id),
    );
  const actions = d
    .list("human_actions")
    .filter(
      (h) =>
        h.status === "open" &&
        (h.card_id === id ||
          h.blocked_work_items.some((wi) => items.some((w) => w.id === wi))),
    );
  const completion = deliveries
    .filter((v) => v.kind === "card_completion" && v.status !== "superseded")
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  const status = deriveCardStatus(card.status, items, completion);
  const merge_check = completion
    ? latestMergeCheck(d.state.events, id, completion.id)
    : undefined;
  const blockers = mergeCheckBlockers(d.state, id);
  const fields = deriveCardFields({
    card,
    template: resolveCardTemplate(d, card),
    work_items: items,
    assignments: d.list("assignments"),
    runs: d.list("runs"),
    events: d.state.events,
    deliveries,
    reviews: d.list("reviews"),
    decisions: open,
    human_actions: actions,
    status,
  });
  const classification = mergeClassificationView(d.state, card);
  const merge_stage = mergeStage(d.state, card);
  const assignment = d.assignment;
  const readableCards =
    assignment?.scope === "work_item"
      ? d.state.cards.filter(
          (c) =>
            cardReadAccess({
              project_id: d.state.project_id,
              assignment,
              card: c,
              work_items: d.state.work_items,
              preferences: projectPreferences(d.state),
            }) !== "none",
        )
      : d.state.cards;
  const dependency =
    card.depends_on_cards?.length ||
    readableCards.some((c) => c.depends_on_cards?.includes(card.id))
      ? cardDependencyView({ ...d.state, cards: readableCards }, card)
      : undefined;
  return {
    ...card,
    ...(dependency ? { dependency } : {}),
    prechecks: prechecks(d.state.events, card.id).map(precheckView),
    flow_version: cardFlowVersion(card),
    ...(classification ? { merge_classification: classification } : {}),
    status,
    open_decisions: open.map((q) => q.id),
    review_matrix: deriveReviewMatrix(deliveries, items, d.list("reviews")),
    ...(merge_check ? { merge_check } : {}),
    ...(merge_stage ? { merge_stage } : {}),
    ...(blockers.length ? { merge_check_blockers: blockers } : {}),
    ...fields,
  };
}
export function projectSnapshot(state: CommandState, actor: Actor) {
  return command(state, actor, "project_snapshot", undefined, (d) => {
    d.pm();
    d.projectAccess();
    return {
      project_id: state.project_id,
      merge_batches: mergeBatches(state.events),
      system_rules: {
        system_review_limit_raise:
          projectPreferences(state).system_review_limit_raise === true,
        system_review_limit_max_raises:
          projectPreferences(state).system_review_limit_max_raises ?? null,
        role_rule_paths: projectPreferences(state).role_rule_paths ?? null,
        system_merge_shadow:
          projectPreferences(state).system_merge_shadow === true,
        system_auto_assign_verifiers:
          projectPreferences(state).system_auto_assign_verifiers === true,
        system_reminders: projectPreferences(state).system_reminders === true,
      },
      available_employees: availableWorkItemEmployees(state)
        .filter(
          (employee) =>
            employee.role_id !== "host_ops" &&
            isRoleActive(state.roles, employee.role_id),
        )
        .map(({ id, name, title, role_id }) => ({ id, name, title, role_id })),
      cards: [...d.list("cards")]
        .sort((a, b) =>
          d.state.cards.some((c) => c.depends_on_cards?.length)
            ? b.priority - a.priority ||
              (cardCriticalPathLengths(d.state).get(b.id) ?? 0) -
                (cardCriticalPathLengths(d.state).get(a.id) ?? 0)
            : 0,
        )
        .map((c) => cardView(d, c.id)),
    };
  });
}

/** Agent reference view; writes and the human project view retain their own gates. */
export function referenceProjectSnapshot(state: CommandState, actor: Actor) {
  const assignment =
    actor.kind === "assignment"
      ? state.assignments.find((a) => a.id === actor.assignment_id)
      : undefined;
  const visibleState = assignment
    ? referenceReadState(state, assignment)
    : state;
  return command(visibleState, actor, "project_snapshot", undefined, (d) => {
    ensure(
      assignment && actor.kind === "assignment",
      "unauthorized",
      "Assignment required",
    );
    ensure(
      assignment.scope === "standing" ||
        state.work_items.some(
          (w) =>
            w.id === assignment.work_item_id &&
            w.assignment_id === assignment.id &&
            w.status !== "cancelled",
        ),
      "unauthorized",
      "Assignment is no longer current",
    );
    if (!crossCardRead(projectPreferences(state))) {
      d.pm();
      d.projectAccess();
    }
    const cards = state.cards.flatMap((card) => {
      const access = cardReadAccess({
        project_id: state.project_id,
        assignment,
        card,
        work_items: state.work_items,
        preferences: projectPreferences(state),
      });
      if (access === "none") return [];
      const provenance = isReferenceCard(assignment, card, state.work_items)
        ? {
            source_card_id: card.id,
            reference_notice: CROSS_CARD_REFERENCE_NOTICE,
          }
        : {};
      return [
        {
          ...provenance,
          ...(access === "summary"
            ? { id: card.id, title: card.title, status: card.status }
            : cardView(d, card.id, true)),
        },
      ];
    });
    return {
      project_id: state.project_id,
      cards: cards.sort((a, b) => {
        if (!state.cards.some((c) => c.depends_on_cards?.length)) return 0;
        const first = state.cards.find((c) => c.id === a.id);
        const second = state.cards.find((c) => c.id === b.id);
        return (
          (second?.priority ?? 0) - (first?.priority ?? 0) ||
          (cardCriticalPathLengths(visibleState).get(b.id) ?? 0) -
            (cardCriticalPathLengths(visibleState).get(a.id) ?? 0)
        );
      }),
      system_rules: {
        system_review_limit_raise:
          projectPreferences(state).system_review_limit_raise === true,
        system_review_limit_max_raises:
          projectPreferences(state).system_review_limit_max_raises ?? null,
        role_rule_paths: projectPreferences(state).role_rule_paths ?? null,
        system_merge_shadow:
          projectPreferences(state).system_merge_shadow === true,
        system_auto_assign_verifiers:
          projectPreferences(state).system_auto_assign_verifiers === true,
        system_reminders: projectPreferences(state).system_reminders === true,
      },
      available_employees: availableWorkItemEmployees(state)
        .filter(
          (e) =>
            e.role_id !== "host_ops" && isRoleActive(state.roles, e.role_id),
        )
        .map(({ id, name, title, role_id }) => ({ id, name, title, role_id })),
    };
  });
}

/** One template as `list_templates` shows it: enough for a PM to pick one. */
function templateSummary(template: CardTemplate) {
  return {
    id: template.id,
    version: template.version,
    title: template.title,
    description: template.description,
    builtin: template.builtin,
    requires_repo: template.requires_repo,
    ...(requiresUiStateAndSave(template)
      ? { requires_state_and_save: true }
      : {}),
    merge: template.merge,
    primary_work_item_key: template.primary_work_item_key,
    work_items: template.work_items.map((item) => ({
      key: item.key,
      title: item.title,
      role_id: item.role_id,
      kind: item.kind,
      required: item.required,
      ...(item.requirements === undefined
        ? {}
        : { requirements: item.requirements }),
      ...(item.completion_criteria === undefined
        ? {}
        : { completion_criteria: item.completion_criteria }),
    })),
  };
}

/**
 * V12b: the latest active version of every card template this project can
 * use (host-provided, project-stored, builtin). Read-only; standing PM only.
 */
export function listTemplates(state: CommandState, actor: Actor) {
  return command(state, actor, "list_templates", undefined, (d) => {
    d.pm();
    d.projectAccess();
    const all = [
      ...(d.ports?.templates ?? []),
      ...d.list("card_templates"),
      ...builtinCardTemplatesForFlow(
        state.project_preferences?.find((p) => p.id === state.project_id)
          ?.flow_version,
      ),
    ];
    const templates = [...new Set(all.map((t) => t.id))]
      .sort()
      .flatMap((id) => {
        const latest = latestCardTemplate(all, id);
        return latest?.status === "active" ? [templateSummary(latest)] : [];
      });
    return { project_id: state.project_id, templates };
  });
}

/**
 * Stored role documents are full `Role`s; pre-M2 rows may only carry the
 * `RoleReference` fields, so every descriptive field is optional here.
 */
type StoredRole = CommandState["roles"][number] &
  Partial<Pick<Role, "display_name" | "kind" | "worktree" | "abilities">>;

/**
 * V12b: the latest active version of every role in this project. Prompts
 * (`core_prompt`, `instructions`) and launch policy are deliberately omitted.
 */
export function listRoles(state: CommandState, actor: Actor) {
  return command(state, actor, "list_roles", undefined, (d) => {
    d.pm();
    d.projectAccess();
    const stored = state.roles as readonly StoredRole[];
    const roles = [...new Set(stored.map((r) => r.role_id))]
      .sort()
      .flatMap((id) => {
        if (!isRoleActive(stored, id)) return [];
        const role = stored
          .filter((r) => r.role_id === id)
          .sort((a, b) => b.role_version - a.role_version)[0];
        if (role === undefined) return [];
        return [
          {
            role_id: role.role_id,
            version: role.role_version,
            ...(role.display_name === undefined
              ? {}
              : { display_name: role.display_name }),
            ...(role.kind === undefined
              ? {}
              : {
                  kind: roleKind({
                    kind: role.kind,
                    allowed_tools: role.allowed_tools,
                    capabilities: role.capabilities,
                  }),
                }),
            capabilities: [...role.capabilities],
            ...(role.required_capabilities === undefined
              ? {}
              : { required_capabilities: [...role.required_capabilities] }),
            ...(role.required_machine_tags === undefined
              ? {}
              : { required_machine_tags: [...role.required_machine_tags] }),
            ...(role.worktree === undefined ? {} : { worktree: role.worktree }),
            ...(role.abilities === undefined
              ? {}
              : { abilities: [...role.abilities] }),
          },
        ];
      });
    return { project_id: state.project_id, roles };
  });
}

const numericId = (id: string): number => {
  const digits = /(\d+)\)?$/.exec(id)?.[1];
  return digits === undefined ? 0 : Number(digits);
};
const newest = <T extends { readonly id: string }>(
  values: readonly T[],
): T | undefined =>
  [...values].sort(
    (left, right) => numericId(right.id) - numericId(left.id),
  )[0];

/** Every card a decision names, with the title the Needs You page shows. */
function relatedCards(
  cards: readonly Card[],
  decision: Decision,
): readonly { readonly id: string; readonly title: string }[] {
  const ids = [
    ...new Set([
      ...(decision.card_id === undefined ? [] : [decision.card_id]),
      ...decision.affected_cards,
    ]),
  ];
  return ids.flatMap((id) => {
    const card = cards.find((candidate) => candidate.id === id);
    return card === undefined ? [] : [{ id: card.id, title: card.title }];
  });
}

/**
 * What a merge confirmation will merge.
 *
 * Candidate deliveries follow `mergePlan`: each producing work item's newest
 * non-superseded Git delivery that is accepted. Reviews are the latest current
 * conclusion per verifier; the completion's known gaps travel with it so the
 * human can decide before the merge.
 */
function mergeConfirmation(
  state: CommandState,
  decision: Decision,
  items: readonly WorkItem[],
  deliveries: readonly Delivery[],
  reviews: readonly Review[],
) {
  if (decision.trigger !== "merge_confirmation") return null;
  const cardItems = items.filter((item) => item.card_id === decision.card_id);
  const products = cardItems
    .filter((item) => item.kind === "produce")
    .sort((left, right) => numericId(left.id) - numericId(right.id));
  const candidates = products.flatMap((item) => {
    const delivery = newest(
      deliveries.filter(
        (candidate) =>
          candidate.work_item_id === item.id &&
          candidate.kind !== "card_completion" &&
          candidate.status !== "superseded",
      ),
    );
    if (delivery?.status !== "accepted" || delivery.subject.kind !== "git_head")
      return [];
    return [
      {
        id: delivery.id,
        work_item_id: item.id,
        work_item_title: item.title,
        subject: delivery.subject,
        summary: delivery.summary,
      },
    ];
  });
  let completionTarget: Delivery["id"] | undefined;
  if (decision.kind === "approve") {
    const target = decision.target;
    if ("delivery_id" in target) completionTarget = target.delivery_id;
  }
  const completion =
    (completionTarget === undefined
      ? undefined
      : deliveries.find((delivery) => delivery.id === completionTarget)) ??
    newest(
      deliveries.filter(
        (delivery) =>
          delivery.kind === "card_completion" &&
          delivery.status !== "superseded" &&
          cardItems.some((item) => item.id === delivery.work_item_id),
      ),
    );
  const current = new Map<string, Delivery>();
  for (const candidate of candidates) {
    const delivery = deliveries.find((entry) => entry.id === candidate.id);
    if (delivery !== undefined) current.set(delivery.id, delivery);
  }
  if (completion !== undefined) current.set(completion.id, completion);
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    const delivery = [...current.values()].find(
      (v) => !isReviewStale(review, v),
    );
    if (delivery === undefined || isReviewStale(review, delivery)) continue;
    const previous = latest.get(review.work_item_id);
    if (previous === undefined || numericId(review.id) > numericId(previous.id))
      latest.set(review.work_item_id, review);
  }
  const reviewRows = [...latest.values()]
    .sort(
      (left, right) =>
        numericId(left.work_item_id) - numericId(right.work_item_id),
    )
    .map((review) => {
      const item = items.find((entry) => entry.id === review.work_item_id);
      return {
        id: review.id,
        delivery_id: review.delivery_id,
        work_item_id: review.work_item_id,
        work_item_title: item?.title ?? null,
        role_id: item?.role_id ?? null,
        kind: review.kind,
        verdict: review.verdict,
        ...(review.followup_card_id
          ? { followup_card_id: review.followup_card_id }
          : {}),
        target_sha: review.target_sha,
        issues: review.issues,
      };
    });
  return {
    blockers: humanMergeBlockers(state, decision),
    decision_evidence_required: [],
    completion:
      completion === undefined
        ? null
        : {
            id: completion.id,
            work_item_id: completion.work_item_id,
            summary: completion.summary,
            subject: completion.subject,
          },
    deliveries: candidates,
    reviews: reviewRows,
    known_gaps: completion?.known_gaps ?? [],
  };
}

/** Shared decision presentation for the task list and actionable card details. */
export function decisionActionView(
  state: CommandState,
  q: Decision & { grouped_decisions?: readonly Decision[] },
  now?: string,
) {
  const why = (text: string) => [...text].slice(0, 40).join("");
  const failedConfirmation = failedConfirmedMergeCheck(state, q);
  const followup = !failedConfirmation && decisionFollowupNeedsHuman(state, q);
  // Project decisions have no card timeline; their request event is the creation fact.
  const opened =
    eventsForDecision(state.events, q.id)
      .filter(
        (e) =>
          e.type === "decision_requested" &&
          typeof e.payload === "object" &&
          e.payload !== null &&
          "decision_id" in e.payload &&
          e.payload.decision_id === q.id,
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
      ?.created_at ??
    state.timeline
      .filter((e) => e.decision_id === q.id)
      .sort((a, b) => a.event_seq - b.event_seq)[0]?.created_at;
  const elapsed =
    opened && now ? Date.parse(now) - Date.parse(opened) : Number.NaN;
  // C-154: still with the human after the PM handed it over (pause, release
  // or withdrawn delegation); Needs You labels it "由 PM 转交".
  const handoff =
    q.decider === "human"
      ? eventsForDecision(state.events, q.id).findLast(
          (e) =>
            e.type === "decision_requested" &&
            typeof e.payload === "object" &&
            e.payload !== null &&
            "decision_id" in e.payload &&
            e.payload.decision_id === q.id &&
            "previous_decider" in e.payload &&
            e.payload.previous_decider === "role:pm",
        )
      : undefined;
  // C-192: expose the suggestion with `stale`, never its stored fingerprint.
  const suggestion = suggestionView(state, q);
  const {
    suggestion: _stored,
    source_unrelated_suggestion: _source,
    ...decision
  } = q;
  return {
    ...decision,
    ...(suggestion ? { suggestion } : {}),
    ...(q.source_unrelated_suggestion
      ? { source_unrelated_suggestion: sourceMergeSuggestionView(state, q) }
      : {}),
    handed_over_from_pm: handoff
      ? {
          at: handoff.created_at,
          reason: String(
            (handoff.payload as { reason?: unknown }).reason ?? "",
          ),
        }
      : null,
    ...(failedConfirmation
      ? {
          options: q.options.filter((o) => o.key === "request_changes"),
          recommended: "request_changes",
        }
      : {}),
    ...(followup
      ? {
          followup_notice:
            "拍板已完成，尚无落实结果；当前无 PM Ops 接手，请安排跟进。",
        }
      : {}),
    why: why(
      failedConfirmation
        ? "合并检查失败或超时，可退回修改或重新检查"
        : q.question,
    ),
    opened_at: opened ?? null,
    waited_ms: Number.isFinite(elapsed) ? Math.max(0, elapsed) : null,
    related_cards: relatedCards(state.cards, q),
    merge_confirmation: mergeConfirmation(
      state,
      q,
      state.work_items,
      state.deliveries,
      state.reviews,
    ),
  };
}

export function listNeedsYou(
  state: CommandState,
  actor: Actor,
  clock?: Clock,
  options: NeedsYouOptions = {},
) {
  return command(state, actor, "list_needs_you", undefined, (d) => {
    d.pm();
    d.projectAccess();
    return needsYouView(d, clock?.now(), options);
  });
}

export interface NeedsYouOptions {
  /**
   * C-228: grace period before a failures-only `unknown` runtime reaches the
   * human. Applies to human readers only; PM and host_ops see every incident.
   */
  readonly runtimeUnknownGraceMs?: number;
  /** Read-only Web grouping; omitted retains the complete Agent query. */
  readonly section?: NeedsYouSection;
}

export type NeedsYouSection =
  | "decisions"
  | "merges"
  | "actions"
  | "later"
  | "notices";

function decisionSection(state: CommandState, q: Decision): NeedsYouSection {
  return q.trigger === "merge_confirmation" &&
    (failedConfirmedMergeCheck(state, q) ||
      !decisionFollowupNeedsHuman(state, q))
    ? "merges"
    : "decisions";
}

/** Count the same eligible items without building decision bodies or merge evidence. */
export function listNeedsYouCounts(
  state: CommandState,
  actor: Actor,
  clock?: Clock,
  options: NeedsYouOptions = {},
) {
  return command(state, actor, "list_needs_you", undefined, (d) => {
    d.pm();
    d.projectAccess();
    const { section: _section, ...allSections } = options;
    const data = selectNeedsYou(
      d,
      clock?.now(),
      allSections,
      (q) => decisionSection(state, q),
      false,
    );
    const decisionCount = data.decisions.filter(
      (s) => s === "decisions",
    ).length;
    const mergeCount = data.decisions.length - decisionCount;
    const humanActions = data.human_actions.filter(
      (h) => h.triage !== "host",
    ).length;
    const attention = data.incidents.length + data.attention.length;
    const noticeList = notices(state);
    const unread = noticeList.filter((n) => !n.read).length;
    return {
      total_pending: data.decisions.length + humanActions + attention,
      tabs: {
        decisions: { count: decisionCount, attention: decisionCount },
        merges: {
          count: mergeCount + data.pm_held_merges.length,
          attention: mergeCount,
        },
        actions: {
          count:
            data.human_actions.length +
            attention +
            data.system_rule_attention.length,
          attention:
            humanActions + attention + data.system_rule_attention.length,
        },
        later: { count: data.later.length, attention: 0 },
        notices: { count: noticeList.length, attention: unread },
      },
    };
  });
}

/** Shared read model; callers enforce their own entry-point authorization. */
export function needsYouView(
  d: CommandDraft,
  now?: string,
  options: NeedsYouOptions = {},
) {
  return selectNeedsYou(d, now, options, (q) =>
    decisionActionView(d.state, q, now),
  );
}

function selectNeedsYou<T>(
  d: CommandDraft,
  now: string | undefined,
  options: NeedsYouOptions,
  view: (q: Decision) => T,
  includeDetails = true,
) {
  const state = d.state,
    actor = d.actor;
  const includes = (section: NeedsYouSection) =>
    !options.section || options.section === section;
  // C-212: a deferred item is listed under "稍后" until its condition holds.
  // Only the listing moves; merge gates and card waiting_on read the item.
  const ready = (item: Parameters<typeof needsYouItemReady>[1]) =>
    needsYouItemReady(state, item);
  const waiting = d
    .list("decisions")
    .filter(
      (q) =>
        q.trigger === "merge_confirmation" &&
        ((q.decider === "human" &&
          ["open", "provisional", "snoozed"].includes(q.status)) ||
          !!failedConfirmedMergeCheck(state, q)) &&
        mergeConfirmationWaitingForCheck(state, q),
    );
  // C-264: humans see each current confirmation and its blockers. Agent
  // queries retain the existing waiting-check summary used by PM workflows.
  const humanWaiting = (actor.kind === "human" ? [] : waiting).filter(
    (q) => q.status !== "snoozed" && !mergeCheckEndedWithoutPass(state, q),
  );
  const why = (text: string) => [...text].slice(0, 40).join("");
  // C-179: a passed pre-merge check may be what an open action waited for.
  const withReminder = <H extends HumanAction>(
    h: H,
  ): H & {
    pre_merge_check_reminder?: ReturnType<typeof latestPreMergeCheckReminder>;
  } => {
    const reminder = latestPreMergeCheckReminder(state.events, h);
    return reminder ? { ...h, pre_merge_check_reminder: reminder } : h;
  };
  return {
    attention:
      includes("actions") && now ? reviewLimitAttention(state, now) : [],
    system_rule_attention:
      includes("actions") && now
        ? systemRuleAttention(d, now).filter(
            (f) => isPmOps(d) || (!f.assignment_id && !hasActivePmOps(d)),
          )
        : [],
    ...(isPmOps(d)
      ? {
          pm_queue: {
            waiting_merge_checks: waiting,
            snoozed_merges: d
              .list("decisions")
              .filter((q) => q.decider === "role:pm" && q.status === "snoozed"),
            expired_snoozes: d
              .list("decisions")
              .filter(
                (q) =>
                  q.trigger === "merge_confirmation" && q.status === "open",
              )
              .flatMap((q) => {
                const event = state.events.findLast(
                  (e) =>
                    e.type === "decision_requested" &&
                    e.payload !== null &&
                    typeof e.payload === "object" &&
                    "decision_id" in e.payload &&
                    e.payload.decision_id === q.id,
                );
                const p = event?.payload;
                return p &&
                  typeof p === "object" &&
                  "snooze_expired" in p &&
                  p.snooze_expired === true
                  ? [
                      {
                        decision_id: q.id,
                        card_id: q.card_id,
                        decider: q.decider,
                        at: event.created_at,
                        body: "reason" in p ? p.reason : "暂缓已到期",
                      },
                    ]
                  : [];
              }),
            decisions: d
              .list("decisions")
              .filter(
                (q) =>
                  q.decider === "role:pm" &&
                  ["open", "provisional"].includes(q.status),
              ),
            // §7.4: why PM Ops cannot choose merge yet (empty = allowed).
            merge_decision_evidence_required: Object.fromEntries(
              d
                .list("decisions")
                .filter(
                  (q) =>
                    q.decider === "role:pm" &&
                    q.trigger === "merge_confirmation" &&
                    q.status === "open",
                )
                .map((q) => [q.id, []]),
            ),
            merge_blockers: Object.fromEntries(
              d
                .list("decisions")
                .filter(
                  (q) =>
                    q.decider === "role:pm" &&
                    q.trigger === "merge_confirmation" &&
                    q.status === "open",
                )
                .map((q) => [q.id, pmMergeBlockers(state, q)]),
            ),
            // P2a-1 §2.6: failed or timed-out checks PM Ops may return
            // (request_changes) or recheck, including confirmed merges.
            failed_merge_checks: d.list("decisions").flatMap((q) => {
              const check =
                q.status === "snoozed"
                  ? undefined
                  : pmFailedMergeCheck(state, q);
              return check
                ? [
                    {
                      decision_id: q.id,
                      card_id: q.card_id,
                      confirmation_status: q.status,
                      check,
                      options: pmFailedMergeCheckOptions(state, q),
                    },
                  ]
                : [];
            }),
            human_actions: d
              .list("human_actions")
              .filter((h) => h.status === "open" && h.triage === "pm_ops")
              .map(withReminder),
          },
        }
      : {}),
    provider_incidents:
      includeDetails && includes("actions")
        ? [...providerIncidents(state.events)].map(([profile, incident]) => ({
            profile,
            paused: !!incident.retry_at,
          }))
        : [],
    incidents: !includes("actions")
      ? []
      : d
          .list("assignments")
          .filter(
            (a) =>
              a.status === "active" &&
              ["unknown", "lost"].includes(a.runtime_state) &&
              // C-228: the human's queue waits out a short failures-only unknown.
              !(
                actor.kind === "human" &&
                now !== undefined &&
                runtimeUnknownDeferred(
                  state.events,
                  a,
                  now,
                  options.runtimeUnknownGraceMs ??
                    DEFAULT_RUNTIME_UNKNOWN_GRACE_MS,
                )
              ),
          )
          .map((a) => {
            const fact = (type: string) =>
              state.events.findLast(
                (e) =>
                  e.type === type &&
                  typeof e.payload === "object" &&
                  e.payload !== null &&
                  "assignment_id" in e.payload &&
                  e.payload.assignment_id === a.id,
              );
            return {
              id: a.id,
              role_id: a.role_id,
              runtime_state: a.runtime_state,
              card_id:
                d.list("work_items").find((w) => w.id === a.work_item_id)
                  ?.card_id ?? null,
              disconnected_at: fact("runtime_disconnected")?.created_at ?? null,
              lost_at: fact("runtime_lost")?.created_at ?? null,
              last_run:
                d
                  .list("runs")
                  .filter((r) => r.assignment_id === a.id)
                  .sort(
                    (x, y) => Number(y.id.slice(2)) - Number(x.id.slice(2)),
                  )[0] ?? null,
            };
          }),
    decisions: groupHumanDecisions(
      d
        .list("decisions")
        .filter((q) => !options.section || includes(decisionSection(state, q)))
        .filter(
          (q) =>
            (q.decider === "human" &&
              ["open", "provisional", "snoozed"].includes(q.status)) ||
            (failedConfirmedMergeCheck(state, q) &&
              // PM Ops handles it and syncs a notice (P2a-1 §2.6).
              !(
                hasActivePmOps(d, "resolve_delegated_decision") &&
                pmFailedMergeCheck(state, q)
              )) ||
            decisionFollowupNeedsHuman(state, q),
        )
        .filter(
          (q) =>
            !["open", "provisional", "snoozed"].includes(q.status) || ready(q),
        )
        .filter((q) =>
          actor.kind === "human"
            ? q.trigger !== "merge_confirmation" ||
              (!!q.card_id &&
                currentMergeConfirmations(state, q.card_id).some(
                  (current) => current.id === q.id,
                ))
            : q.status === "snoozed" ||
              !mergeConfirmationWaitingForCheck(state, q) ||
              !!mergeCheckEndedWithoutPass(state, q),
        ),
      { details: includeDetails },
    ).map(view),
    waiting_merge_checks_count: includes("merges") ? humanWaiting.length : 0,
    // C-171: which confirmations the summary counts, so the human can open them.
    waiting_merge_check_items: (includes("merges") ? humanWaiting : []).map(
      (q) => ({
        decision_id: q.id,
        card_id: q.card_id ?? null,
        check_status:
          q.card_id && q.kind === "approve" && "delivery_id" in q.target
            ? (latestMergeCheck(state.events, q.card_id, q.target.delivery_id)
                ?.status ?? null)
            : null,
      }),
    ),
    // §7.4 (C-65): merge confirmations PM Ops still holds. Not counted as
    // waiting on the human, but the human may answer them directly.
    pm_held_merges:
      actor.kind === "human" && includes("merges")
        ? d
            .list("decisions")
            .filter(
              (q) =>
                q.decider === "role:pm" &&
                q.trigger === "merge_confirmation" &&
                ["open", "provisional", "snoozed"].includes(q.status),
            )
            .map(view)
        : [],
    human_actions: !includes("actions")
      ? []
      : d
          .list("human_actions")
          .filter(
            (h) =>
              (h.status === "open" && h.triage !== "pm_ops" && ready(h)) ||
              (h.status === "done" &&
                requesterNotificationRecipient(
                  h.requested_by,
                  state.assignments,
                )?.kind === "needs_you" &&
                (!h.card_id ||
                  state.cards.some(
                    (c) =>
                      c.id === h.card_id &&
                      !["done", "cancelled"].includes(c.status),
                  ))),
          )
          .map((h) => ({
            ...h,
            why: why(
              h.status === "done"
                ? "已完成，但发起方不可用且无活跃 PM Ops 接手"
                : (h.handoff?.why_human ?? h.why_human),
            ),
            ...(h.status === "done"
              ? { completion_notice: h.result?.text ?? "" }
              : {}),
            ...withReminder(h),
          })),
    // C-212: deferred items, shown only as a folded count with their reason.
    later: !includes("later")
      ? []
      : [
          ...d
            .list("decisions")
            .filter(
              (q) =>
                q.decider === "human" &&
                ["open", "provisional", "snoozed"].includes(q.status) &&
                !ready(q),
            )
            .map((q) => ({
              kind: "decision" as const,
              id: q.id,
              card_id: q.card_id ?? null,
              title: q.question,
              waiting_for: readyConditionLabel(
                q.ready_when as NonNullable<typeof q.ready_when>,
              ),
            })),
          ...d
            .list("human_actions")
            .filter(
              (h) => h.status === "open" && h.triage !== "pm_ops" && !ready(h),
            )
            .map((h) => ({
              kind: "human_action" as const,
              id: h.id,
              card_id: h.card_id ?? null,
              title: h.handoff?.title ?? h.instructions,
              triage: h.triage ?? "human",
              waiting_for: readyConditionLabel(
                h.ready_when as NonNullable<typeof h.ready_when>,
              ),
            })),
        ],
  };
}

/** Persist the audit and return the item from the same fresh transaction. */
export function getWorkItem(
  state: CommandState,
  actor: Actor,
  id: WorkItemId,
  ports: CommandPorts,
) {
  return command(state, actor, "get_card", ports, (d) => {
    const item = d.get("work_items", id);
    const card = d.get("cards", item.card_id);
    ensure(
      card.project_id === state.project_id &&
        (actor.kind === "human" ||
          cardReadAccess({
            project_id: state.project_id,
            assignment: d.assignment,
            card,
            work_items: state.work_items,
            preferences: projectPreferences(state),
          }) === "full"),
      "unauthorized",
      "工作项不存在或无权读取详情",
    );
    const assignment = state.assignments.find(
      (a) => a.id === item.assignment_id,
    );
    const role = state.roles
      .filter(
        (r) =>
          r.role_id === item.role_id &&
          (assignment === undefined ||
            r.role_version === assignment.role_version),
      )
      .sort((a, b) => b.role_version - a.role_version)[0];
    const effective = effectiveWorkItemRequirements(
      item.requirements,
      role ?? {},
    );
    ensure(
      effective.ok,
      "validation_failed",
      effective.ok ? "" : effective.error.message,
    );
    const reference =
      d.assignment && isReferenceCard(d.assignment, card, state.work_items);
    if (reference && d.assignment)
      d.emit("cross_card_read", undefined, {
        card_id: card.id,
        tool: "get_card",
        assignment_id: d.assignment.id,
        employee_id: d.assignment.employee_id ?? null,
      });
    return {
      ...item,
      effective_requirements: effective.value,
      ...(reference
        ? {
            source_card_id: card.id,
            reference_notice: CROSS_CARD_REFERENCE_NOTICE,
          }
        : {}),
    };
  });
}
