/**
 * Shapes of the two reference lists a {@link CardView} derives
 * (`waiting_on`, `next_owners`).
 *
 * They live in their own leaf module so `entities.ts` can type `CardView` with
 * them without a type-only import cycle (`card-derived.ts` imports the entity
 * types, and `entities.ts` imports these two interfaces). `card-derived.ts`
 * re-exports them, so callers can keep importing from there or from the package
 * entry point.
 */

export interface WaitingOnItem {
  readonly kind: "decision" | "human_action" | "review" | "blocked";
  /** The referenced entity: `Q-1`, `H-2`, `W-3`, `C-4#5`. */
  readonly ref: string;
  readonly review_phase?:
    | "待方案"
    | "待确认"
    | "待你结案恢复"
    | "待 PM 结案恢复"
    | "已允许返工但未派发";
  /** Short human label, e.g. `等你拍板 Q-1`. */
  readonly label: string;
}

export interface NextOwnerItem {
  readonly kind: "assignment" | "role" | "human" | "system";
  readonly ref: string;
}
