import { deriveReviewMatrix, reviewPassed } from "../derived.js";
import type { Decision, Delivery } from "../entities.js";
import { pmConfirmRoleRuleImplementations } from "../preferences.js";
import { type RoleRuleInventory, supportedRoleBodyEdit } from "../role-rule.js";
import type { CommandState } from "./core.js";

export type RoleRuleState = Partial<
  Pick<
    CommandState,
    | "project_id"
    | "project_preferences"
    | "work_items"
    | "deliveries"
    | "events"
    | "reviews"
  >
> &
  Pick<CommandState, "decisions">;
export function roleRuleDeliveries(
  state: RoleRuleState,
  q: Pick<Decision, "card_id">,
): readonly Delivery[] {
  return (state.work_items ?? [])
    .filter(
      (w) =>
        w.card_id === q.card_id &&
        w.kind === "produce" &&
        w.status !== "cancelled",
    )
    .flatMap((w) => {
      const v = (state.deliveries ?? [])
        .filter(
          (v) =>
            v.work_item_id === w.id &&
            v.kind !== "card_completion" &&
            v.status !== "superseded",
        )
        .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
      return v?.subject.kind === "git_head" ? [v] : [];
    });
}
/** A missing mapping cannot turn a known role change into an ordinary card. */
export function roleRuleMergeReason(
  state: RoleRuleState,
  q: Pick<Decision, "trigger" | "card_id" | "role_rule_basis"> & {
    readonly kind?: Decision["kind"];
    readonly target?:
      | { readonly delivery_id: import("../ids.js").DeliveryId }
      | { readonly subject: import("../entities.js").DeliverySubject };
  },
): string | undefined {
  if (q.trigger !== "merge_confirmation") return undefined;
  const deliveries = roleRuleDeliveries(state, q);
  const facts = deliveries.map((v) => ({
    v,
    inventory: roleRuleInventory(v),
  }));
  // Old deliveries carry no classification. They cannot establish the C-310 exception.
  // Existing non-role confirmations retain their historical routing; redelivery
  // through the real verifier always records either a full inventory or failure.
  if (q.role_rule_basis && !facts.length) return "缺少当前交付的主机角色清单。";
  if (!facts.some((x) => x.inventory || q.role_rule_basis)) return undefined;
  if (
    facts.some(
      (x) =>
        !x.inventory?.complete ||
        x.inventory.version !== 1 ||
        x.inventory.sha !== x.v.subject.value,
    )
  )
    return "主机角色差异清单缺失或不完整，须交人确认。";
  const inventories = facts.filter(
    (x): x is { v: Delivery; inventory: RoleRuleInventory } =>
      x.inventory !== undefined,
  );
  const changed = inventories.filter((x) =>
    x.inventory.changes.some((c) => c.category !== "ordinary"),
  );
  if (!changed.length)
    return q.role_rule_basis ? "当前清单没有可映射的角色正文。" : undefined;
  const pref = state.project_preferences?.find(
    (p) => p.id === state.project_id,
  );
  if (!pmConfirmRoleRuleImplementations(pref))
    return "角色规则改动按 Q-279 由人确认。";
  if (
    changed.some((x) =>
      x.inventory.changes.some(
        (c) =>
          !["ordinary", "body"].includes(c.category) ||
          (c.category === "body" &&
            (!c.edits.length ||
              c.edits.some(
                (e) => !supportedRoleBodyEdit(c.path, e.before, e.after),
              ))),
      ),
    )
  )
    return "角色改动含权限、审核等禁止类别或未知内容，须由人确认。";
  const verifiers = (state.work_items ?? []).filter(
    (w) =>
      w.card_id === q.card_id &&
      w.kind === "verify" &&
      w.role_id === "independent_reviewer" &&
      w.required &&
      w.status === "passed" &&
      !w.replaced_by_work_item_id,
  );
  const matrix = deriveReviewMatrix(deliveries, verifiers, state.reviews ?? []);
  if (
    !deliveries.every((v) =>
      matrix.some((r) => r.delivery_id === v.id && reviewPassed(r)),
    )
  )
    return "角色正文代确认须有覆盖当前交付的必需独立复核通过。";
  const basis = q.role_rule_basis;
  if (
    !basis ||
    q.kind !== "approve" ||
    !q.target ||
    !("delivery_id" in q.target) ||
    basis.completion_id !== q.target.delivery_id
  )
    return "角色正文改动缺少绑定当前完成申请的逐处人依据，须交人确认。";
  const completion = state.deliveries?.find(
    (v) =>
      v.id === basis.completion_id &&
      v.kind === "card_completion" &&
      v.status === "accepted",
  );
  if (
    completion?.subject.kind !== "git_head" ||
    !deliveries.some(
      (v) =>
        v.work_item_id === completion.work_item_id &&
        v.subject.value === completion.subject.value,
    )
  )
    return "角色依据的完成申请或完整提交已失效。";
  if (
    basis.inventories.length !== inventories.length ||
    inventories.some(
      ({ v, inventory: i }) =>
        basis.inventories.filter(
          (b) =>
            b.delivery_id === v.id &&
            b.sha === i.sha &&
            b.base_sha === i.base_sha &&
            b.tree_sha === i.tree_sha,
        ).length !== 1,
    )
  )
    return "角色依据的交付、基线或树已失效。";
  const edits = changed.flatMap(({ v, inventory: i }) =>
    i.changes
      .filter((c) => c.category === "body")
      .flatMap((c) =>
        c.edits.map((e) => ({ delivery_id: v.id, edit_id: e.id })),
      ),
  );
  if (
    !edits.length ||
    edits.length !== basis.mappings.length ||
    edits.some(
      (e) =>
        basis.mappings.filter(
          (m) => m.delivery_id === e.delivery_id && m.edit_id === e.edit_id,
        ).length !== 1,
    )
  )
    return "角色正文逐处对应缺项或重复，须交人确认。";
  for (const m of basis.mappings) {
    const source = state.decisions.find((d) => d.id === m.decision_id);
    const audit = state.events?.some(
      (e) =>
        e.type === "decision_resolved" &&
        e.actor.kind === "human" &&
        (e.payload as { decision_id?: string }).decision_id === source?.id &&
        (e.payload as { option?: string }).option ===
          source?.resolution?.option &&
        e.created_at === source?.resolution?.at &&
        (e.payload as { via?: string }).via === "needs_you" &&
        (e.payload as { rationale?: string }).rationale ===
          source?.resolution?.rationale,
    );
    if (
      m.category !== "body" ||
      !m.explanation.trim() ||
      !m.quote.trim() ||
      !source ||
      !humanRuleDecision(source) ||
      !audit ||
      !source.resolution?.raw_quote.includes(m.quote) ||
      !(
        source.card_id === q.card_id ||
        (!!q.card_id && source.affected_cards.includes(q.card_id))
      )
    )
      return "角色依据不是可核验的正式人答复，须交人确认。";
  }
  return undefined;
}

/** Unknown or incomplete trusted facts require consent even on auto templates. */
export function roleRuleConfirmationRequired(
  state: RoleRuleState,
  card_id: Decision["card_id"],
): boolean {
  if (!card_id) return false;
  return roleRuleDeliveries(state, { card_id }).some((v) => {
    const inventory = roleRuleInventory(v);
    return (
      inventory &&
      (!inventory.complete ||
        inventory.changes.some((c) => c.category !== "ordinary"))
    );
  });
}

/** Evidence is supplied only by the host's DeliveryVerifier, never submit_delivery input. */
export function roleRuleInventory(v: Delivery): RoleRuleInventory | undefined {
  const e = v.evidence.find(
    (e) =>
      e.kind === "diff" &&
      e.details &&
      typeof e.details === "object" &&
      !Array.isArray(e.details) &&
      "role_rule_inventory" in e.details,
  );
  return e
    ? (e.details as unknown as { role_rule_inventory: RoleRuleInventory })
        .role_rule_inventory
    : undefined;
}
export function humanRuleDecision(q: Decision): boolean {
  return (
    q.status === "resolved" &&
    q.trigger === undefined &&
    q.resolution?.resolved_by === "human" &&
    q.resolution.via === "needs_you" &&
    q.resolution.via_chain.length === 1 &&
    q.resolution.via_chain[0] === "human" &&
    q.options.some((o) => o.key === q.resolution?.option)
  );
}
