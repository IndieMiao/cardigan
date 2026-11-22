import type { Assignment, Event, Run, WorkItem } from "../entities.js";
import { isMergePrerequisite } from "../human-action.js";
import { hasRunTarget } from "../run-target.js";
import { type CommandDraft, ensure } from "./core.js";
import { createQueuedRun, launchSettings } from "./launch.js";
import { closedResumeTarget, deferResume } from "./resume-attention.js";
import { stoppedByHuman } from "./stop.js";
import { reviewRound } from "./workflow.js";

function upgradedSinceRun(
  d: CommandDraft,
  item: WorkItem,
  assignment: Assignment,
  previous: Run,
): boolean {
  if (
    assignment.scope !== "work_item" ||
    assignment.work_item_id !== item.id ||
    assignment.role_id !== item.role_id ||
    assignment.external ||
    assignment.role_upgrade ||
    previous.role_version >= assignment.role_version
  )
    return false;
  // Require a complete system-audited chain, including multiple idle upgrades
  // while the work item stayed blocked. An arbitrary version edit is not proof.
  const versions = new Set([previous.role_version]);
  const upgrades = d.state.events
    .filter(
      (e) =>
        e.type === "session_replaced" &&
        e.actor.kind === "system" &&
        e.actor.project_id === d.state.project_id &&
        e.card_id === item.card_id &&
        e.payload !== null &&
        typeof e.payload === "object" &&
        !Array.isArray(e.payload),
    )
    .map((e) => e.payload as Record<string, unknown>)
    .filter(
      (p) =>
        p.assignment_id === assignment.id &&
        p.reason === "default_role_upgraded" &&
        typeof p.from_version === "number" &&
        typeof p.to_version === "number" &&
        Number.isSafeInteger(p.from_version) &&
        Number.isSafeInteger(p.to_version) &&
        p.from_version < p.to_version,
    )
    .sort((a, b) => (a.from_version as number) - (b.from_version as number));
  for (const p of upgrades)
    if (versions.has(p.from_version as number))
      versions.add(p.to_version as number);
  return versions.has(assignment.role_version);
}

export function resumeBlockReason(
  d: CommandDraft,
  item: WorkItem,
): string | undefined {
  if (item.reported_blocker) return "上报的阻塞尚未解除";
  const decision = d
    .list("decisions")
    .find(
      (q) =>
        q.blocking &&
        ["open", "provisional", "snoozed"].includes(q.status) &&
        q.affected_work_items.includes(item.id),
    );
  if (decision) return `拍板 ${decision.id} 尚未解决`;
  const action = d
    .list("human_actions")
    .find(
      (h) =>
        h.status === "open" &&
        isMergePrerequisite(h) &&
        h.blocked_work_items.includes(item.id),
    );
  if (action) return `合并前置操作 ${action.id} 尚未完成`;
  if (item.kind === "verify" && reviewRound(d, item) > item.max_review_rounds)
    return "审核轮数已达上限";
}

export function canResume(d: CommandDraft, item: WorkItem): boolean {
  return !resumeBlockReason(d, item);
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
  const deferred = (reason: string) => deferResume(d, item, reason, event.id);
  const card = d.card(item.card_id);
  if (closedResumeTarget(item, card.status)) return;
  if (card.hold) return deferred("卡片已暂停");
  if (!item.assignment_id) return deferred("没有负责人");
  const assignment = d.get("assignments", item.assignment_id);
  if (stoppedByHuman(d.state.events, assignment.id))
    return deferred("指派已被人工停止");
  if (
    !hasRunTarget(assignment, {
      work_items: d.list("work_items"),
      deliveries: d.list("deliveries"),
    })
  )
    return deferred("没有可执行的审核目标");
  const runs = d.list("runs").filter((r) => r.assignment_id === assignment.id);
  if (assignment.status !== "active") return deferred("指派未激活");
  if (runs.some((r) => r.inactivity_stop || r.dispatch_stop))
    return deferred("Run 正在停止");
  if (
    runs.some((r) => !["completed", "failed", "cancelled"].includes(r.status))
  )
    return deferred("已有未结束的 Run");
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
  if (!previous) return deferred("没有可沿用的阻塞 Run");
  // A retired role's model/CLI/profile cannot describe the next session. Keep
  // the durable resume event and let Dispatcher resolve the current trusted
  // launch configuration before queuing a Run. No historical Run is rewritten.
  if (upgradedSinceRun(d, item, assignment, previous)) {
    // Every entry point needs a durable request independent of its cause's
    // notification/readiness policy. Router coalesces the cause for this owner.
    d.emit("work_item_resume_requested", item.card_id, {
      work_item_id: item.id,
      assignment_id: assignment.id,
      role_version: assignment.role_version,
      previous_run_id: previous.id,
      trigger_event_id: event.id,
      kind:
        item.status === "waiting_decision" ? "decision_resumed" : "followup",
    });
    return;
  }
  ensure(
    previous.role_version === assignment.role_version &&
      previous.model.trim() &&
      previous.agent_cli_version.trim(),
    "invariant_violation",
    "Resume requires the previous role/model/CLI snapshot",
  );
  createQueuedRun(d, assignment, {
    trigger_event_id: event.id,
    kind: item.status === "waiting_decision" ? "decision_resumed" : "followup",
    queue_reason: "awaiting_dispatch",
    ...(previous.launch_profile_ref && !assignment.employee_id
      ? { launch_profile_ref: previous.launch_profile_ref }
      : {}),
    model: previous.model,
    ...launchSettings(previous),
    agent_cli_version: previous.agent_cli_version,
  });
}
