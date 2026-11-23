import type {
  Card,
  Event,
  PassCondition,
  Review,
  ReviewAlignment,
  ReviewFollowUpReason,
  ReviewIssue,
  WorkItem,
} from "./entities.js";
import type { CardId, ReviewId, WorkItemId } from "./ids.js";

/**
 * C-610: project-wide invariants a must-fix may cite besides the card's own
 * acceptance criteria and agreed invariants.
 */
export const STANDING_INVARIANTS = {
  lost_work: "会丢工作或数据",
  dual_executor: "会出现两个执行者",
  security: "凭据泄露、越权或注入",
  check_failed: "必跑测试或检查实际失败",
  ui_copy: "界面新增了未要求的说明小字",
} as const;
export type StandingInvariant = keyof typeof STANDING_INVARIANTS;

/** Guards stay blocking only when they protect work, a single executor or security. */
const GUARD_EXEMPT: ReadonlySet<string> = new Set([
  "lost_work",
  "dual_executor",
  "security",
]);
/** Once a checklist exists, only it, agreed invariants and these stay blocking. */
const CHECKLIST_EXEMPT: ReadonlySet<string> = new Set([
  "lost_work",
  "dual_executor",
  "security",
  "check_failed",
]);

export const MAX_PASS_CONDITIONS = 10;
export const MAX_ALIGNMENT_INVARIANTS = 10;

/** New human confirmations, stop conditions and "stop when unsure" requests. */
export const GUARD_PATTERN =
  /人工确认|人工拍板|交人(?:确认|拍板)|由人确认|停摆|(?:应|须|要|就|先)(?:停住|停下|暂停)|核不清|核实不了|(?:无法|不能)(?:核实|确认)(?:时|就)|不确定(?:时|就)(?:停|拒绝|报错)|(?:应|须|要|就)(?:停止|拒绝)推进|fail[- ]?closed/iu;

export type BasisRef =
  | {
      readonly kind: "acceptance" | "invariant" | "pass_condition";
      readonly index: number;
    }
  | { readonly kind: "standing"; readonly key: StandingInvariant };

export function parseBasis(basis: string): BasisRef | undefined {
  const value = basis.trim();
  if (Object.hasOwn(STANDING_INVARIANTS, value))
    return { kind: "standing", key: value as StandingInvariant };
  const match = /^(AC|INV|PC)([1-9]\d{0,2})$/u.exec(value);
  if (!match) return;
  const kind =
    match[1] === "AC"
      ? "acceptance"
      : match[1] === "INV"
        ? "invariant"
        : "pass_condition";
  return { kind, index: Number(match[2]) };
}

/** Why a basis cannot be cited on this card, or undefined when it can. */
export function basisProblem(
  card: Pick<Card, "acceptance_criteria" | "invariants">,
  basis: unknown,
  checklist: readonly PassCondition[] | undefined,
  allowPassCondition = true,
): string | undefined {
  const ref = typeof basis === "string" ? parseBasis(basis) : undefined;
  const choices = `AC1–AC${card.acceptance_criteria.length}、INV1–INV${card.invariants?.length ?? 0}${allowPassCondition && checklist?.length ? `、PC1–PC${checklist.length}` : ""} 或 ${Object.keys(STANDING_INVARIANTS).join("、")}`;
  if (!ref) return `basis 须为 ${choices}`;
  if (ref.kind === "standing") return;
  const size =
    ref.kind === "acceptance"
      ? card.acceptance_criteria.length
      : ref.kind === "invariant"
        ? (card.invariants?.length ?? 0)
        : allowPassCondition
          ? (checklist?.length ?? 0)
          : 0;
  return ref.index <= size ? undefined : `basis 超出范围，可选 ${choices}`;
}

function downgradeReason(
  issue: ReviewIssue,
  card: Pick<Card, "acceptance_criteria" | "invariants">,
  checklist: readonly PassCondition[] | undefined,
): ReviewFollowUpReason | undefined {
  if (!issue.basis || basisProblem(card, issue.basis, checklist))
    return "no_basis";
  const ref = parseBasis(issue.basis);
  const standing = ref?.kind === "standing" ? ref.key : undefined;
  if (
    GUARD_PATTERN.test(issue.description) &&
    !(standing && GUARD_EXEMPT.has(standing))
  )
    return "guard";
  if (
    checklist?.length &&
    ref?.kind !== "pass_condition" &&
    ref?.kind !== "invariant" &&
    !(standing && CHECKLIST_EXEMPT.has(standing))
  )
    return "outside_checklist";
}

/**
 * Requested must-fixes without a citable basis, guard requests and findings
 * outside an active checklist become non-blocking follow-ups.
 */
export function convergeIssues(
  card: Pick<Card, "acceptance_criteria" | "invariants">,
  issues: readonly ReviewIssue[],
  checklist: readonly PassCondition[] | undefined,
): ReviewIssue[] {
  return issues.map((issue) => {
    if (!issue.must_fix || issue.pre_existing) return issue;
    const reason = downgradeReason(issue, card, checklist);
    return reason
      ? { ...issue, must_fix: false, follow_up: { reason } }
      : { ...issue };
  });
}

/** The first checklist of a rejection streak (streak is newest first). */
export function activeChecklist(
  streak: readonly Pick<Review, "pass_conditions">[],
): readonly PassCondition[] | undefined {
  return streak.findLast((r) => r.pass_conditions?.length)?.pass_conditions;
}

/** The alignment round covering this rejection streak, if any. */
export function streakAlignment(
  item: WorkItem,
  streak: readonly Pick<Review, "id">[],
): ReviewAlignment | undefined {
  const alignment = item.kind === "verify" ? item.review_alignment : undefined;
  return alignment && streak.some((r) => r.id === alignment.review_id)
    ? alignment
    : undefined;
}

export const FOLLOW_UP_REASON_LABEL: Readonly<
  Record<ReviewFollowUpReason, string>
> = {
  no_basis: "未对应验收标准或不变量",
  guard: "守卫类意见",
  outside_checklist: "通过条件清单以外",
};

export interface FollowUpDraft {
  readonly source_card_id: CardId;
  readonly title: string;
  readonly goal: string;
  readonly items: readonly {
    readonly review_id: ReviewId;
    readonly work_item_id: WorkItemId;
    readonly description: string;
    readonly reason: ReviewFollowUpReason;
    readonly basis?: string;
  }[];
}

/** C-610: every follow-up recorded on the card, as a card draft for PM. */
export function followUpDraft(
  card: Pick<Card, "id" | "title">,
  reviews: readonly Review[],
): FollowUpDraft | undefined {
  const seen = new Set<string>();
  const items = [...reviews]
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
    .flatMap((review) =>
      review.issues.flatMap((issue) => {
        const key = issue.description.trim();
        if (!issue.follow_up || seen.has(key)) return [];
        seen.add(key);
        return [
          {
            review_id: review.id,
            work_item_id: review.work_item_id,
            description: key,
            reason: issue.follow_up.reason,
            ...(issue.basis ? { basis: issue.basis } : {}),
          },
        ];
      }),
    );
  if (!items.length) return;
  return {
    source_card_id: card.id,
    title: `承接 ${card.id} 的审核后续意见`,
    goal: [
      `${card.id}「${card.title}」审核中记为后续跟进、未挡合并的意见：`,
      ...items.map(
        (item, n) =>
          `${n + 1}. ${item.description}（${item.review_id}，${FOLLOW_UP_REASON_LABEL[item.reason]}）`,
      ),
    ].join("\n"),
    items,
  };
}

export interface RejectionStreakCard {
  readonly card_id: CardId;
  readonly max_streak: number;
  /** When a verifier first reached three consecutive rejections. */
  readonly reached_at: string;
}

/** C-610 metric: cards whose verifier was rejected three or more times in a row. */
export function rejectionStreakCards(state: {
  readonly events: readonly Event[];
  readonly reviews: readonly Pick<Review, "id" | "work_item_id">[];
}): RejectionStreakCard[] {
  const items = new Map(state.reviews.map((r) => [r.id, r.work_item_id]));
  const streaks = new Map<string, number>();
  const cards = new Map<CardId, RejectionStreakCard>();
  for (const e of [...state.events].sort((a, b) => a.seq - b.seq)) {
    if (e.type !== "review_submitted" || !e.card_id) continue;
    const p = e.payload as { review_id?: unknown; verdict?: unknown } | null;
    const item =
      typeof p?.review_id === "string"
        ? items.get(p.review_id as ReviewId)
        : undefined;
    if (!item) continue;
    const streak = p?.verdict === "reject" ? (streaks.get(item) ?? 0) + 1 : 0;
    streaks.set(item, streak);
    if (streak < 3) continue;
    const known = cards.get(e.card_id);
    cards.set(e.card_id, {
      card_id: e.card_id,
      max_streak: Math.max(streak, known?.max_streak ?? 0),
      reached_at: known?.reached_at ?? e.created_at,
    });
  }
  return [...cards.values()].sort((a, b) =>
    a.reached_at.localeCompare(b.reached_at),
  );
}
