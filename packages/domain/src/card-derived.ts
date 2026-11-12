import type { NextOwnerItem, WaitingOnItem } from "./card-derived-types.js";
import { deriveCardStatus, isReviewStale } from "./derived.js";
import type {
  Assignment,
  Card,
  Decider,
  Decision,
  Delivery,
  HumanAction,
  Review,
  WorkItem,
} from "./entities.js";
import type { CardStatus, DecisionStatus } from "./states.js";
import { builtinCardTemplates, type CardTemplate } from "./templates.js";

export type { NextOwnerItem, WaitingOnItem } from "./card-derived-types.js";

/**
 * Card fields that are computed from the card's items rather than stored
 * (`waiting_on`, `next_owners`, `why`, §4.3). Kept in its own file so the
 * entity and transition files stay untouched.
 *
 * A card is "waiting" when something outside the work itself must happen: a
 * decision, a human action, a review, or a blocked work item. `next_owners` is
 * who acts next, and `why` is the one-line reason shown in Needs You (§8.2).
 */

/** `why` is shown in a single list row, so it stays short (§8.2). */
export const WHY_MAX_LENGTH = 40;

export interface CardDerivedFields {
  readonly waiting_on: readonly WaitingOnItem[];
  readonly next_owners: readonly NextOwnerItem[];
  readonly why: string;
}

export interface CardDerivedInput {
  readonly card: Card;
  /** Work items of this card. */
  readonly work_items: readonly WorkItem[];
  readonly assignments?: readonly Assignment[];
  /** Deliveries of this card's work items. */
  readonly deliveries: readonly Delivery[];
  readonly reviews: readonly Review[];
  /** Decisions and human actions relevant to the card. */
  readonly decisions: readonly Decision[];
  readonly human_actions: readonly HumanAction[];
  /** Template override; defaults to the one matching `card.template`. */
  readonly template?: Pick<CardTemplate, "completion">;
  /** Derived status; defaults to `deriveCardStatus` over the card and items. */
  readonly status?: CardStatus;
}

const TEMPLATES: Readonly<Record<string, Pick<CardTemplate, "completion">>> = {
  ...Object.fromEntries(builtinCardTemplates.map((t) => [t.id, t])),
};

const UNRESOLVED_DECISION: ReadonlySet<DecisionStatus> = new Set([
  "open",
  "provisional",
]);

/** Work items whose owner is expected to act next. */
const ACTIVE_WORK_ITEM: ReadonlySet<string> = new Set([
  "ready",
  "in_progress",
  "changes_requested",
]);

/** Numeric tail of a readable id (`D-12` → 12, `Q-3` → 3). */
function idNumber(id: string): number {
  const digits = /(\d+)\)?$/.exec(id)?.[1];
  return digits === undefined ? 0 : Number(digits);
}

function byId<T extends { readonly id: string }>(left: T, right: T): number {
  return idNumber(left.id) - idNumber(right.id);
}

const inCard = (card: Card, decision: Decision): boolean =>
  decision.card_id === card.id || decision.affected_cards.includes(card.id);

/** An open human action that blocks this card or one of its work items. */
function isPendingHumanAction(
  card: Card,
  workItemIds: ReadonlySet<string>,
  action: HumanAction,
): boolean {
  return (
    action.status === "open" &&
    (action.card_id === card.id ||
      action.blocked_work_items.some((id) => workItemIds.has(id)))
  );
}

/** The current product delivery; a completion request is a separate review target. */
function currentDelivery(
  workItemId: string,
  deliveries: readonly Delivery[],
): Delivery | undefined {
  const superseded = new Set(
    deliveries.flatMap((delivery) =>
      delivery.supersedes === undefined ? [] : [delivery.supersedes],
    ),
  );
  return deliveries
    .filter(
      (delivery) =>
        delivery.work_item_id === workItemId &&
        delivery.kind !== "card_completion" &&
        delivery.status !== "superseded" &&
        !superseded.has(delivery.id),
    )
    .sort(byId)
    .at(-1);
}

/** The submitted completion request, if the card is waiting for acceptance. */
function submittedCompletion(input: CardDerivedInput): Delivery | undefined {
  const completion = completionDelivery(input.deliveries);
  return completion?.status === "submitted" ? completion : undefined;
}

/** The newest `card_completion` delivery (the card's completion request). */
function completionDelivery(
  deliveries: readonly Delivery[],
): Delivery | undefined {
  return deliveries
    .filter((delivery) => delivery.kind === "card_completion")
    .sort(byId)
    .at(-1);
}

/** A review counts only when it targets the delivery's current subject. */
function reviewedDelivery(
  reviews: readonly Review[],
  delivery: Delivery,
  verifyWorkItemId: string,
): boolean {
  return reviews.some(
    (review) =>
      review.work_item_id === verifyWorkItemId &&
      !isReviewStale(review, delivery),
  );
}

interface PendingReview {
  readonly work_item: WorkItem;
  readonly delivery: Delivery;
}

/**
 * Verify work items whose delivery version has no conclusion yet.
 *
 * A verify item with `target_work_item_id` looks at the current delivery of
 * that item; one without a target (the template's acceptance step) looks at the
 * submitted completion request.
 */
function pendingReviews(input: CardDerivedInput): PendingReview[] {
  const pending: PendingReview[] = [];
  for (const item of input.work_items) {
    if (item.kind !== "verify") {
      continue;
    }
    if (item.status === "passed" || item.status === "cancelled") {
      continue;
    }
    const delivery =
      item.target_work_item_id === undefined
        ? submittedCompletion(input)
        : currentDelivery(item.target_work_item_id, input.deliveries);
    if (delivery === undefined) {
      continue;
    }
    if (!reviewedDelivery(input.reviews, delivery, item.id)) {
      pending.push({ work_item: item, delivery });
    }
  }
  return pending;
}

function unresolvedBlockingDecisions(input: CardDerivedInput): Decision[] {
  return input.decisions
    .filter(
      (decision) =>
        decision.blocking &&
        UNRESOLVED_DECISION.has(decision.status) &&
        inCard(input.card, decision),
    )
    .sort(byId);
}

function pendingHumanActions(input: CardDerivedInput): HumanAction[] {
  const workItemIds = new Set(input.work_items.map((item) => item.id));
  return input.human_actions
    .filter((action) => isPendingHumanAction(input.card, workItemIds, action))
    .sort(byId);
}

/** What the card is waiting for, in the order the plan lists it. */
export function deriveWaitingOn(input: CardDerivedInput): WaitingOnItem[] {
  const waiting: WaitingOnItem[] = [];

  for (const decision of unresolvedBlockingDecisions(input)) {
    waiting.push({
      kind: "decision",
      ref: decision.id,
      label: `${decision.decider === "role:pm" ? "等待 PM 代拍" : "等你拍板"} ${decision.id}`,
    });
  }

  for (const action of pendingHumanActions(input)) {
    waiting.push({
      kind: "human_action",
      ref: action.id,
      label: `${action.triage === "pm_ops" ? "等待 PM 分拣" : action.triage === "host" ? "等待主机操作" : "等你执行"} ${action.id}`,
    });
  }

  for (const pending of pendingReviews(input)) {
    waiting.push({
      kind: "review",
      ref: pending.work_item.id,
      label: `等待 ${pending.work_item.role_id} 审核 ${pending.delivery.id}`,
    });
  }

  for (const item of input.work_items) {
    if (item.status === "blocked") {
      waiting.push({ kind: "blocked", ref: item.id, label: `${item.id} 阻塞` });
    }
  }

  return waiting;
}

function deciderOwner(decider: Decider): NextOwnerItem {
  return decider === "human"
    ? { kind: "human", ref: "human" }
    : { kind: "role", ref: decider.slice("role:".length) };
}

function completionReviewer(input: CardDerivedInput): Decider | undefined {
  const template = input.template ?? TEMPLATES[input.card.template];
  return template?.completion.mode === "review"
    ? template.completion.reviewer
    : undefined;
}

/**
 * Who acts next, highest priority first and de-duplicated:
 * blocking decisions and pending human actions, then active work items, then
 * the completion reviewer.
 */
export function deriveNextOwners(input: CardDerivedInput): NextOwnerItem[] {
  const owners: NextOwnerItem[] = [];
  const seen = new Set<string>();
  const add = (owner: NextOwnerItem): void => {
    const key = `${owner.kind}:${owner.ref}`;
    if (!seen.has(key)) {
      seen.add(key);
      owners.push(owner);
    }
  };

  for (const decision of unresolvedBlockingDecisions(input)) {
    add(deciderOwner(decision.decider));
  }
  for (const action of pendingHumanActions(input)) {
    add(
      action.triage === "pm_ops"
        ? { kind: "role", ref: "pm" }
        : { kind: "human", ref: "human" },
    );
  }

  const assignments = new Map(
    (input.assignments ?? []).map((assignment) => [assignment.id, assignment]),
  );
  for (const item of input.work_items) {
    if (!ACTIVE_WORK_ITEM.has(item.status)) {
      continue;
    }
    const assignment =
      item.assignment_id === undefined
        ? undefined
        : assignments.get(item.assignment_id);
    if (assignment !== undefined && assignment.status !== "released") {
      add({ kind: "assignment", ref: assignment.id });
    } else {
      add({ kind: "role", ref: item.role_id });
    }
  }

  if (submittedCompletion(input) !== undefined) {
    const reviewer = completionReviewer(input);
    if (reviewer !== undefined) {
      add(deciderOwner(reviewer));
    }
  }

  return owners;
}

function derivedStatus(input: CardDerivedInput): CardStatus {
  return (
    input.status ??
    deriveCardStatus(
      input.card.status,
      input.work_items,
      completionDelivery(input.deliveries),
    )
  );
}

/**
 * One line explaining the card's state, at most `WHY_MAX_LENGTH` characters.
 *
 * Priorities follow the plan: decisions, human actions, completion review,
 * delivery review, rework, in progress, planning, terminal.
 */
export function deriveWhy(input: CardDerivedInput): string {
  const decisions = unresolvedBlockingDecisions(input);
  if (decisions.length > 0) {
    const first = decisions[0]?.id ?? "";
    const who =
      decisions[0]?.decider === "role:pm" ? "等待 PM 代拍" : "等你拍板";
    return clamp(
      decisions.length > 1
        ? `${who} ${first} 等 ${decisions.length} 项`
        : `${who} ${first}`,
    );
  }

  const actions = pendingHumanActions(input);
  if (actions.length > 0) {
    return clamp(
      `${actions[0]?.triage === "pm_ops" ? "等待 PM 分拣" : actions[0]?.triage === "host" ? "等待主机操作" : "等你执行"} ${actions[0]?.id ?? ""}`,
    );
  }

  if (submittedCompletion(input) !== undefined) {
    return clamp("等待完成审核");
  }

  const pending = pendingReviews(input);
  if (pending.length > 0) {
    const first = pending[0];
    return clamp(
      `等待 ${first?.work_item.role_id ?? ""} 审核 ${first?.delivery.id ?? ""}`,
    );
  }

  const rework = input.work_items.find(
    (item) => item.status === "changes_requested",
  );
  if (rework !== undefined) {
    return clamp(`${rework.role_id} 返工中`);
  }

  const status = derivedStatus(input);
  if (status === "done") {
    return "已完成";
  }
  if (status === "cancelled") {
    return "已取消";
  }
  if (status === "backlog" || status === "todo") {
    return "待规划";
  }
  return "进行中";
}

/** All three derived fields in one call. */
export function deriveCardFields(input: CardDerivedInput): CardDerivedFields {
  return {
    waiting_on: deriveWaitingOn(input),
    next_owners: deriveNextOwners(input),
    why: deriveWhy(input),
  };
}

function clamp(text: string): string {
  const characters = Array.from(text);
  return characters.length <= WHY_MAX_LENGTH
    ? text
    : characters.slice(0, WHY_MAX_LENGTH).join("");
}
