import type { Event, WorkItem } from "../entities.js";
import { type CommandDraft, ensure } from "./core.js";

export function canResume(d: CommandDraft, item: WorkItem): boolean {
  return !(
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
    (item.kind === "verify" &&
      d.list("reviews").filter((r) => r.work_item_id === item.id).length >=
        item.max_review_rounds)
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
    runs.some((r) => !["completed", "failed", "cancelled"].includes(r.status))
  )
    return;
  const previous = runs
    .filter((r) => r.outcome === "blocked")
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
    trigger_event_id: event.id,
    kind: item.status === "waiting_decision" ? "decision_resumed" : "followup",
    status: "queued",
    role_version: previous.role_version,
    model: previous.model,
    agent_cli_version: previous.agent_cli_version,
    outcome: null,
    summary: "",
  });
}
