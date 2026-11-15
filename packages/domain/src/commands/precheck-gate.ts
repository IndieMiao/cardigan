import { verificationPrecheckPending } from "../delivery-precheck.js";
import type { WorkItem } from "../entities.js";
import type { CommandDraft } from "./core.js";

/** Include uncommitted deliveries and evidence when applying transactional rules. */
export function draftVerificationPrecheckPending(
  d: CommandDraft,
  item: WorkItem,
): boolean {
  return verificationPrecheckPending(
    {
      ...d.state,
      cards: d.list("cards"),
      work_items: d.list("work_items"),
      deliveries: d.list("deliveries"),
      project_preferences: d.list("project_preferences"),
      events: [...d.state.events, ...d.events],
    },
    item,
  );
}
