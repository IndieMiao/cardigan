import type { Card } from "./entities.js";
import type { ProjectPreferences } from "./preferences.js";

/** Raise only after every task for the next flow level has shipped. */
export const FLOW_VERSION_MAX = 2;

export function cardFlowVersion(card: Pick<Card, "flow_version">): number {
  return card.flow_version ?? 1;
}

export function projectFlowVersion(preferences?: ProjectPreferences): number {
  return preferences?.flow_version ?? 1;
}

export function flowAtLeast(
  card: Pick<Card, "flow_version">,
  n: number,
): boolean {
  return cardFlowVersion(card) >= n;
}

export function validFlowVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= FLOW_VERSION_MAX
  );
}
