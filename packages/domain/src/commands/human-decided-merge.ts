import type {
  Card,
  Decision,
  Event,
  HumanDecidedMergeBasis,
  MergeDecisionEvidence,
} from "../entities.js";
import type { CardId } from "../ids.js";
import {
  pmConfirmHumanDecidedMerges,
  pmMergeConfirmation,
} from "../preferences.js";
import { sourceMergeConfirmation } from "../source-merge.js";
import { type CommandState, ensure } from "./core.js";

export function mergeContentDecisions(
  decisions: readonly Decision[],
  card: Pick<Card, "id" | "source"> & Partial<Pick<Card, "project_id">>,
  events: readonly Event[] = [],
) {
  const source =
    card.source.kind === "decision" ? card.source.decision_id : undefined;
  return decisions.filter(
    (q) =>
      q.trigger !== "merge_confirmation" &&
      q.trigger !== "worktree_cleanup" &&
      ((q.id === source && !sourceMergeConfirmation(card, q, events)) ||
        (q.id !== source &&
          !(q.merge_related === false && q.raised_by === "human") &&
          q.status !== "withdrawn" &&
          (q.card_id === card.id || q.affected_cards.includes(card.id)))),
  );
}

export function personallyResolved(q: Decision): boolean {
  return (
    q.status === "resolved" &&
    !q.superseded_by &&
    q.resolution?.resolved_by === "human" &&
    q.resolution.via === "needs_you" &&
    q.options.some((o) => o.key === q.resolution?.option)
  );
}

export function humanDecidedMergeQuestions(
  state: Pick<CommandState, "cards" | "decisions"> &
    Partial<Pick<CommandState, "events">>,
  cardId: CardId | undefined,
) {
  const card = state.cards.find((c) => c.id === cardId);
  return card
    ? mergeContentDecisions(state.decisions, card, state.events).filter(
        (q) => q.category === "scope_change" || q.category === "permission",
      )
    : [];
}

const decisionVersion = (q: Decision) =>
  JSON.stringify({
    category: q.category,
    resolution: q.resolution
      ? {
          option: q.resolution.option,
          at: q.resolution.at,
          resolved_by: q.resolution.resolved_by,
          via: q.resolution.via,
        }
      : null,
    option: q.options.find((o) => o.key === q.resolution?.option),
  });

function preferenceVersion(state: CommandState) {
  const keys = ["pm_merge_confirmation", "pm_confirm_human_decided_merges"];
  return JSON.stringify(
    keys.map(
      (key) =>
        state.events.findLast(
          (e) =>
            e.type === "project_preferences_updated" &&
            (e.payload as { preference?: string } | null)?.preference === key,
        )?.id ?? "default",
    ),
  );
}

/** Validate the full decision × current delivery mapping in the command transaction. */
export function buildHumanDecidedMergeBasis(
  state: CommandState,
  confirmation: Decision,
  entries: readonly MergeDecisionEvidence[] | undefined,
): HumanDecidedMergeBasis | undefined {
  const questions = humanDecidedMergeQuestions(state, confirmation.card_id);
  if (!questions.length) {
    ensure(
      !entries?.length,
      "validation_failed",
      "当前合并没有需要对应的范围或权限拍板",
    );
    return undefined;
  }
  const preference = state.project_preferences?.find(
    (p) => p.id === state.project_id,
  );
  ensure(
    pmConfirmHumanDecidedMerges(preference) && pmMergeConfirmation(preference),
    "unauthorized",
    "人已拍板的合并代确认授权已关闭",
  );
  ensure(
    questions.every(personallyResolved),
    "unauthorized",
    "范围或权限拍板须已由人亲自正式回答",
  );
  const completionId =
    confirmation.kind === "approve" && "delivery_id" in confirmation.target
      ? confirmation.target.delivery_id
      : undefined;
  const completion = state.deliveries.find(
    (v) =>
      v.id === completionId &&
      v.kind === "card_completion" &&
      v.status === "accepted" &&
      state.work_items.some(
        (w) => w.id === v.work_item_id && w.card_id === confirmation.card_id,
      ),
  );
  ensure(completion, "stale_target", "拍板对应依据须绑定当前完成申请");
  const deliveries = state.work_items
    .filter(
      (w) =>
        w.card_id === confirmation.card_id &&
        w.kind === "produce" &&
        w.status !== "cancelled",
    )
    .map(
      (w) =>
        state.deliveries
          .filter(
            (v) =>
              v.work_item_id === w.id &&
              v.kind !== "card_completion" &&
              v.status !== "superseded",
          )
          .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0],
    );
  ensure(
    deliveries.length > 0 &&
      deliveries.every(
        (v) =>
          v?.status === "accepted" &&
          v.subject.kind === "git_head" &&
          /^[0-9a-f]{40}$/i.test(v.subject.value),
      ),
    "stale_target",
    "拍板对应依据须覆盖每项当前已验收交付的完整提交号",
  );
  ensure(
    entries?.length === questions.length * deliveries.length,
    "validation_failed",
    "须逐条提供拍板编号、所选选项与每项当前交付行为或文件的对应依据",
  );
  const remaining = [...entries];
  const bound: HumanDecidedMergeBasis["entries"][number][] = [];
  for (const q of questions)
    for (const v of deliveries) {
      const index = remaining.findIndex(
        (e) => e.decision_id === q.id && e.delivery_id === v?.id,
      );
      const entry = remaining[index];
      ensure(
        entry &&
          entry.option === q.resolution?.option &&
          entry.completion_id === completion.id &&
          entry.target_sha === v?.subject.value &&
          typeof entry.evidence === "string" &&
          entry.evidence.trim().length > 0,
        "stale_target",
        "拍板对应依据缺失或与当前选项、完成申请、交付完整提交号不符",
      );
      remaining.splice(index, 1);
      bound.push({
        ...entry,
        evidence: entry.evidence.trim(),
        decision_version: decisionVersion(q),
      });
    }
  return { entries: bound, preference_version: preferenceVersion(state) };
}

/** Publication must never trust a previously stored PM explanation without rechecking it. */
export function humanDecidedMergeBasisValid(
  state: CommandState,
  q: Decision,
): boolean {
  const basis = q.resolution?.human_decided_merge_basis;
  if (!basis && !humanDecidedMergeQuestions(state, q.card_id).length)
    return true;
  if (
    !basis ||
    q.resolution?.via !== "delegated" ||
    !q.resolution.resolved_by.startsWith("assignment:")
  )
    return false;
  if (
    !state.assignments.some(
      (a) =>
        a.status === "active" &&
        a.scope === "standing" &&
        a.role_id === "pm" &&
        a.standing_mode === "ops" &&
        state.roles.some(
          (r) =>
            r.role_id === a.role_id &&
            r.role_version === a.role_version &&
            r.allowed_tools.includes("resolve_delegated_decision"),
        ),
    )
  )
    return false;
  try {
    const current = buildHumanDecidedMergeBasis(state, q, basis.entries);
    return JSON.stringify(current) === JSON.stringify(basis);
  } catch {
    return false;
  }
}
