import type { Event } from "./entities.js";
import { eventsOfType } from "./event-index.js";
import {
  type DelegationCategory,
  decisionDelegation,
  defaultDecisionDelegation,
  type ProjectPreferences,
} from "./preferences.js";

/** Default-human categories require the current same-project human opt-in audit. */
export function categoryAuthorization(
  events: readonly Event[],
  category: DelegationCategory,
) {
  return eventsOfType(events, "project_preferences_updated").findLast((e) => {
    const p = e.payload as {
      preference?: string;
      old_value?: Record<string, unknown>;
      new_value?: Record<string, unknown>;
    } | null;
    return (
      e.type === "project_preferences_updated" &&
      p?.preference === "decision_delegation" &&
      p.new_value?.[category] !== p.old_value?.[category]
    );
  });
}

export function categoryDelegated(
  preferences: ProjectPreferences | undefined,
  events: readonly Event[],
  category: DelegationCategory,
): boolean {
  if (!decisionDelegation(preferences)[category]) return false;
  if (defaultDecisionDelegation[category]) return true;
  const audit = categoryAuthorization(events, category);
  return (
    audit?.actor.kind === "human" &&
    audit.actor.project_id === preferences?.id &&
    (audit.payload as { new_value?: Record<string, unknown> }).new_value?.[
      category
    ] === true
  );
}
