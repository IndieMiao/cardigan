import type {
  Actor,
  Decision,
  Event,
  PreMergeCheckedVersion,
} from "../entities.js";
import type { CardId, DecisionId, DeliveryId } from "../ids.js";
import {
  highRiskCategories,
  pmMergeConfirmation,
  validMergePath,
  validMergePathList,
} from "../preferences.js";
import {
  attempt,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import {
  mergeNeedsHuman,
  mergeUnrelatedConfirmed,
  riskTagAutoMergeAllowed,
} from "./delegation.js";
import { mergeBlockingHumanActions, mergeContext } from "./merge.js";
import { latestMergeCheck } from "./merge-check.js";
import {
  mergeClassificationView,
  sameMergeVersions,
} from "./merge-classification.js";
import { latestReviews, pmMergeBlockers } from "./merge-delegation.js";
import { hasVerifiedMergeNoop } from "./merge-preparation.js";
import {
  currentPreMergeVersions,
  openPreMergeChecks,
} from "./pre-merge-checks.js";
import { projectPreferences } from "./preferences.js";
import {
  SCREENSHOT_CHECK_LABEL,
  screenshotCheckBlocker,
  screenshotCheckEnforced,
} from "./screenshot-check.js";

/** Trusted host evidence only; commit and delivery bindings are rechecked in the write transaction. */
export interface MergeShadowPaths {
  readonly completion_id: DeliveryId;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly versions: readonly (PreMergeCheckedVersion & {
    readonly paths: readonly string[];
  })[];
}
export interface MergeShadowCondition {
  readonly number: number;
  readonly status: "passed" | "failed" | "uncertain";
  readonly reason: string;
}
const payload = (e: Event) => e.payload as Record<string, unknown>;
const fullSha = (value: string) =>
  /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
function pathCondition(
  number: number,
  declared: boolean | undefined,
  patterns: unknown,
  paths: readonly string[] | undefined,
): MergeShadowCondition {
  if (declared !== true)
    return { number, status: "failed", reason: "分类确认未明确排除此类改动" };
  if (
    !validMergePathList(patterns) ||
    !patterns.length ||
    !paths?.every(validMergePath)
  )
    return {
      number,
      status: "uncertain",
      reason: "路径清单未配置、为空、非法或缺少当前版本的改动文件证据",
    };
  const matches = paths.filter((path) =>
    patterns.some((pattern) =>
      pattern.endsWith("/**")
        ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2))
        : path === pattern,
    ),
  );
  return {
    number,
    status: matches.length ? "failed" : "passed",
    reason: matches.length
      ? `命中路径：${matches.join("、")}`
      : "分类确认和改动路径均通过",
  };
}

/** ADR 0008 / Q-391/392/397. This evaluator cannot return a merge mutation. */
export function evaluateMergeShadow(
  state: CommandState,
  q: Decision,
  evidence?: MergeShadowPaths,
) {
  const card = state.cards.find((c) => c.id === q.card_id);
  ensure(card, "not_found", "Card not found");
  const classification = mergeClassificationView(state, card);
  const versions = currentPreMergeVersions(
    card,
    state.work_items,
    state.deliveries,
  );
  const context = attempt(() => mergeContext(state, card.id));
  const current =
    context.ok &&
    q.kind === "approve" &&
    "delivery_id" in q.target &&
    context.value.target.id === q.target.delivery_id;
  const paths =
    evidence &&
    current &&
    evidence.completion_id === context.value.target.id &&
    evidence.base_branch === card.base_branch &&
    fullSha(evidence.base_sha) &&
    sameMergeVersions(evidence.versions, versions) &&
    evidence.versions.every((v) => fullSha(v.subject))
      ? evidence.versions.flatMap((v) => v.paths)
      : undefined;
  const preferences = projectPreferences(state);
  const conditions: MergeShadowCondition[] = [];
  const check = (number: number, passed: boolean, reason: string) =>
    conditions.push({
      number,
      status: passed ? "passed" : "failed",
      reason: passed ? "满足" : reason,
    });
  const related = state.decisions.filter(
    (other) =>
      other.trigger !== "merge_confirmation" &&
      other.trigger !== "worktree_cleanup" &&
      ((card.source.kind === "decision" &&
        card.source.decision_id === other.id) ||
        (!mergeUnrelatedConfirmed(other) &&
          other.status !== "withdrawn" &&
          (other.card_id === card.id ||
            other.affected_cards.includes(card.id)))),
  );
  check(1, !card.sensitive, "敏感卡须由人确认");
  check(
    2,
    !related.some(
      (other) => other.category && highRiskCategories.includes(other.category),
    ),
    "卡片或来源涉及花钱、账号、权限或删除数据",
  );
  check(
    3,
    !related.some((other) => other.category === "scope_change"),
    "卡片或来源涉及需求范围变化",
  );
  const activeOps = state.assignments.some(
    (a) =>
      a.status === "active" &&
      a.scope === "standing" &&
      a.standing_mode === "ops" &&
      a.role_id === "pm" &&
      state.roles.some(
        (r) =>
          r.role_id === a.role_id &&
          r.role_version === a.role_version &&
          r.allowed_tools.includes("resolve_delegated_decision"),
      ),
  );
  check(
    4,
    q.trigger === "merge_confirmation" &&
      q.status === "open" &&
      !q.resolution &&
      q.decider === "role:pm" &&
      !q.human_required_reason &&
      pmMergeConfirmation(preferences) &&
      activeOps &&
      !mergeNeedsHuman(state.decisions, state.cards, card.id),
    "须为仍委托给活跃 PM Ops 的未处理确认，且偏好允许",
  );
  conditions.push(
    pathCondition(
      5,
      classification?.no_role_changes,
      preferences.system_merge_shadow_policy?.role_rule_paths,
      paths,
    ),
  );
  conditions.push(
    pathCondition(
      6,
      classification?.not_external_release,
      preferences.system_merge_shadow_policy?.release_paths,
      paths,
    ),
  );
  check(
    7,
    !!current &&
      (latestMergeCheck(state.events, card.id, context.value.target.id)
        ?.status === "passed" ||
        hasVerifiedMergeNoop(state.events, card.id, context.value.target.id)),
    "当前完成申请检查未通过、未经主机验证无操作或确认版本过期",
  );
  const items = state.work_items.filter(
    (w) => w.card_id === card.id && w.status !== "cancelled",
  );
  const deliveries = versions.flatMap((v) =>
    state.deliveries.filter((d) => d.id === v.delivery_id),
  );
  check(
    8,
    items
      .filter((w) => w.kind === "verify")
      .every((w) => w.status === "passed") &&
      items
        .filter((w) => w.kind === "produce" && w.required)
        .every((w) =>
          deliveries.some(
            (v) => v.work_item_id === w.id && v.status === "accepted",
          ),
        ),
    "验证项未全部通过或必需产出未接受",
  );
  check(
    9,
    [...deliveries, ...(context.ok ? [context.value.target] : [])].every((v) =>
      [...latestReviews(state, v).values()].every(
        (r) => !r.issues.some((i) => i.must_fix && !i.pre_existing),
      ),
    ),
    "当前产出或完成申请存在未处理 must_fix",
  );
  check(
    10,
    openPreMergeChecks(
      card,
      state.work_items,
      state.deliveries,
      screenshotCheckEnforced(state),
    ).length === 0,
    "合并前核对项未全部对当前版本通过",
  );
  check(
    11,
    !card.risk_tags?.includes("numeric_rule") &&
      (!card.risk_tags?.length || riskTagAutoMergeAllowed(state, q)),
    "数值规则卡一律留给 PM；其他风险卡须有当前版本有效的必需独立复核",
  );
  // A persisted screenshot check also identifies a UI card; classification cannot erase it.
  const isUi =
    classification?.is_ui === true ||
    card.pre_merge_checks?.some((c) => c.label === SCREENSHOT_CHECK_LABEL) ===
      true;
  check(
    12,
    !isUi ||
      (screenshotCheckEnforced(state) &&
        card.pre_merge_checks?.some(
          (c) => c.label === SCREENSHOT_CHECK_LABEL,
        ) === true &&
        !screenshotCheckBlocker(state, card)),
    "界面卡须开启截图核对计入代确认，且当前截图审核已通过",
  );
  check(
    13,
    !items.some(
      (w) =>
        w.reported_blocker ||
        ["blocked", "waiting_decision"].includes(w.status),
    ) &&
      mergeBlockingHumanActions(state, card.id).length === 0 &&
      !state.decisions.some(
        (other) =>
          other.id !== q.id &&
          ["open", "provisional", "snoozed"].includes(other.status) &&
          (other.card_id === card.id ||
            other.affected_cards.includes(card.id) ||
            other.affected_work_items.some((id) =>
              items.some((w) => w.id === id),
            )),
      ),
    "仍有工作项阻塞、挡合并的人工操作或其它未决拍板",
  );
  const comments = state.timeline.filter(
    (e) =>
      e.card_id === card.id && e.type === "comment" && e.author !== "system",
  );
  check(
    14,
    !!classification &&
      comments.every(
        (e) =>
          e.event_seq <= classification.read_through_seq &&
          e.event_seq < classification.event_seq,
      ),
    "分类确认未覆盖全部评论，或确认后又出现人或 Agent 评论",
  );
  // Expiry clears snooze and reopens the decision, but never erases a hold
  // for this completion. Include holds on superseded confirmation IDs too.
  const held = state.events.some(
    (e) =>
      e.card_id === card.id &&
      [
        "decision_resolved",
        "decision_provisionally_resolved",
        "merge_changes_requested",
        "merge_confirmation_snoozed",
      ].includes(e.type) &&
      (e.type === "merge_confirmation_snoozed" ||
        ["hold", "request_changes"].includes(
          String(
            payload(e).option ??
              (e.type === "merge_changes_requested" ? "request_changes" : ""),
          ),
        )) &&
      state.decisions.some(
        (other) =>
          other.id === payload(e).decision_id &&
          other.trigger === "merge_confirmation" &&
          other.kind === "approve" &&
          "delivery_id" in other.target &&
          q.kind === "approve" &&
          "delivery_id" in q.target &&
          other.target.delivery_id === q.target.delivery_id,
      ),
  );
  check(
    15,
    (card.merge_policy ?? "confirm") === "confirm" &&
      q.status !== "snoozed" &&
      !held &&
      !q.resolution,
    "合并策略不是确认，或本完成申请曾被暂缓、hold、退回或处理",
  );
  const audit = state.events.find(
    (e) =>
      e.card_id === card.id &&
      e.type === "merge_classification_recorded" &&
      e.seq === classification?.event_seq,
  );
  const producers = items.filter((w) => w.kind === "produce");
  check(
    16,
    !!classification &&
      !classification.stale &&
      !!audit &&
      producers.length > 0 &&
      producers.every((w) => versions.some((v) => v.work_item_id === w.id)) &&
      classification.risk_reviewed === true &&
      typeof classification.is_ui === "boolean" &&
      classification.numeric_rules_approved === true &&
      classification.not_external_release === true &&
      classification.no_role_changes === true &&
      classification.timeline_reviewed === true,
    "缺少有效分类确认、版本或风险标签已变，或必填结论不成立",
  );
  // Keep the existing PM gate as an additional safety net, never relax it. Noop is
  // the ADR's explicit host-verified exception to the check-result requirement.
  const pmBlockers = pmMergeBlockers(state, q).filter(
    (reason) =>
      !(
        current &&
        hasVerifiedMergeNoop(state.events, card.id, context.value.target.id) &&
        reason.startsWith("合并闸门检查")
      ),
  );
  return {
    rule: "C-225/merge-shadow",
    decision_id: q.id,
    completion_id:
      q.kind === "approve" && "delivery_id" in q.target
        ? q.target.delivery_id
        : null,
    classification_seq: classification?.event_seq ?? null,
    checked_versions: versions,
    base_sha: paths ? (evidence?.base_sha ?? null) : null,
    review_ids: [...deliveries, ...(context.ok ? [context.value.target] : [])]
      .flatMap((v) => [...latestReviews(state, v).values()].map((r) => r.id))
      .sort(),
    conditions,
    pm_blockers: pmBlockers,
    would_confirm:
      conditions.every((c) => c.status === "passed") && pmBlockers.length === 0,
  };
}

/** Only append audit records. No schedule, confirmation, merge or status mutation. */
export function recordMergeShadow(
  state: CommandState,
  actor: Actor,
  p: { decision_id: DecisionId; paths?: MergeShadowPaths },
  ports: CommandPorts,
) {
  return command(state, actor, "record_merge_shadow", ports, (d) => {
    if (projectPreferences(state).system_merge_shadow !== true) return null;
    const q = d.get("decisions", p.decision_id);
    ensure(
      q.trigger === "merge_confirmation" && q.card_id,
      "validation_failed",
      "不是合并确认",
    );
    const result = evaluateMergeShadow(state, q, p.paths);
    const previous = state.events
      .filter(
        (e) =>
          e.type === "system_merge_shadow_recorded" &&
          e.card_id === q.card_id &&
          payload(e).decision_id === q.id,
      )
      .at(-1);
    if (previous && JSON.stringify(previous.payload) === JSON.stringify(result))
      return result;
    d.emit(
      "system_merge_shadow_recorded",
      q.card_id,
      JSON.parse(JSON.stringify(result)),
      {
        type: "system",
        decision_id: q.id,
        body: `合并影子记录：如果开启，${result.would_confirm ? "会代确认" : "不会代确认"}。${result.conditions
          .filter((c) => c.status !== "passed")
          .map(
            (c) =>
              `条件 ${c.number}${c.status === "uncertain" ? " 不确定" : " 不满足"}：${c.reason}`,
          )
          .join("；")} 仅记录，不执行合并。`,
      },
    );
    return result;
  });
}

/** Join immutable predictions with the real decision, including holds/handoffs. */
export function mergeShadowComparisons(
  state: Pick<CommandState, "events" | "decisions">,
  card: CardId,
) {
  return state.events
    .filter(
      (e) => e.card_id === card && e.type === "system_merge_shadow_recorded",
    )
    .map((e) => {
      const q = state.decisions.find((q) => q.id === payload(e).decision_id);
      return {
        event_id: e.id,
        at: e.created_at,
        prediction: e.payload,
        actual: q
          ? {
              decision_id: q.id,
              status: q.status,
              decider: q.decider,
              resolution: q.resolution ?? null,
            }
          : null,
        actual_events: state.events
          .filter(
            (actual) =>
              actual.card_id === card &&
              [
                "decision_resolved",
                "decision_provisionally_resolved",
                "decision_requested",
                "merge_confirmation_snoozed",
                "decision_superseded",
                // A confirmed merge keeps its original resolution when returned.
                "merge_changes_requested",
              ].includes(actual.type) &&
              payload(actual).decision_id === q?.id,
          )
          .sort((a, b) => a.seq - b.seq)
          .map((actual) => ({
            event_id: actual.id,
            seq: actual.seq,
            at: actual.created_at,
            type: actual.type,
            author:
              actual.actor.kind === "assignment"
                ? (`assignment:${actual.actor.assignment_id}` as const)
                : actual.actor.kind,
            payload: actual.payload,
          })),
        evaluated_seq: e.seq,
      };
    });
}
