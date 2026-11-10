import type { Event, WorkItem } from "../entities.js";
import { type CommandDraft, ensure } from "./core.js";
import { reviewRound } from "./workflow.js";

export function canResume(d: CommandDraft, item: WorkItem): boolean {
  return !(
    item.reported_blocker ||
    d
      .list("decisions")
      .some(
        (q) =>
          q.blocking &&
          ["open", "provisional"].includes(q.status) &&
          q.affected_work_items.includes(item.id),
      ) ||
    d
      .list("human_actions")
      .some(
        (h) => h.status === "open" && h.blocked_work_items.includes(item.id),
      ) ||
    (item.kind === "verify" && reviewRound(d, item) > item.max_review_rounds)
  );
}

export function resumeWork(
  d: CommandDraft,
  item: WorkItem,
): WorkItem | undefined {
  if (
    !["blocked", "waiting_decision"].includes(item.status) ||
    !canResume(d, item)
  )
    return undefined;
  const resumed = d.move(
    item,
    item.status === "blocked" ? "resume" : "decision_resolved",
  );
  d.put("work_items", resumed);
  return resumed;
}

export function queueResumedRun(d: CommandDraft, item: WorkItem, event: Event) {
  if (!item.assignment_id) return;
  const assignment = d.get("assignments", item.assignment_id);
  const runs = d.list("runs").filter((r) => r.assignment_id === assignment.id);
  if (
    assignment.status !== "active" ||
    runs.some(
      (r) =>
        r.inactivity_stop ||
        !["completed", "failed", "cancelled"].includes(r.status),
    )
  )
    return;
  // A new delivery can hit the limit after the previous review Run already completed.
  const reviewLimit =
    item.status === "waiting_decision" &&
    d
      .list("decisions")
      .some(
        (q) =>
          q.trigger === "review_limit" &&
          q.status === "resolved" &&
          q.affected_work_items.includes(item.id),
      );
  const previous = runs
    .filter(
      (r) =>
        r.outcome === "blocked" ||
        (reviewLimit &&
          r.status === "completed" &&
          d.list("reviews").some((review) => review.run_id === r.id)),
    )
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  if (!previous) return;
  ensure(
    previous.role_version === assignment.role_version &&
      previous.model.trim() &&
      previous.agent_cli_version.trim(),
    "invariant_violation",
    "Resume requires the previous role/model/CLI snapshot",
  );
  d.put("runs", {
    id: d.ids.next(d.state.project_id, "run"),
    assignment_id: assignment.id,
    ...(assignment.employee_id ? { employee_id: assignment.employee_id } : {}),
    trigger_event_id: event.id,
    kind: item.status === "waiting_decision" ? "decision_resumed" : "followup",
    status: "queued",
    role_version: previous.role_version,
    ...(previous.launch_profile_ref && !assignment.employee_id
      ? { launch_profile_ref: previous.launch_profile_ref }
      : {}),
    model: previous.model,
    agent_cli_version: previous.agent_cli_version,
    outcome: null,
    summary: "",
  });
}
