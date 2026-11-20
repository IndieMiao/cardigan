import type { Event, Precheck, WorkItem } from "../entities.js";
import { authorPrecheckWaitHandled, isPrecheckConflict } from "../precheck.js";
import type { ResumeCondition } from "../work-wait.js";
import type { CommandDraft } from "./core.js";

/** A new check is progress, not another recovery of the same blocker (C-521). */
export function authorPrecheckWait(
  d: CommandDraft,
  item: WorkItem,
  condition: ResumeCondition | undefined,
  needs: "role" | "human",
) {
  if (
    condition?.kind !== "precheck_finished" ||
    needs !== "role" ||
    item.kind !== "produce" ||
    !item.assignment_id
  )
    return;
  const owned = (e: Event) => {
    const p = e.payload as Partial<Precheck> | null;
    return (
      e.actor.kind === "system" &&
      e.actor.project_id === d.state.project_id &&
      e.card_id === item.card_id &&
      p?.card_id === item.card_id &&
      p.work_item_id === item.id &&
      p.assignment_id === item.assignment_id
    );
  };
  const index = d.state.events.findLastIndex(
    (e) =>
      ["precheck_queued", "precheck_started", "precheck_finished"].includes(
        e.type,
      ) &&
      owned(e) &&
      (e.payload as unknown as Precheck).attempt_id === condition.target_id,
  );
  const event = d.state.events[index];
  if (!event) return;
  const check = event.payload as unknown as Precheck;
  if (
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(check.head_sha) ||
    isPrecheckConflict(check)
  )
    return;
  const consumed =
    event.type === "precheck_finished" &&
    authorPrecheckWaitHandled(d.state.events, event);
  function reachedFailureLimit(limit: number) {
    if (check.status !== "failed") return false;
    const failures = new Set<string>();
    for (let i = index; i >= 0; i--) {
      const e = d.state.events[i];
      if (e?.type !== "precheck_finished" || !owned(e)) continue;
      const prior = e.payload as unknown as Precheck;
      if (prior.status !== "failed" || prior.head_sha !== check.head_sha) break;
      failures.add(prior.attempt_id);
      if (failures.size >= limit) return true;
    }
    return false;
  }
  return { event, check, consumed, reachedFailureLimit };
}
