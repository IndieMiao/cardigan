import type {
  Assignment,
  AssignmentId,
  CardId,
  EventId,
  RoleId,
  TimelineEntry,
  WorkItem,
  WorkItemId,
} from "@cardigan/domain";
import {
  assignmentCanReadCard,
  canStartWork,
  cardTemplate,
  employeeNameKey,
  isCompletionVerifier,
  latestMergeCheck,
  mergeRequiresHuman,
  pmMergeCheckDelegationAllowed,
  requesterNotificationRecipient,
} from "@cardigan/domain";
import {
  payloadObject,
  payloadString,
  payloadStrings,
  type Recipient,
  type RouteCheck,
  type RoutedNotification,
  type RouteInput,
  type RouteProblem,
  type RouteResult,
  type RuleId,
  recipient,
} from "./types.js";

/**
 * M3.1 routing rules: development plan §6.4 (every row), §6.5 (all four mention
 * cases) and §7.2 (all five escalations), plus the §3.3 pipeline conditions of
 * the M3 plan (`docs/plans/phase-1-m3.md`).
 *
 * The principle (§6.4): notify whoever's next step this event changed — never
 * "everyone on the card" — and never notify the author about its own action.
 */

const succeeded = (item: WorkItem) =>
  item.kind === "produce"
    ? item.status === "accepted"
    : item.status === "passed";

const isActive = (assignment: Assignment): boolean =>
  assignment.status === "active";

const actorAssignmentId = (input: RouteInput): AssignmentId | undefined =>
  input.event.actor.kind === "assignment"
    ? input.event.actor.assignment_id
    : undefined;

/** The timeline entry of this event, which carries the mentions and work item. */
const entryOf = (input: RouteInput): TimelineEntry | undefined =>
  input.snapshot.timeline.find(
    (entry) =>
      entry.event_seq === input.event.seq &&
      entry.card_id === input.event.card_id,
  );

const itemOf = (input: RouteInput, id: WorkItemId | undefined) =>
  id === undefined
    ? undefined
    : input.snapshot.work_items.find((item) => item.id === id);

const assignmentOf = (input: RouteInput, id: AssignmentId | undefined) =>
  id === undefined
    ? undefined
    : input.snapshot.assignments.find((candidate) => candidate.id === id);

/** Assignments that serve a role on this card (standing ones always count). */
const assignmentsForRole = (
  input: RouteInput,
  role_id: string,
  card_id: CardId | undefined,
): readonly Assignment[] =>
  input.snapshot.assignments.filter((candidate) => {
    if (candidate.role_id !== role_id || !isActive(candidate)) return false;
    if (candidate.scope === "standing") return true;
    const item = input.snapshot.work_items.find(
      (work_item) => work_item.id === candidate.work_item_id,
    );
    return item === undefined ? true : item.card_id === card_id;
  });

const recipientKey = (to: Recipient): string =>
  `${to.kind}:${to.assignment_id ?? ""}`;

interface Draft {
  notifications: RoutedNotification[];
  checks: RouteCheck[];
  problems: RouteProblem[];
}

function note(
  input: RouteInput,
  draft: Draft,
  to: Recipient,
  kind: RoutedNotification["kind"],
  rule: RuleId,
  summary: string,
  extra: {
    work_item_id?: WorkItemId;
    run_kind?: RoutedNotification["run_kind"];
  } = {},
): void {
  // Never notify an Assignment about its own action (§6.4).
  if (
    to.kind === "assignment" &&
    to.assignment_id === actorAssignmentId(input)
  ) {
    return;
  }
  // One event produces at most one notification per recipient (M3.3 unique
  // constraint), so a comment that also mentions its own owner rings once.
  const key = `${to.kind}:${to.assignment_id ?? ""}`;
  if (
    draft.notifications.some(
      (existing) => recipientKey(existing.recipient) === key,
    )
  ) {
    return;
  }
  draft.notifications.push({
    recipient: to,
    kind,
    rule,
    event_id: input.event.id,
    seq: input.event.seq,
    card_id: input.event.card_id,
    work_item_id: extra.work_item_id,
    summary,
    ...(extra.run_kind ? { run_kind: extra.run_kind } : {}),
  });
}

function problem(
  draft: Draft,
  rule: RuleId,
  code: RouteProblem["code"],
  detail: string,
): void {
  draft.problems.push({ rule, code, detail });
}

function noteAssignment(
  input: RouteInput,
  draft: Draft,
  item: WorkItem | undefined,
  kind: RoutedNotification["kind"],
  rule: RuleId,
  summary: string,
  run_kind?: RoutedNotification["run_kind"],
): void {
  const assignment = assignmentOf(input, item?.assignment_id);
  if (item === undefined || assignment === undefined || !isActive(assignment)) {
    // Nobody can be woken: the PM Ops decides whether to create an Assignment.
    note(input, draft, recipient.pm_ops(), kind, rule, summary);
    return;
  }
  note(input, draft, recipient.assignment(assignment.id), kind, rule, summary, {
    work_item_id: item.id,
    ...(run_kind ? { run_kind } : {}),
  });
}

const subject = (input: RouteInput): string =>
  input.event.card_id ?? "the project";

/** New work belongs to the current Ops, including cards created by Office. */
function routeCardPlanning(input: RouteInput, draft: Draft): void {
  const card = input.snapshot.cards.find((c) => c.id === input.event.card_id);
  if (!card || ["done", "cancelled"].includes(card.status)) return;
  const author = assignmentOf(input, actorAssignmentId(input));
  if (
    author?.status === "active" &&
    author.scope === "standing" &&
    author.role_id === "pm" &&
    author.standing_mode === "ops"
  )
    return;
  note(
    input,
    draft,
    recipient.pm_ops(),
    "card",
    "6.4/card needs planning",
    `${card.id} 有待安排的卡片更新，请读取当前状态并安排工作。`,
  );
}

/** §6.4: a comment on a work item wakes that work item's Assignment. */
function routeComment(input: RouteInput, draft: Draft): void {
  const entry = entryOf(input);
  const work_item_id =
    entry?.work_item_id ?? payloadString(input.event.payload, "work_item_id");
  const rawMentions =
    entry?.mentions ?? payloadStrings(input.event.payload, "mentions");
  // Employee status/name may have changed since posting. Unknown names still
  // behave like ordinary text; only registered roles retain role routing.
  const mentions =
    input.snapshot.roles === undefined
      ? rawMentions
      : rawMentions.filter((mention) => {
          const text = mention.replace(/^@/u, "");
          return (
            /^[AW]-\d+$/u.test(text) ||
            input.snapshot.roles?.some((role) => role.role_id === text) ||
            input.snapshot.employees?.some(
              (employee) =>
                employee.status === "active" &&
                employeeNameKey(employee.name) === employeeNameKey(text),
            )
          );
        });
  const item = itemOf(input, work_item_id as WorkItemId | undefined);

  if (item !== undefined) {
    noteAssignment(
      input,
      draft,
      item,
      "comment",
      "6.4/work-item comment",
      `new comment on ${item.id}`,
    );
  }

  if (mentions.length > 0) {
    routeMentions(input, draft, mentions, item?.card_id);
    return;
  }
  if (item !== undefined) return;

  // §6.4: a card-level comment without a mention never rings a bell, but the
  // human's words are merged into the next PM Ops bell.
  if (input.event.actor.kind === "human") {
    note(
      input,
      draft,
      recipient.pm_ops(),
      "comment",
      "6.4/card comment without mention",
      `comment from the human on ${subject(input)}`,
    );
  }
}

/** §6.5: the four @mention cases. */
function routeMentions(
  input: RouteInput,
  draft: Draft,
  mentions: readonly string[],
  card_id: CardId | undefined,
): void {
  for (const mention of mentions) {
    const text = mention.replace(/^@/u, "");
    const explicit = /^([AW])-(\d+)$/u.exec(text);
    if (explicit !== null) {
      if (explicit[1] === "A") {
        const target = assignmentOf(input, text as AssignmentId);
        if (target === undefined || !isActive(target)) {
          draft.problems.push({
            rule: "6.5/explicit assignment or work item",
            code: "unknown_mention",
            detail: `@${text} is not an active Assignment`,
          });
          continue;
        }
        if (
          input.event.card_id &&
          !assignmentCanReadCard(
            target,
            input.event.card_id,
            input.snapshot.work_items,
          )
        ) {
          const detail = `@${text} 无权读取本卡，未向其投递；已转交 PM Ops，请在该 Assignment 所属卡片联系，或指定本卡负责人。`;
          problem(
            draft,
            "6.5/explicit assignment or work item",
            "assignment_cannot_read_card",
            detail,
          );
          note(
            input,
            draft,
            recipient.pm_ops(),
            "escalation",
            "6.5/explicit assignment or work item",
            detail,
          );
          continue;
        }
        note(
          input,
          draft,
          recipient.assignment(target.id),
          "comment",
          "6.5/explicit assignment or work item",
          `mentioned in a comment on ${subject(input)}`,
        );
        continue;
      }
      const item = itemOf(input, text as WorkItemId);
      if (item === undefined) {
        problem(
          draft,
          "6.5/explicit assignment or work item",
          "unknown_mention",
          `@${text} is not a work item of this card`,
        );
        continue;
      }
      if (item.assignment_id === undefined) {
        // Explicitly named, but the work item has no one to wake.
        problem(
          draft,
          "6.5/explicit assignment or work item",
          "mentioned_work_item_unassigned",
          `@${text} has no Assignment yet`,
        );
        note(
          input,
          draft,
          recipient.pm_ops(),
          "comment",
          "6.5/no assignment for the role",
          `mention of the unassigned ${item.id}`,
        );
        continue;
      }
      noteAssignment(
        input,
        draft,
        item,
        "comment",
        "6.5/explicit assignment or work item",
        `mentioned in a comment on ${subject(input)}`,
      );
      continue;
    }

    const employee = input.snapshot.employees?.find(
      (candidate) =>
        candidate.status === "active" &&
        employeeNameKey(candidate.name) === employeeNameKey(text),
    );
    if (employee !== undefined) {
      const candidates = input.snapshot.assignments.filter(
        (candidate) =>
          candidate.employee_id === employee.id &&
          isActive(candidate) &&
          candidate.scope === "work_item" &&
          input.snapshot.work_items.some(
            (item) =>
              item.id === candidate.work_item_id &&
              item.card_id === (card_id ?? input.event.card_id),
          ),
      );
      if (candidates.length > 1) {
        problem(
          draft,
          "6.5/several assignments for the employee",
          "ambiguous_employee_mention",
          `@${employee.name} 对应多个 active Assignment（${candidates.map((candidate) => candidate.id).join(", ")}）；请明确指定工作项 @W-n，不广播`,
        );
      } else {
        const only = candidates[0];
        note(
          input,
          draft,
          only === undefined
            ? recipient.pm_ops()
            : recipient.assignment(only.id),
          "comment",
          only === undefined
            ? "6.5/no assignment for the employee"
            : "6.5/single assignment for the employee",
          only === undefined
            ? `@${employee.name} 在本卡没有 active Assignment，请 PM Ops 处理`
            : `@${employee.name} mentioned on ${subject(input)}`,
        );
      }
      continue;
    }

    // A role mention has to resolve to exactly one Assignment.
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(text)) {
      problem(
        draft,
        "6.5/single assignment for the role",
        "unknown_mention",
        `@${text} is not a role, Assignment or work item`,
      );
      continue;
    }
    const candidates = assignmentsForRole(
      input,
      text as RoleId,
      card_id ?? input.event.card_id,
    );
    if (candidates.length === 1) {
      const only = candidates[0] as Assignment;
      note(
        input,
        draft,
        recipient.assignment(only.id),
        "comment",
        "6.5/single assignment for the role",
        `mentioned as ${text} in a comment on ${subject(input)}`,
      );
      continue;
    }
    if (candidates.length === 0) {
      note(
        input,
        draft,
        recipient.pm_ops(),
        "comment",
        "6.5/no assignment for the role",
        `mentioned ${text}, but no Assignment has that role`,
      );
      continue;
    }
    // Several candidates: do not broadcast; the speaker must name a work item.
    draft.problems.push({
      rule: "6.5/several assignments for the role",
      code: "ambiguous_role_mention",
      detail: `@${text} matches ${candidates
        .map((candidate) => candidate.id)
        .join(", ")}; name the work item instead`,
    });
  }
}

/** §6.4: an instruction goes to the work item's Assignment, else PM Ops. */
function routeInstruction(input: RouteInput, draft: Draft): void {
  const work_item_id = payloadString(input.event.payload, "work_item_id");
  const item = itemOf(input, work_item_id as WorkItemId | undefined);
  if (item === undefined) {
    note(
      input,
      draft,
      recipient.pm_ops(),
      "instruction",
      "6.4/instruction",
      `instruction without a work item on ${subject(input)}`,
    );
    return;
  }
  noteAssignment(
    input,
    draft,
    item,
    "instruction",
    "6.4/instruction",
    `new instruction on ${item.id}`,
  );
}

/** §6.4: deliveries go to the verifying Assignments; PM Ops gets a summary. */
function routeDelivery(input: RouteInput, draft: Draft): void {
  const delivery_id = payloadString(input.event.payload, "delivery_id");
  const delivery = input.snapshot.deliveries.find(
    (candidate) => candidate.id === delivery_id,
  );
  if (delivery === undefined) {
    problem(
      draft,
      "6.4/delivery submitted",
      "unknown_mention",
      `delivery ${delivery_id ?? "(none)"} was not found`,
    );
    return;
  }
  if (delivery.kind === "card_completion") {
    routeCompletionRequest(input, draft, delivery.id);
    return;
  }
  // The next step is the requested verifier. PM Ops only hears about this
  // delivery through noteAssignment when a verifier has no active owner and
  // needs an Assignment; a generic summary is not a §7.2 judgement call
  // (M5.S S25 follow-up).
  for (const verifier_id of delivery.requested_verifiers) {
    const verifier = itemOf(input, verifier_id);
    if (verifier === undefined) continue;
    noteAssignment(
      input,
      draft,
      verifier,
      "delivery",
      "6.4/delivery submitted",
      `${delivery.id} is waiting for ${verifier.id}`,
    );
  }
}

/** §6.4: notify this completion delivery's explicitly requested verifiers. */
function routeCompletionRequest(
  input: RouteInput,
  draft: Draft,
  delivery_id: string,
): void {
  const delivery = input.snapshot.deliveries.find((d) => d.id === delivery_id);
  const card = input.snapshot.cards.find((c) => c.id === input.event.card_id);
  const template = card && cardTemplate(card, input.snapshot.card_templates);
  if (
    template?.completion.mode === "review" &&
    template.completion.reviewer === "human"
  )
    return;
  const items = input.snapshot.work_items.filter(
    (item) =>
      item.card_id === input.event.card_id &&
      item.kind === "verify" &&
      delivery?.requested_verifiers.includes(item.id),
  );
  if (items.length === 0) {
    note(
      input,
      draft,
      recipient.pm_ops(),
      "completion",
      "6.4/completion request",
      `completion request ${delivery_id} has no reviewer on ${subject(input)}`,
    );
    return;
  }
  for (const item of items)
    noteAssignment(
      input,
      draft,
      item,
      "completion",
      "6.4/completion request",
      `completion request ${delivery_id} is waiting for ${item.id}`,
    );
}

/** §6.4: a passed review wakes nobody; it only advances derived checks. */
/**
 * §6.4: a work item succeeded, so whoever works on what depends on it is next.
 *
 * Only a delivery whose work item actually succeeded completes anything — a
 * first pass among several required verifiers does not — and a downstream item
 * is next only when *all* of its dependencies succeeded. An unowned downstream
 * item goes to PM Ops, which decides whether to create an Assignment.
 */
function routeCompletedItem(
  input: RouteInput,
  draft: Draft,
  completedId: WorkItemId | undefined,
): void {
  const completed = itemOf(input, completedId);
  if (completed === undefined || !succeeded(completed)) return;
  const downstream = input.snapshot.work_items.filter(
    (candidate) =>
      candidate.depends_on.includes(completed.id) &&
      candidate.depends_on.every((id) => {
        const dependency = itemOf(input, id);
        return dependency !== undefined && succeeded(dependency);
      }),
  );
  let unowned = false;
  for (const candidate of downstream) {
    if (candidate.assignment_id === undefined) {
      unowned = true;
      continue;
    }
    noteAssignment(
      input,
      draft,
      candidate,
      "dependency",
      "6.4/dependency completed",
      `${completed.id} is done; ${candidate.id} can start`,
    );
  }
  if (unowned)
    note(
      input,
      draft,
      recipient.pm_ops(),
      "dependency",
      "6.4/dependency completed",
      `${completed.id} is done and a dependent work item has no owner`,
    );
}

/** §6.4: all required items succeeded → remind the producer to apply. */
function routeCompletionReminder(input: RouteInput, draft: Draft): void {
  const card_id = input.event.card_id;
  if (
    input.snapshot.cards.some(
      (card) =>
        card.id === card_id &&
        ["done", "cancelled", "awaiting_merge"].includes(card.status),
    )
  )
    return;
  const card = input.snapshot.cards.find((c) => c.id === card_id);
  const template = card && cardTemplate(card, input.snapshot.card_templates);
  if (template?.completion.mode !== "review") return;
  const items = input.snapshot.work_items.filter(
    (item) => item.card_id === card_id,
  );
  const required = items.filter(
    (item) => item.required && !isCompletionVerifier(template, item),
  );
  const allPassed = required.length > 0 && required.every(succeeded);
  if (!allPassed) return;
  const producer =
    items.find(
      (item) =>
        item.kind === "produce" &&
        item.template_key === template.primary_work_item_key,
    ) ?? items.find((item) => item.kind === "produce");
  if (producer === undefined) return;
  noteAssignment(
    input,
    draft,
    producer,
    "completion",
    "6.4/all required work items passed",
    `all required work items passed; ${producer.id} may apply for completion`,
  );
}

/** Both the reviewed and the unreviewed path end with these two rules. */
function routeCompletion(
  input: RouteInput,
  draft: Draft,
  completedId: WorkItemId | undefined,
): void {
  routeCompletedItem(input, draft, completedId);
  routeCompletionReminder(input, draft);
}

/**
 * §4.4: a delivery nothing verifies is accepted the moment it arrives, so the
 * work item it belongs to succeeded. It routes exactly like a passing review:
 * dependents are woken (or PM Ops is told when a dependent has no owner) and
 * the producer may apply for completion.
 */
function routeDeliveryAccepted(input: RouteInput, draft: Draft): void {
  const delivery_id = payloadString(input.event.payload, "delivery_id");
  const delivery = input.snapshot.deliveries.find(
    (candidate) => candidate.id === delivery_id,
  );
  routeCompletion(input, draft, delivery?.work_item_id);
}

function routeReview(input: RouteInput, draft: Draft): void {
  const verdict = payloadString(input.event.payload, "verdict");
  const delivery_id = payloadString(input.event.payload, "delivery_id");
  const reviews = input.snapshot.reviews.filter(
    (review) => review.delivery_id === delivery_id,
  );
  const payload = payloadObject(input.event.payload);
  const review = reviews.find((r) => r.id === payload.review_id);
  const issueCount = Array.isArray(payload.issues)
    ? payload.issues.length
    : (review?.issues.length ?? 0);
  const recheck = payload.recheck_required ?? review?.recheck_required;

  // deriveReview represents nonblocking conditions without a recheck as pass.
  // Add a PM Ops summary without suppressing the normal completion routing.
  if (
    (verdict === "pass" && issueCount > 0) ||
    (verdict === "conditional" && recheck === false)
  ) {
    draft.checks.push({
      rule: "6.4/review passed",
      card_id: input.event.card_id,
      detail: "check whether every delivery passed and the card is done",
    });
    const passed = input.snapshot.deliveries.find(
      (candidate) => candidate.id === delivery_id,
    );
    routeCompletion(input, draft, passed?.work_item_id);
    let summary = `${delivery_id ?? "the delivery"} passed with ${issueCount} review issue(s); no recheck is needed`;
    // A recipient gets one notification per event. Preserve any PM Ops handoff
    // for an unowned dependent inside the review summary instead of losing it.
    const dependency = draft.notifications.find(
      (n) => n.recipient.kind === "pm_ops",
    );
    if (dependency !== undefined) {
      draft.notifications.splice(draft.notifications.indexOf(dependency), 1);
      summary += `; ${dependency.summary}`;
    }
    note(
      input,
      draft,
      recipient.pm_ops(),
      "review",
      "6.4/review conditional",
      summary,
    );
    return;
  }

  if (verdict === "pass") {
    draft.checks.push({
      rule: "6.4/review passed",
      card_id: input.event.card_id,
      detail: "check whether every delivery passed and the card is done",
    });
    const passed = input.snapshot.deliveries.find(
      (candidate) => candidate.id === delivery_id,
    );
    routeCompletion(input, draft, passed?.work_item_id);
    return;
  }

  if (verdict === "conditional") {
    // The final non-pass round is handled by the blocking review-limit Decision.
    if (payload.rework_allowed === false) return;
    const delivery = input.snapshot.deliveries.find(
      (candidate) => candidate.id === delivery_id,
    );
    noteAssignment(
      input,
      draft,
      itemOf(input, delivery?.work_item_id),
      "review",
      "6.4/review conditional",
      `${delivery_id ?? "the delivery"} needs its review conditions addressed and rechecked`,
      "rework",
    );
    return;
  }

  // §6.4: a rejection produces a rework Run for the delivery's Assignment.
  const delivery = input.snapshot.deliveries.find(
    (candidate) => candidate.id === delivery_id,
  );
  const item = itemOf(input, delivery?.work_item_id);
  noteAssignment(
    input,
    draft,
    item,
    "review",
    "6.4/review rejected",
    `${delivery_id ?? "the delivery"} was rejected; rework is needed`,
  );

  // §7.2: a delivery rejected twice needs re-planning, not another rework.
  const rejections = reviews.filter((review) => review.verdict === "reject");
  if (rejections.length >= 2) {
    draft.notifications.push(
      escalation(
        input,
        "delivery rejected twice",
        `${delivery_id} was rejected ${rejections.length} times`,
      ),
    );
  }
}

/** §6.4: a decision for the human becomes Needs You plus a PM Office brief. */
function routeDecisionRequested(input: RouteInput, draft: Draft): void {
  const decision_id = payloadString(input.event.payload, "decision_id");
  const decision = input.snapshot.decisions.find(
    (candidate) => candidate.id === decision_id,
  );
  if (decision === undefined) {
    problem(
      draft,
      "6.4/decision requested",
      "unknown_mention",
      `decision ${decision_id ?? "(none)"} was not found`,
    );
    return;
  }
  if (decision.decider === "human") {
    note(
      input,
      draft,
      recipient.needs_you(),
      "needs_you",
      "6.4/decision requested",
      `${decision.id}: ${decision.question}`,
    );
    note(
      input,
      draft,
      recipient.pm_office(),
      "decision",
      "6.4/decision requested",
      `${decision.id} needs the human's decision`,
    );
    return;
  }
  if (decision.decider === "role:pm") {
    note(
      input,
      draft,
      recipient.pm_ops(),
      "decision",
      "6.4/decision requested",
      decision.trigger === "merge_confirmation"
        ? `${decision.id} 等待项目经理确认合并：${decision.question}。闸门检查、验证全部通过且无 must_fix 才能选 merge，并写知会；否则 hold、request_changes 或交人。`
        : `${decision.id} 等待项目经理按类别授权处理：${decision.question}`,
    );
    return;
  }
  for (const assignment of assignmentsForRole(
    input,
    decision.decider.replace(/^role:/u, ""),
    input.event.card_id,
  )) {
    note(
      input,
      draft,
      recipient.assignment(assignment.id),
      "decision",
      "6.4/decision requested",
      `${decision.id} is waiting for your decision`,
    );
  }
}

/**
 * §6.4: a resolved decision wakes every Assignment it had blocked.
 *
 * There is no generic PM Ops summary: the affected Assignments already get the
 * result, and PM Ops only needs the targeted noteAssignment fallback when a
 * blocked work item has no active owner to resume (M5.S S25 follow-up).
 */
function routeDecisionResolved(input: RouteInput, draft: Draft): void {
  const decision_id = payloadString(input.event.payload, "decision_id");
  const q = input.snapshot.decisions.find((q) => q.id === decision_id);
  // P2a-1 §2.6: the check failed before the merge was confirmed (human or
  // timeout); the item now belongs to PM Ops, so wake it here as well.
  if (
    input.event.type === "decision_resolved" &&
    q?.trigger === "merge_confirmation" &&
    q.card_id &&
    q.status === "resolved" &&
    q.resolution?.option === "merge" &&
    q.kind === "approve" &&
    "delivery_id" in q.target
  ) {
    const check = latestMergeCheck(
      input.snapshot.events,
      q.card_id,
      q.target.delivery_id,
    );
    if (
      check &&
      (check.status === "failed" || check.status === "timed_out") &&
      pmMergeCheckDelegationAllowed(input.snapshot, q, check)
    )
      note(
        input,
        draft,
        recipient.pm_ops(),
        "decision",
        "6.4/merge check finished",
        `${subject(input)} 已确认合并，但合并检查结果 ${check.status}，${mergeRequiresHuman(input.snapshot, q) ? "仅可重新检查超时，不能退回或代确认合并" : "请判断后退回修改或重新检查"}（${q.id}）。`,
      );
  }
  if (
    input.event.type === "decision_resolved" &&
    q?.raised_by?.startsWith("assignment:") &&
    q.resolution
  ) {
    const id = q.raised_by.slice(11) as AssignmentId;
    const owner = assignmentOf(input, id);
    const ownerItem =
      owner?.scope === "work_item"
        ? itemOf(input, owner.work_item_id)
        : undefined;
    const ownerCard = input.snapshot.cards.find(
      (c) => c.id === ownerItem?.card_id,
    );
    const to = requesterNotificationRecipient(
      q.raised_by,
      input.snapshot.assignments,
      {
        skip_requester: ["done", "cancelled"].includes(ownerCard?.status ?? ""),
      },
    );
    if (!to) return;
    const option = q.options.find((o) => o.key === q.resolution?.option);
    note(
      input,
      draft,
      to,
      to.kind === "needs_you" ? "needs_you" : "decision",
      "6.4/decision resolved",
      `${q.id} 已选择 ${q.resolution.option}：${option?.description ?? ""}。影响：${option?.impact ?? ""}。请发起人落实，并在时间线引用 ${q.id} 记录执行结果。`,
    );
  }
  const resolved = payloadStrings(input.event.payload, "resume_work_items");
  for (const id of resolved) {
    const item = itemOf(input, id as WorkItemId);
    noteAssignment(
      input,
      draft,
      item,
      "decision",
      "6.4/decision resolved",
      `${decision_id ?? "the decision"} was resolved; continue ${id}`,
    );
  }
}

/** Completion informs the requester and current waiters without clearing blockers. */
function routeHumanActionCompleted(input: RouteInput, draft: Draft): void {
  const action = input.snapshot.human_actions.find(
    (h) => h.id === payloadString(input.event.payload, "human_action_id"),
  );
  if (action?.status !== "done") return;
  const rule = "6.4/human action completed";
  const summary = `${action.card_id ?? "项目"} ${action.key}: 已完成；${action.result?.text ?? entryOf(input)?.body ?? ""}`;
  // A verifier without a current target cannot act on this result. Keep the
  // completion event readable via get_updates and wait for the delivery bell.
  const hasTarget = (item: WorkItem | undefined) =>
    item?.kind !== "verify" ||
    input.snapshot.deliveries.some(
      (delivery) =>
        itemOf(input, delivery.work_item_id)?.card_id === item.card_id &&
        delivery.status !== "superseded" &&
        (item.target_work_item_id
          ? delivery.work_item_id === item.target_work_item_id &&
            delivery.kind !== "card_completion"
          : delivery.kind === "card_completion" &&
            delivery.requested_verifiers.includes(item.id)),
    );
  const to = requesterNotificationRecipient(
    action.requested_by,
    input.snapshot.assignments,
  );
  if (
    to &&
    (to.kind !== "assignment" ||
      hasTarget(
        input.snapshot.work_items.find(
          (item) => item.assignment_id === to.assignment_id,
        ),
      ))
  )
    note(
      input,
      draft,
      to,
      to.kind === "needs_you" ? "needs_you" : "human_action",
      rule,
      summary,
    );

  // Keep the decision-resolved resumption path, including its unowned-item fallback.
  const resumed = payloadStrings(input.event.payload, "resume_work_items");
  for (const id of resumed) {
    const item = itemOf(input, id as WorkItemId);
    if (!hasTarget(item)) continue;
    noteAssignment(input, draft, item, "human_action", rule, summary);
  }
  for (const item of input.snapshot.work_items) {
    if (item.card_id !== action.card_id || !hasTarget(item)) continue;
    const waiting =
      ["blocked", "waiting_decision", "delivered"].includes(item.status) ||
      (item.kind === "verify" &&
        ["todo", "ready", "in_progress"].includes(item.status));
    const owner = assignmentOf(input, item.assignment_id);
    if (waiting && owner?.scope === "work_item" && isActive(owner))
      note(
        input,
        draft,
        recipient.assignment(owner.id),
        "human_action",
        rule,
        summary,
        { work_item_id: item.id },
      );
  }
}

/**
 * Appendix A step 2 / M5.S S6: an Assignment created through MCP gets its first
 * Run from the host, so the new Assignment is woken right away and the
 * Dispatcher opens the terminal with the same `launchRun` the CLI uses.
 *
 * Produce items wait for their dependencies. Verification notices are retained
 * until Dispatcher finds a current target delivery. A human assigning from the
 * CLI starts the Assignment explicitly (`assign --start` or `assignment start`), so it is not
 * woken here and never gets a second Run from this route.
 */
function routeAssignment(input: RouteInput, draft: Draft): void {
  if (input.event.actor.kind === "human") return;
  const item = itemOf(
    input,
    payloadString(input.event.payload, "work_item_id") as
      | WorkItemId
      | undefined,
  );
  if (item === undefined) return;
  const assignment = assignmentOf(input, item.assignment_id);
  if (assignment === undefined || !isActive(assignment)) return;
  // Verification assignment notices wait in the inbox until a current target
  // exists. Dispatcher checks the fresh delivery state before queuing a Run.
  if (
    item.kind !== "verify" &&
    !canStartWork({ item, work_items: input.snapshot.work_items })
  )
    return;
  note(
    input,
    draft,
    recipient.assignment(assignment.id),
    "assignment",
    "6.4/work item assigned",
    `${item.id} was assigned; start it`,
    { work_item_id: item.id },
  );
}

/** §6.4: a finished dependency wakes the downstream Assignments. */
function routeWorkItemUpdate(input: RouteInput, draft: Draft): void {
  const item_id = payloadString(input.event.payload, "work_item_id");
  const item = itemOf(input, item_id as WorkItemId | undefined);
  if (item === undefined || !succeeded(item)) {
    return;
  }
  const downstream = input.snapshot.work_items.filter((candidate) =>
    candidate.depends_on.includes(item.id),
  );
  if (downstream.length === 0) return;
  for (const candidate of downstream) {
    noteAssignment(
      input,
      draft,
      candidate,
      "dependency",
      "6.4/dependency completed",
      `${item.id} completed; ${candidate.id} can start`,
    );
  }
}

/** §6.4: a human action request is "waiting for you" plus a PM Office brief. */
function routeHumanAction(input: RouteInput, draft: Draft): void {
  const action_id = payloadString(input.event.payload, "human_action_id");
  const action = input.snapshot.human_actions.find(
    (candidate) => candidate.id === action_id,
  );
  if (action?.triage === "pm_ops") {
    note(
      input,
      draft,
      recipient.pm_ops(),
      "human_action",
      "6.4/human action requested",
      `${action.id} 等待分拣：${action.instructions}`,
    );
    return;
  }
  note(
    input,
    draft,
    recipient.needs_you(),
    "needs_you",
    "6.4/human action requested",
    `${action_id ?? "a human action"}: ${action?.instructions ?? ""}`.trim(),
  );
  note(
    input,
    draft,
    recipient.pm_office(),
    "human_action",
    "6.4/human action requested",
    `${action_id ?? "a human action"} is waiting for the human`,
  );
}

/** §6.4: a Run that produced nothing (no delivery, blocker or decision). */
function routeRunFinished(input: RouteInput, draft: Draft): void {
  const outcome = payloadString(input.event.payload, "outcome");
  // §7.3: an execution failure is PM Ops' business, like a Run that finished
  // without output; neither may interrupt the human or PM Office.
  if (outcome !== "completed" && outcome !== "failed") return;
  const run_id = payloadString(input.event.payload, "run_id");
  // §7.1: a standing PM (Office or Ops) closes a working turn, not a
  // deliverable; its conclusion is the summary, so finishing without a
  // delivery is its normal outcome and never the §7.2 exception.
  const owner = assignmentOf(
    input,
    input.snapshot.runs.find((candidate) => candidate.id === run_id)
      ?.assignment_id,
  );
  if (owner?.scope === "standing") {
    // §6.1: an Assignment is never woken by its own Run, so the PM's own
    // failure goes to the human instead of looping back into another Run.
    if (outcome === "failed")
      note(
        input,
        draft,
        recipient.needs_you(),
        "escalation",
        "7.3/agent execution failed",
        `${owner.id} failed run ${run_id ?? "?"}: ${payloadString(input.event.payload, "summary") ?? "no summary"}`,
      );
    return;
  }
  // §6.4: only a Run that produced nothing (no delivery, review, blocker or
  // decision) is an exception; one that delivered, reviewed or raised
  // something has done its job. Verification Runs end after submit_review, and
  // that event carries no run_id, so reviews are matched on their own row
  // (M5.S S25).
  const produced = [
    ...input.snapshot.events.filter(
      (event) =>
        payloadString(event.payload, "run_id") === run_id &&
        [
          "delivery_submitted",
          "blocker_reported",
          "decision_requested",
          "human_action_requested",
        ].includes(event.type),
    ),
    ...input.snapshot.deliveries.filter(
      (delivery) => delivery.run_id === run_id,
    ),
    ...input.snapshot.reviews.filter((review) => review.run_id === run_id),
  ];
  if (produced.length > 0) return;
  note(
    input,
    draft,
    recipient.pm_ops(),
    outcome === "failed" ? "escalation" : "run_attention",
    outcome === "failed"
      ? "7.3/agent execution failed"
      : "6.4/run finished without output",
    `run ${payloadString(input.event.payload, "run_id") ?? "?"} ${
      outcome === "failed" ? "failed" : "finished"
    } without a delivery or review`,
  );
}

/** §7.2: the five conditions that are a judgement call, not a rule. */
export type EscalationReason =
  | "work conflict or priority contention"
  | "delivery rejected twice"
  | "delivery does not match the requirement"
  | "decide whether to pause"
  | "unhandled exception";

export function escalation(
  input: RouteInput,
  reason: EscalationReason,
  detail: string,
): RoutedNotification {
  return {
    recipient: recipient.pm_ops(),
    kind: "escalation",
    rule: `7.2/${reason}`,
    event_id: input.event.id,
    seq: input.event.seq,
    card_id: input.event.card_id,
    summary: detail,
  };
}

/** Route one event; pure, so the same input always yields the same output. */
export function routeEvent(input: RouteInput): RouteResult {
  const draft: Draft = { notifications: [], checks: [], problems: [] };
  switch (input.event.type) {
    case "card_created":
      routeCardPlanning(input, draft);
      break;
    case "card_updated":
      if (payloadString(input.event.payload, "status") === "todo") {
        // updateCard also emits status on title-only edits. Compare the last
        // planning event in this card's stream, not the current snapshot.
        const previous = input.snapshot.events
          .filter(
            (e) =>
              e.card_id === input.event.card_id &&
              e.seq < input.event.seq &&
              ["card_created", "card_updated"].includes(e.type),
          )
          .sort((a, b) => b.seq - a.seq)[0];
        if (previous && payloadString(previous.payload, "status") === "backlog")
          routeCardPlanning(input, draft);
      }
      break;
    case "run_dispatch_recovered": {
      const id = payloadString(input.event.payload, "assignment_id") as
        | AssignmentId
        | undefined;
      const a = assignmentOf(input, id);
      if (a?.status === "active")
        note(
          input,
          draft,
          recipient.assignment(a.id),
          "assignment",
          "6.4/bell delivery failed",
          payloadString(input.event.payload, "body") ??
            "派发超时，已自动重排一次",
        );
      break;
    }
    case "run_dispatch_stalled":
      if (payloadString(input.event.payload, "audience") === "pm_ops")
        note(
          input,
          draft,
          recipient.pm_ops(),
          "run_attention",
          "6.4/bell delivery failed",
          payloadString(input.event.payload, "body") ??
            "派发恢复失败，请检查运行环境",
        );
      break;
    case "comment_posted":
      routeComment(input, draft);
      break;
    case "instruction_issued":
    case "instruction":
      routeInstruction(input, draft);
      break;
    case "delivery_submitted":
      routeDelivery(input, draft);
      break;
    case "review_submitted":
    case "completion_reviewed":
      routeReview(input, draft);
      break;
    case "delivery_accepted":
      routeDeliveryAccepted(input, draft);
      break;
    case "decision_requested":
      routeDecisionRequested(input, draft);
      break;
    case "decision_followup_due": {
      const q = input.snapshot.decisions.find(
        (q) => q.id === payloadString(input.event.payload, "decision_id"),
      );
      const to =
        q &&
        requesterNotificationRecipient(
          q.raised_by,
          input.snapshot.assignments,
          { skip_requester: true },
        );
      if (to)
        note(
          input,
          draft,
          to,
          to.kind === "needs_you" ? "needs_you" : "decision",
          "6.4/decision resolved",
          `${q.id} 已拍板超过 30 分钟，尚无落实结果，请跟进发起人。`,
        );
      break;
    }
    case "decision_resolved":
    case "decision_provisionally_resolved":
      routeDecisionResolved(input, draft);
      break;
    case "work_item_updated":
      routeWorkItemUpdate(input, draft);
      break;
    case "work_item_assigned":
      routeAssignment(input, draft);
      routeWorkItemUpdate(input, draft);
      break;
    case "human_action_requested":
      routeHumanAction(input, draft);
      break;
    case "human_action_completed":
      routeHumanActionCompleted(input, draft);
      break;
    case "merge_conflicted":
    case "merge_changes_requested": {
      const returned = input.event.type === "merge_changes_requested";
      const rule = returned
        ? "6.4/merge changes requested"
        : "6.4/merge conflicted";
      const item = itemOf(
        input,
        payloadString(input.event.payload, "work_item_id") as
          | WorkItemId
          | undefined,
      );
      const owner = assignmentOf(input, item?.assignment_id);
      if (
        item?.card_id === input.event.card_id &&
        item?.kind === "produce" &&
        owner &&
        isActive(owner)
      )
        note(
          input,
          draft,
          recipient.assignment(owner.id),
          "instruction",
          rule,
          returned
            ? `Changes requested for ${item.id}: ${payloadString(input.event.payload, "reason") ?? ""}`
            : `Resolve the merge conflict for ${item.id}`,
          { work_item_id: item.id, run_kind: "fix" },
        );
      else
        note(
          input,
          draft,
          recipient.pm_ops(),
          "escalation",
          rule,
          returned
            ? "Merge changes have no active producer"
            : "Merge conflict has no active producer",
        );
      break;
    }
    case "merge_check_finished": {
      // §7.4: the PM-held merge confirmation can be answered once the check is
      // known; a failed or timed-out check on a confirmed merge is PM's to
      // return or recheck unless the card is human-only (P2a-1 §2.6).
      const status = payloadString(input.event.payload, "status");
      const completion = payloadString(input.event.payload, "completion_id");
      const q = input.snapshot.decisions.find((q) => {
        if (
          q.trigger !== "merge_confirmation" ||
          !q.card_id ||
          q.card_id !== input.event.card_id
        )
          return false;
        if (q.decider === "role:pm" && q.status === "open") return true;
        const eligible =
          (q.status === "resolved" && q.resolution?.option === "merge") ||
          (mergeRequiresHuman(input.snapshot, q) &&
            ["open", "provisional"].includes(q.status));
        if (
          !eligible ||
          (status !== "failed" && status !== "timed_out") ||
          q.kind !== "approve" ||
          !("delivery_id" in q.target) ||
          q.target.delivery_id !== completion
        )
          return false;
        return pmMergeCheckDelegationAllowed(
          input.snapshot,
          q,
          latestMergeCheck(
            input.snapshot.events,
            q.card_id,
            q.target.delivery_id,
          ),
        );
      });
      if (q)
        note(
          input,
          draft,
          recipient.pm_ops(),
          "decision",
          "6.4/merge check finished",
          mergeRequiresHuman(input.snapshot, q)
            ? `${subject(input)} 合并检查超时，PM 仅可重新检查，不能退回或代确认合并（${q.id}）。`
            : q.status === "resolved"
              ? `${subject(input)} 已确认合并，但合并检查结果 ${status}，请判断后退回修改或重新检查（${q.id}）。`
              : `${subject(input)} 合并检查结果 ${status ?? "未知"}，请处理合并确认 ${q.id}。`,
        );
      break;
    }
    case "card_merged":
      note(
        input,
        draft,
        recipient.pm_ops(),
        "completion",
        "6.4/card merged",
        `${subject(input)} merged into the central baseline`,
      );
      break;
    case "merge_failed":
      note(
        input,
        draft,
        recipient.pm_ops(),
        "escalation",
        "6.4/merge failed",
        `${subject(input)} merge failed`,
      );
      break;
    case "reconcile_finding":
      note(
        input,
        draft,
        recipient.pm_ops(),
        "escalation",
        "6.4/reconcile finding",
        "Git reconciliation found an item needing attention",
      );
      break;
    case "run_finished":
      routeRunFinished(input, draft);
      break;
    default:
      // work_item_created, blocker_reported,
      // attachments and the run lifecycle events do not change who acts next.
      break;
  }
  return draft;
}

/** §6.4: failures that cannot be recovered go to PM Ops. */
export function routeBellFailure(input: {
  readonly event_id: EventId;
  readonly seq: number;
  readonly card_id?: CardId;
  readonly assignment_id: AssignmentId;
  readonly reason: string;
}): RoutedNotification {
  return {
    recipient: recipient.pm_ops(),
    kind: "escalation",
    rule: "6.4/bell delivery failed",
    event_id: input.event_id,
    seq: input.seq,
    card_id: input.card_id,
    summary: `bell to ${input.assignment_id} failed: ${input.reason}`,
  };
}

/** §6.4 / §3.3: a running Agent that never calls `finish_run`. */
export function routeWatchdog(input: {
  readonly event_id: EventId;
  readonly seq: number;
  readonly card_id?: CardId;
  readonly assignment_id: AssignmentId;
  readonly idle_minutes: number;
}): RoutedNotification {
  return {
    recipient: recipient.pm_ops(),
    kind: "run_attention",
    rule: "6.4/agent idle without finish_run",
    event_id: input.event_id,
    seq: input.seq,
    card_id: input.card_id,
    summary: `${input.assignment_id} has been idle for ${input.idle_minutes} minutes without finish_run`,
  };
}

/** §6.4 / §13.9: a lost runtime beyond the grace period is the human's call. */
export function routeRuntimeLost(input: {
  readonly event_id: EventId;
  readonly seq: number;
  readonly card_id?: CardId;
  readonly assignment_id: AssignmentId;
  readonly lost_minutes: number;
}): RoutedNotification {
  return {
    recipient: recipient.needs_you(),
    kind: "needs_you",
    rule: "6.4/runtime lost",
    event_id: input.event_id,
    seq: input.seq,
    card_id: input.card_id,
    summary: `${input.assignment_id} lost its runtime ${input.lost_minutes} minutes ago; decide whether to take over`,
  };
}
