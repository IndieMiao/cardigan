import { autoRiskPathEvidence } from "./auto-risk.js";
import type { Card, Delivery, WorkItem } from "./entities.js";
import {
  highRiskPaths,
  mergePathMatches,
  type ProjectPreferences,
} from "./preferences.js";

type RiskState = {
  readonly project_id?: string;
  readonly project_preferences?: readonly ProjectPreferences[];
  readonly work_items: readonly WorkItem[];
  readonly deliveries: readonly Delivery[];
};

/** Evaluate actual current products, including deletions and both sides of renames. */
export function highRiskProducts(
  state: RiskState,
  card: Pick<Card, "id" | "high_risk">,
) {
  const patterns = highRiskPaths(
    state.project_preferences?.find((p) => p.id === state.project_id),
  );
  return state.work_items
    .filter(
      (w) =>
        w.card_id === card.id &&
        w.kind === "produce" &&
        w.status !== "cancelled",
    )
    .filter((w) => {
      if (card.high_risk) return true;
      const product = state.deliveries
        .filter(
          (v) =>
            v.work_item_id === w.id &&
            v.kind !== "card_completion" &&
            v.status !== "superseded",
        )
        .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
      return (
        product &&
        autoRiskPathEvidence(product)?.paths.some((path) =>
          patterns.some((pattern) => mergePathMatches(path, pattern)),
        )
      );
    });
}
