import type { NextOwnerItem, WaitingOnItem } from "./card-derived-types.js";
import { deriveCardStatus } from "./derived.js";
import type {
  Assignment,
  Card,
  Decider,
  Decision,
  Delivery,
  Event,
  HumanAction,
  Review,
  Run,
  WorkItem,
} from "./entities.js";
import type { CardStatus, DecisionStatus } from "./states.js";
import { type CardTemplate, cardTemplate } from "./templates.js";
import {
  verificationActivity,
  verificationTarget,
} from "./verification-activity.js";

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
  readonly runs?: readonly Run[];
  readonly events?: readonly Event[];
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

const UNRESOLVED_DECISION: ReadonlySet<DecisionStatus> = new Set([
  "open",
  "provisional",
  "snoozed",
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
    const delivery = verificationTarget(item, input);
    if (delivery) pending.push({ work_item: item, delivery });
  }
  return pending;
}

function waitingForDelivery(input: CardDerivedInput, item: WorkItem): boolean {
  if (item.kind !== "verify" || !["ready", "in_progress"].includes(item.status))
    return false;
  return verificationTarget(item, input) === undefined;
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
  if (input.card.hold)
    waiting.push({
      kind: "blocked",
      ref: input.card.id,
      label: `已暂停：${input.card.hold.reason}`,
    });

  for (const decision of unresolvedBlockingDecisions(input)) {
    waiting.push({
      kind: "decision",
      ref: decision.id,
      label: `${decision.decider === "system" ? "等待系统合并" : decision.decider === "role:pm" ? "等待 PM 代拍" : "等你拍板"} ${decision.id}`,
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

  for (const item of input.work_items.filter((w) =>
    waitingForDelivery(input, w),
  ))
    waiting.push({ kind: "review", ref: item.id, label: "等待新交付" });
  for (const item of input.work_items) {
    if (item.status === "blocked") {
      waiting.push({ kind: "blocked", ref: item.id, label: `${item.id} 阻塞` });
    }
  }

  return waiting;
}

function deciderOwner(decider: Decider): NextOwnerItem {
  if (decider === "system") return { kind: "system", ref: "system" };
  return decider === "human"
    ? { kind: "human", ref: "human" }
    : { kind: "role", ref: decider.slice("role:".length) };
}

function completionReviewer(input: CardDerivedInput): Decider | undefined {
  const template = input.template ?? cardTemplate(input.card);
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
  if (input.card.hold) return [{ kind: "role", ref: "pm" }];
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

  if (
    input.card.story &&
    !["done", "cancelled", "backlog"].includes(input.card.status)
  ) {
    add(
      input.card.story.summary_entry_id
        ? { kind: "human", ref: "human" }
        : { kind: "role", ref: "pm" },
    );
    return owners;
  }
  const assignments = new Map(
    (input.assignments ?? []).map((assignment) => [assignment.id, assignment]),
  );
  const pendingIds = new Set(pendingReviews(input).map((p) => p.work_item.id));
  for (const item of input.work_items) {
    if (!ACTIVE_WORK_ITEM.has(item.status)) {
      continue;
    }
    if (item.kind === "verify" && !pendingIds.has(item.id)) continue;
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
  if (input.card.hold) return clamp(`已暂停：${input.card.hold.reason}`);
  const decisions = unresolvedBlockingDecisions(input);
  if (decisions.length > 0) {
    const first = decisions[0]?.id ?? "";
    const who =
      decisions[0]?.decider === "system"
        ? "等待系统合并"
        : decisions[0]?.decider === "role:pm"
          ? "等待 PM 代拍"
          : "等你拍板";
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

  const rework = input.work_items.find(
    (item) => item.status === "changes_requested",
  );
  if (rework !== undefined) {
    return clamp(`${rework.role_id} 返工中`);
  }

  if (submittedCompletion(input) !== undefined) {
    return clamp("等待完成审核");
  }

  const pending = pendingReviews(input);
  if (pending.length > 0) {
    const activities = pending
      .map(({ work_item }) =>
        verificationActivity(work_item, {
          deliveries: input.deliveries,
          reviews: input.reviews,
          runs: input.runs ?? [],
          events: input.events ?? [],
        }),
      )
      .filter((v) => v !== undefined);
    const running = activities.find((a) => a.status === "running");
    if (running) return running.label;
    const activity = activities[0];
    if (activity) return activity.label;
    const first = pending[0];
    return clamp(
      `等待 ${first?.work_item.role_id ?? ""} 审核 ${first?.delivery.id ?? ""}`,
    );
  }

  if (input.work_items.some((w) => waitingForDelivery(input, w)))
    return "等待新交付";
  const status = derivedStatus(input);
  if (status === "review")
    return input.work_items.some(
      (w) => w.kind === "produce" && w.status === "delivered",
    )
      ? "等待交付审核"
      : "等待完成申请";
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
