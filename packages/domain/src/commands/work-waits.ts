import type { Actor, Event, WorkItem } from "../entities.js";
import { hostOpsPending } from "../host-ops.js";
import { hasRunTarget } from "../run-target.js";
import type { ResumeCondition, RunWait } from "../work-wait.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { canResume, resumeWork } from "./resumption.js";
import { stoppedByHuman } from "./stop.js";

const payload = (e: Event) => e.payload as Record<string, unknown>;
const trusted = (d: CommandDraft) =>
  d.state.events.filter(
    (e) =>
      e.actor.kind === "system" && e.actor.project_id === d.state.project_id,
  );
const sameCondition = (a: unknown, b: RunWait["condition"]) => {
  const value = a as RunWait["condition"] | undefined;
  return value?.kind === b.kind && value.target_id === b.target_id;
};
const checkTypes = {
  precheck_finished: [
    "precheck_queued",
    "precheck_started",
    "precheck_finished",
  ],
  merge_check_finished: [
    "merge_check_queued",
    "merge_check_started",
    "merge_check_finished",
  ],
};
function targetEvent(d: CommandDraft, c: ResumeCondition): Event | undefined {
  const events = trusted(d);
  if (c.kind === "precheck_finished" || c.kind === "merge_check_finished")
    return events.findLast(
      (e) =>
        checkTypes[c.kind as keyof typeof checkTypes].includes(e.type) &&
        payload(e).attempt_id === c.target_id,
    );
  if (c.kind === "github_run_completed" && /^[1-9][0-9]*$/u.test(c.target_id))
    return events.findLast(
      (e) =>
        e.type === "github_check_dispatch" &&
        String(
          (payload(e).externalRun as { run_id?: number } | undefined)?.run_id,
        ) === c.target_id,
    );
  if (c.kind === "card_merged")
    return events.findLast(
      (e) => e.type === "card_merged" && e.card_id === c.target_id,
    );
  if (c.kind === "deployment_ready")
    return events.findLast((e) => e.type === "host_deployment_recorded");
  return undefined;
}

export function validateResumeCondition(
  d: CommandDraft,
  item: WorkItem,
  c: ResumeCondition,
) {
  ensure(
    c &&
      typeof c.target_id === "string" &&
      c.target_id.trim() === c.target_id &&
      c.target_id.length > 0 &&
      c.target_id.length <= 100,
    "validation_failed",
    "解除条件需要有效目标编号",
  );
  let valid = false;
  switch (c.kind) {
    case "precheck_finished":
    case "merge_check_finished":
    case "github_run_completed":
      valid = !!targetEvent(d, c);
      break;
    case "card_merged":
      valid =
        c.target_id !== item.card_id &&
        d
          .list("cards")
          .some(
            (card) =>
              card.id === c.target_id && card.project_id === d.state.project_id,
          );
      break;
    case "deployment_ready":
      valid = /^[a-f0-9]{40}$/u.test(c.target_id);
      break;
    case "decision_resolved":
      valid = d.list("decisions").some((q) => q.id === c.target_id);
      break;
  }
  ensure(
    valid,
    "validation_failed",
    "解除条件类型无效、目标不存在于本项目或形成自身等待",
  );
}

/** A repeated report after automatic recovery needs PM, including coalesced/recovered Run triggers. */
export function autoResumeUsed(
  d: CommandDraft,
  item: WorkItem,
  c?: RunWait["condition"],
) {
  const automatic = trusted(d).filter(
    (e) =>
      e.card_id === item.card_id &&
      e.type === "work_item_resume_requested" &&
      payload(e).automatic_wait === true &&
      payload(e).work_item_id === item.id,
  );
  if (c && automatic.some((e) => sameCondition(payload(e).condition, c)))
    return true;
  const latest = automatic.toSorted((a, b) => b.seq - a.seq)[0];
  if (!latest) return false;
  // A successful new delivery or explicit PM clearance starts a new episode,
  // but never restores the already-consumed allowance for the same condition.
  return !d.state.events.some(
    (e) =>
      e.card_id === item.card_id &&
      e.seq > latest.seq &&
      payload(e).work_item_id === item.id &&
      (e.type === "delivery_submitted" ||
        (e.type === "work_item_updated" &&
          e.actor.kind !== "system" &&
          payload(e).reported_blocker_cleared === true)),
  );
}

function satisfied(
  d: CommandDraft,
  c: RunWait["condition"],
  baseline?: { branch: string; sha: string },
  item?: WorkItem,
): string | undefined {
  if (c.kind === "baseline_updated") {
    return baseline &&
      item &&
      d.card(item.card_id).base_branch === baseline.branch &&
      /^[a-f0-9]{40}$/u.test(baseline.sha) &&
      baseline.sha !== c.target_id
      ? baseline.sha
      : undefined;
  }
  if (c.kind === "decision_resolved") {
    const q = d.list("decisions").find((q) => q.id === c.target_id);
    return q?.status === "resolved" ? q.id : undefined;
  }
  const event = targetEvent(d, c);
  if (!event) return;
  const p = payload(event);
  switch (c.kind) {
    case "precheck_finished":
    case "merge_check_finished":
      return event.type === c.kind &&
        [
          "passed",
          "failed",
          "timed_out",
          "interrupted",
          "executor_unreachable",
        ].includes(String(p.status))
        ? event.id
        : undefined;
    case "github_run_completed":
      // The host journal marks a bound external run finished only after observing its terminal state.
      return p.finished === true ? event.id : undefined;
    case "card_merged":
      return d
        .list("cards")
        .some((card) => card.id === c.target_id && card.status === "done")
        ? event.id
        : undefined;
    case "deployment_ready":
      return p.to === c.target_id && p.status === "deployed" && p.ready === true
        ? event.id
        : undefined;
  }
}

/** Internal maintenance only. Evidence, one-shot consumption and wake request commit atomically. */
export function resumeWorkWaits(
  state: CommandState,
  actor: Actor,
  p: { baseline?: { branch: string; sha: string } },
  ports: CommandPorts,
) {
  return command(state, actor, "resume_work_waits", ports, (d) => {
    const resumed: string[] = [];
    const waitingOwners = new Set(
      d
        .list("runs")
        .filter((r) => r.wait_for && !r.wait_for.resumed_by)
        .map((r) => r.assignment_id),
    );
    for (const item of d.list("work_items")) {
      if (
        !item.reported_blocker?.resume_when &&
        (!item.assignment_id || !waitingOwners.has(item.assignment_id))
      )
        continue;
      const card = d.card(item.card_id);
      const owner = d
        .list("assignments")
        .find((a) => a.id === item.assignment_id);
      if (
        card.hold ||
        ["backlog", "done", "cancelled", "awaiting_merge"].includes(
          card.status,
        ) ||
        item.manual_assign ||
        item.replaced_by_work_item_id ||
        !owner ||
        owner.status !== "active" ||
        owner.scope !== "work_item" ||
        owner.work_item_id !== item.id ||
        owner.external ||
        owner.role_upgrade ||
        stoppedByHuman(state.events, owner.id) ||
        hostOpsPending(state.events, owner.id) ||
        !["in_progress", "blocked", "waiting_decision"].includes(item.status) ||
        !hasRunTarget(owner, state)
      )
        continue;
      const runs = d.list("runs").filter((r) => r.assignment_id === owner.id);
      if (
        runs.some(
          (r) =>
            !["completed", "failed", "cancelled"].includes(r.status) ||
            r.dispatch_stop ||
            r.inactivity_stop,
        )
      )
        continue;
      const last = runs.toSorted(
        (a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)),
      )[0];
      const blocker = item.reported_blocker;
      const wait = last?.status === "completed" ? last.wait_for : undefined;
      const condition = blocker
        ? blocker.resume_when
        : wait?.resumed_by
          ? undefined
          : wait?.condition;
      if (
        !condition ||
        blocker?.auto_resume_disabled ||
        autoResumeUsed(d, item, condition)
      )
        continue;
      const evidence = satisfied(d, condition, p.baseline, item);
      if (!evidence) continue;
      const { reported_blocker: _blocker, ...cleared } = item;
      if (!canResume(d, cleared)) continue;
      // Keep the reported blocker until ALL blockers are clear; no premature delivery or wake.
      if (blocker) d.put("work_items", cleared);
      const next = resumeWork(d, cleared) ?? cleared;
      if (!["in_progress", "ready"].includes(next.status)) continue;
      const body = `${item.id} 等待条件已满足：${condition.kind} ${condition.target_id}；系统恢复并请求继续执行。`;
      const event = d.emit(
        "work_item_resume_requested",
        item.card_id,
        {
          work_item_id: item.id,
          assignment_id: owner.id,
          role_version: owner.role_version,
          automatic_wait: true,
          condition: { ...condition },
          evidence,
          previous_run_id: last?.id ?? null,
          reported_blocker_cleared: !!blocker,
          body,
        },
        { type: "system", body, work_item_id: item.id },
      );
      if (last && wait)
        d.put("runs", { ...last, wait_for: { ...wait, resumed_by: event.id } });
      resumed.push(item.id);
    }
    if (resumed.length)
      d.emit("work_waits_resumed", undefined, {
        work_item_ids: resumed,
        body: `系统已自动恢复 ${resumed.length} 个等待工作项：${resumed.join("、")}。解除条件及证据见各卡时间线。`,
      });
    return resumed;
  });
}
