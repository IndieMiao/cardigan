import type { Assignment, Card, RoleReference, WorkItem } from "./entities.js";

/**
 * C-836: work-item/role combinations that can never run, known at assignment
 * time. `untargeted_verifier`: a verification item without a target producer
 * only runs when a completion request names it, and only a template completion
 * verifier can be named. `readonly_producer`: a readonly role's checkout needs
 * a verification target, so it cannot execute a producing item on a repo card.
 */
export type AssignmentMisfit = "untargeted_verifier" | "readonly_producer";

export const ASSIGNMENT_MISFIT_REASONS: Readonly<
  Record<AssignmentMisfit, string>
> = {
  untargeted_verifier:
    "验证项没有目标产出项，不会派发：请用 target_work_item_id 指向本卡要核对的产出项，产出交付后自动派发；没有产出可核对时，改建产出项并指派可写角色（如 coder）",
  readonly_producer:
    "只读角色不能执行产出项：请把产出项指派给可写角色（如 coder），或改建验证项并用 target_work_item_id 指向要核对的产出项",
};

/**
 * `completionVerifier` says whether a completion request may name the item.
 * Callers that cannot resolve the card template pass the conservative default:
 * only template items can ever be completion verifiers.
 */
export function workItemMisfit(
  item: Pick<WorkItem, "kind" | "template_key"> & {
    readonly target_work_item_id?: string;
  },
  role: Pick<RoleReference, "worktree"> | undefined,
  card: Pick<Card, "repo"> | undefined,
  completionVerifier = item.template_key !== undefined,
): AssignmentMisfit | undefined {
  if (
    item.kind === "verify" &&
    !item.target_work_item_id &&
    !completionVerifier
  )
    return "untargeted_verifier";
  if (item.kind === "produce" && role?.worktree === "readonly" && card?.repo)
    return "readonly_producer";
  return undefined;
}

/** The misfit of a persisted work-item Assignment under its own role version. */
export function assignmentMisfit(
  assignment: Assignment,
  state: {
    readonly work_items: readonly WorkItem[];
    readonly cards: readonly Card[];
    readonly roles: readonly RoleReference[];
  },
): AssignmentMisfit | undefined {
  if (assignment.scope !== "work_item") return undefined;
  const item = state.work_items.find((w) => w.id === assignment.work_item_id);
  if (!item) return undefined;
  const role = state.roles.find(
    (r) =>
      r.role_id === assignment.role_id &&
      r.role_version === assignment.role_version,
  );
  return workItemMisfit(
    item,
    role,
    state.cards.find((c) => c.id === item.card_id),
  );
}
