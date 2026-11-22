import type { Actor, Assignment, Event, WorkItem } from "../entities.js";
import { hostOpsPending } from "../host-ops.js";
import {
  latestPrecheckConflict,
  pendingPrecheckConflict,
} from "../precheck.js";
import { hasRunTarget } from "../run-target.js";
import type { ResumeCondition, RunWait } from "../work-wait.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { authorPrecheckWait } from "./precheck-wait.js";
import { deferResume } from "./resume-attention.js";
import { resumeBlockReason, resumeWork } from "./resumption.js";
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

export const DEFAULT_CONFLICT_MAX_RESUMES = 3;

export function pendingBaselineConflict(d: CommandDraft, item: WorkItem) {
  return pendingPrecheckConflict(d.state.events, item, d.state.project_id);
}

/** Legacy free-text reports also require a matching trusted precheck conflict. */
export const baselineBlockerReason = (reason: string) =>
  /Precheck merge conflict|预检.*(?:候选|合并).*冲突|(?:同步|更新|获取|拿到|等待|需要).*(?:基线|main)|(?:基线|main).*(?:前进|更新|同步)/iu.test(
    reason,
  );
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
    return events.findLast(
      (e) =>
        e.type === "host_deployment_recorded" && payload(e).to === c.target_id,
    );
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
    case "baseline_updated":
      valid =
        item.kind === "produce" &&
        /^[a-f0-9]{40}$/u.test(c.target_id) &&
        d
          .list("assignments")
          .some(
            (a) => a.id === item.assignment_id && a.base_sha === c.target_id,
          );
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
      ((e.type === "delivery_submitted" &&
        d
          .list("deliveries")
          .some(
            (delivery) =>
              delivery.id === payload(e).delivery_id &&
              delivery.work_item_id === item.id,
          )) ||
        (e.type === "work_item_updated" &&
          payload(e).work_item_id === item.id &&
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

function waitOwnerGuard(d: CommandDraft, item: WorkItem, owner: Assignment) {
  const card = d.card(item.card_id);
  if (card.hold) return "卡片已暂停";
  if (["backlog", "done", "cancelled", "awaiting_merge"].includes(card.status))
    return `卡片状态为 ${card.status}`;
  if (item.replaced_by_work_item_id)
    return `工作项已被 ${item.replaced_by_work_item_id} 替换`;
  if (owner.status !== "active") return "指派未激活";
  if (owner.scope !== "work_item" || owner.work_item_id !== item.id)
    return "指派与工作项不匹配";
  if (owner.external) return "外接指派不自动启动 Run";
  if (owner.role_upgrade) return "角色升级尚未完成";
  if (stoppedByHuman(d.state.events, owner.id)) return "指派已被人工停止";
  if (hostOpsPending(d.state.events, owner.id)) return "主机操作尚未完成";
  if (!["in_progress", "blocked", "waiting_decision"].includes(item.status))
    return `工作项状态为 ${item.status}`;
  if (!hasRunTarget(owner, d.state)) return "没有可执行的审核目标";
}

/** Settle only this author's passed wait inside the verified delivery transaction. */
export function resumePassedDeliveryWait(
  d: CommandDraft,
  item: WorkItem,
  head: string,
) {
  const blocker = item.reported_blocker;
  if (
    item.status !== "blocked" ||
    !blocker ||
    blocker.reported_by !== d.author ||
    !d.assignment ||
    waitOwnerGuard(d, item, d.assignment)
  )
    return;
  const wait = authorPrecheckWait(d, item, blocker.resume_when, blocker.needs);
  if (
    wait?.event.type !== "precheck_finished" ||
    wait.consumed ||
    wait.check.status !== "passed" ||
    wait.check.head_sha !== head
  )
    return;
  if (
    d
      .list("runs")
      .some(
        (r) =>
          r.assignment_id === item.assignment_id &&
          (r.dispatch_stop || r.inactivity_stop),
      )
  )
    return;
  const { reported_blocker: _blocker, ...cleared } = item;
  const resumed = resumeWork(d, cleared);
  if (!resumed) return;
  d.emit(
    "precheck_wait_delivered",
    item.card_id,
    {
      work_item_id: item.id,
      attempt_id: wait.check.attempt_id,
      evidence: wait.event.id,
    },
    {
      type: "status_change",
      work_item_id: item.id,
      body: `${item.id} 等待的预检 ${wait.check.attempt_id} 已通过，提交交付时自动解除阻塞。`,
    },
  );
  return resumed;
}

/** Internal maintenance only. Evidence, one-shot consumption and wake request commit atomically. */
export function resumeWorkWaits(
  state: CommandState,
  actor: Actor,
  p: {
    baseline?: { branch: string; sha: string };
    conflict_max_resumes?: number;
    precheck_failure_limit?: number;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "resume_work_waits", ports, (d) => {
    const failureLimit = p.precheck_failure_limit ?? 2;
    ensure(
      Number.isSafeInteger(failureLimit) && failureLimit > 0,
      "validation_failed",
      "预检连续失败上限须为正整数",
    );
    const maxResumes = p.conflict_max_resumes ?? DEFAULT_CONFLICT_MAX_RESUMES;
    ensure(
      Number.isSafeInteger(maxResumes) && maxResumes > 0,
      "validation_failed",
      "冲突自动同步上限须为正整数",
    );
    const resumed: string[] = [];
    const waitingOwners = new Set(
      d
        .list("runs")
        .filter((r) => r.wait_for && !r.wait_for.resumed_by)
        .map((r) => r.assignment_id),
    );
    for (const item of d.list("work_items")) {
      const conflict = latestPrecheckConflict(
        d.state.events,
        item,
        d.state.project_id,
      );
      if (
        !conflict &&
        !item.reported_blocker?.resume_when &&
        (!item.assignment_id || !waitingOwners.has(item.assignment_id))
      )
        continue;
      const owner = d
        .list("assignments")
        .find((a) => a.id === item.assignment_id);
      if (!owner) {
        const c = item.reported_blocker?.resume_when;
        const evidence = c && satisfied(d, c, p.baseline, item);
        if (evidence) deferResume(d, item, "没有负责人", evidence);
        continue;
      }
      const runs = d.list("runs").filter((r) => r.assignment_id === owner.id);
      const last = runs.toSorted(
        (a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)),
      )[0];
      const blocker = item.reported_blocker;
      const wait = last?.status === "completed" ? last.wait_for : undefined;
      const conflictWait =
        conflict &&
        (blocker
          ? blocker.resume_when?.kind === "baseline_updated" ||
            (blocker.resume_when?.kind === "precheck_finished" &&
              blocker.resume_when.target_id === conflict.attempt_id) ||
            (!blocker.resume_when &&
              blocker.needs === "role" &&
              baselineBlockerReason(blocker.reason))
          : !wait || wait.condition.kind === "baseline_updated");
      const condition = conflictWait
        ? { kind: "baseline_updated" as const, target_id: owner.base_sha ?? "" }
        : blocker
          ? blocker.resume_when
          : wait?.resumed_by
            ? undefined
            : wait?.condition;
      if (!condition) continue;
      const authorWait =
        !conflictWait && blocker?.reported_by === `assignment:${owner.id}`
          ? authorPrecheckWait(d, item, condition, blocker.needs)
          : undefined;
      if (authorWait?.consumed) continue;
      const evidence = authorWait
        ? authorWait.event.type === "precheck_finished"
          ? authorWait.event.id
          : undefined
        : satisfied(d, condition, p.baseline, item);
      const guard =
        waitOwnerGuard(d, item, owner) ??
        (runs.some((r) => r.dispatch_stop || r.inactivity_stop)
          ? "Run 正在停止"
          : runs.some(
                (r) => !["completed", "failed", "cancelled"].includes(r.status),
              )
            ? "已有未结束的 Run"
            : undefined);
      if (guard) {
        if (
          evidence &&
          !(conflictWait && !pendingBaselineConflict(d, item)) &&
          !blocker?.auto_resume_disabled
        )
          deferResume(d, item, guard, evidence);
        continue;
      }
      if (blocker && authorWait?.reachedFailureLimit(failureLimit)) {
        const body = `${item.id} 同一提交连续 ${failureLimit} 次预检失败（${condition.target_id}），已停止自动恢复，请 PM 核查。`;
        d.put("work_items", {
          ...item,
          reported_blocker: { ...blocker, auto_resume_disabled: true },
        });
        d.emit(
          "precheck_wait_escalated",
          item.card_id,
          {
            work_item_id: item.id,
            attempt_id: condition.target_id,
            head_sha: authorWait.check.head_sha,
            assignment_id: owner.id,
            evidence: authorWait.event.id,
            limit: failureLimit,
            body,
          },
          { type: "system", work_item_id: item.id, body },
        );
        continue;
      }
      if (
        !authorWait &&
        !conflictWait &&
        (blocker?.auto_resume_disabled || autoResumeUsed(d, item, condition))
      )
        continue;
      let recovery:
        | { attempt_id: string; head_sha: string; retry: number }
        | undefined;
      if (conflictWait) {
        const history = trusted(d).filter(
          (e) =>
            e.card_id === item.card_id && payload(e).work_item_id === item.id,
        );
        const attempts = history.filter(
          (e) =>
            e.type === "work_item_resume_requested" &&
            payload(e).conflict_head_sha === conflict.head_sha,
        );
        if (
          attempts.some(
            (e) => payload(e).conflict_attempt_id === conflict.attempt_id,
          )
        )
          continue;
        if (attempts.length >= maxResumes) {
          if (
            !history.some(
              (e) =>
                e.type === "baseline_conflict_limit_reached" &&
                payload(e).head_sha === conflict.head_sha,
            )
          ) {
            const body = `${item.id} 同一提交已自动同步基线 ${attempts.length} 次，仍有预检候选冲突；已停止自动恢复，请 PM 核查。`;
            d.emit(
              "baseline_conflict_limit_reached",
              item.card_id,
              {
                work_item_id: item.id,
                assignment_id: owner.id,
                head_sha: conflict.head_sha,
                attempt_id: conflict.attempt_id,
                previous_run_id: last?.id ?? null,
                limit: maxResumes,
                body,
              },
              { type: "system", body, work_item_id: item.id },
            );
          }
          continue;
        }
        if (!/^[a-f0-9]{40}$/u.test(condition.target_id)) continue;
        recovery = {
          attempt_id: conflict.attempt_id,
          head_sha: conflict.head_sha,
          retry: attempts.length + 1,
        };
      }
      if (!evidence) continue;
      const { reported_blocker: _blocker, ...cleared } = item;
      const reason = resumeBlockReason(d, cleared);
      if (reason) {
        deferResume(d, item, reason, evidence);
        continue;
      }
      // Keep the reported blocker until ALL blockers are clear; no premature delivery or wake.
      if (blocker) d.put("work_items", cleared);
      const next = resumeWork(d, cleared) ?? cleared;
      if (!["in_progress", "ready"].includes(next.status)) continue;
      const body = recovery
        ? `${item.id} 基线前进，自动同步；系统恢复并请求继续执行（${recovery.retry}/${maxResumes}），冲突由作者处理。`
        : `${item.id} 等待条件已满足：${condition.kind} ${condition.target_id}；系统恢复并请求继续执行。`;
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
          ...(recovery
            ? {
                conflict_attempt_id: recovery.attempt_id,
                conflict_head_sha: recovery.head_sha,
                retry: recovery.retry,
              }
            : {}),
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
