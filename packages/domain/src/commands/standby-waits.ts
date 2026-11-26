import type { Run, WorkItem } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import { hostOpsPending } from "../host-ops.js";
import { pendingPrecheckConflict, prechecks } from "../precheck.js";
import { transition } from "../transitions.js";
import type { ResumeCondition, StandbyWait } from "../work-wait.js";
import { type CommandDraft, ensure } from "./core.js";
import { stoppedByHuman } from "./stop-state.js";

/**
 * C-789: waits that do not change a work item's state. A delivered or
 * accepted producer whose Run lacked a scarce resource, or that has to sync a
 * moved baseline, registers the wait here; the system wakes its owner once
 * with a full-weight trigger (the Run claims the item's resources at
 * admission). A Run that ends `blocked` without registering anything gets a
 * system-registered blocker (in progress) or standby record (otherwise) that
 * goes to PM, so the finish itself is never refused.
 */
export const STANDBY_REGISTERED = "work_item_standby_registered";
export const STANDBY_CLEARED = "work_item_standby_cleared";
export const STANDBY_CONDITION_KINDS: ReadonlySet<ResumeCondition["kind"]> =
  new Set(["baseline_updated", "resource_available"]);

/** A producer whose state a wait must not change. */
export const standbyStatus = (item: WorkItem) =>
  item.kind === "produce" && ["delivered", "accepted"].includes(item.status);

const OPEN_DECISION = ["open", "provisional", "snoozed"];

/** The resource keys the owner's current Run already holds. */
function heldKeys(run: Run | undefined) {
  return run?.resource_keys ?? [];
}

export function registerStandbyWait(
  d: CommandDraft,
  item: WorkItem,
  p: {
    reason: string;
    condition?: ResumeCondition;
    run?: Run | undefined;
    auto_registered?: true;
    disabled?: boolean;
  },
): WorkItem {
  ensure(
    standbyStatus(item),
    "illegal_transition",
    `仅已交付或已验收的产出工作项可登记不改变状态的等待（${item.id} 为 ${item.status}）`,
  );
  if (p.condition) {
    ensure(
      STANDBY_CONDITION_KINDS.has(p.condition.kind),
      "validation_failed",
      "已交付或已验收的工作项只能等待基线（baseline_updated）或资源名额（resource_available）；其它情况请报告阻塞交 PM",
    );
    ensure(
      p.condition.kind !== "resource_available" ||
        !heldKeys(p.run).includes(p.condition.target_id),
      "validation_failed",
      `本次 Run 已持有资源 ${p.condition.target_id}，不需要等待名额`,
    );
  }
  const owner = item.assignment_id;
  const wait: StandbyWait = {
    reason: p.reason,
    registered_by: p.auto_registered
      ? "system"
      : owner
        ? `assignment:${owner}`
        : d.author,
    registered_at: d.now,
    ...(p.condition ? { condition: { ...p.condition } } : {}),
    ...(p.run ? { run_id: p.run.id } : {}),
    ...(p.auto_registered ? { auto_registered: true as const } : {}),
    ...(p.disabled ? { auto_resume_disabled: true as const } : {}),
  };
  const next: WorkItem = { ...item, standby_wait: wait };
  d.put("work_items", next);
  const body = p.condition
    ? `${item.id}（${item.status}）登记等待 ${p.condition.kind} ${p.condition.target_id}，不改变工作项状态：${p.reason}`
    : `${item.id}（${item.status}）登记等待，交 PM 处理：${p.reason}`;
  d.emit(
    STANDBY_REGISTERED,
    item.card_id,
    {
      work_item_id: item.id,
      status: item.status,
      ...(owner ? { assignment_id: owner } : {}),
      ...(p.condition ? { condition: { ...p.condition } } : {}),
      ...(p.run ? { run_id: p.run.id } : {}),
      ...(p.auto_registered ? { auto_registered: true } : {}),
      ...(p.disabled ? { auto_resume_disabled: true } : {}),
    },
    {
      type: "status_change",
      work_item_id: item.id,
      body,
      ...(p.auto_registered ? { author: "system" as const } : {}),
    },
    p.auto_registered
      ? { kind: "system", project_id: d.state.project_id }
      : undefined,
  );
  return next;
}

function clearStandby(d: CommandDraft, item: WorkItem, reason: string) {
  const { standby_wait: _wait, ...cleared } = item;
  d.put("work_items", cleared);
  d.emit(
    STANDBY_CLEARED,
    item.card_id,
    { work_item_id: item.id, reason },
    undefined,
    { kind: "system", project_id: d.state.project_id },
  );
  return cleared;
}

/** Why a standby item cannot be woken now; undefined when it can. */
function standbyGuard(d: CommandDraft, item: WorkItem) {
  const card = d.card(item.card_id);
  if (card.hold) return "卡片已暂停";
  const owner = d.list("assignments").find((a) => a.id === item.assignment_id);
  if (owner?.status !== "active") return "指派未激活";
  if (owner.scope !== "work_item" || owner.work_item_id !== item.id)
    return "指派与工作项不匹配";
  if (owner.external) return "外接指派不自动启动 Run";
  if (owner.role_upgrade) return "角色升级尚未完成";
  if (stoppedByHuman(d.state.events, owner.id)) return "指派已被人工停止";
  if (hostOpsPending(d.state.events, owner.id)) return "主机操作尚未完成";
  const runs = d.list("runs").filter((r) => r.assignment_id === owner.id);
  if (runs.some((r) => r.dispatch_stop || r.inactivity_stop))
    return "Run 正在停止";
  // Never woken by its own Run: the registering Run must have ended first.
  if (
    runs.some((r) => !["completed", "failed", "cancelled"].includes(r.status))
  )
    return "已有未结束的 Run";
}

const DURABLE_GUARDS: ReadonlySet<string> = new Set([
  "指派未激活",
  "指派与工作项不匹配",
  "外接指派不自动启动 Run",
  "指派已被人工停止",
]);

/** One PM note per standby registration and reason. */
function deferStandby(
  d: CommandDraft,
  item: WorkItem,
  wait: StandbyWait,
  reason: string,
) {
  if (
    eventsOfType(d.state.events, "work_item_resume_deferred").some(
      (e) =>
        e.card_id === item.card_id &&
        e.created_at >= wait.registered_at &&
        (e.payload as { work_item_id?: unknown; reason?: unknown } | null)
          ?.work_item_id === item.id &&
        (e.payload as { reason?: unknown }).reason === reason,
    )
  )
    return;
  const body = `${item.id} 的等待条件已满足，但未能唤起负责人：${reason}。请 PM 核查。`;
  d.emit(
    "work_item_resume_deferred",
    item.card_id,
    {
      work_item_id: item.id,
      assignment_id: item.assignment_id ?? null,
      reason,
      standby: true,
      requested_by: "system",
      body,
    },
    { type: "system", work_item_id: item.id, author: "system", body },
    { kind: "system", project_id: d.state.project_id },
  );
}

/** The owner delivered again after registering: the wait no longer applies. */
function deliveredSince(d: CommandDraft, item: WorkItem, at: string) {
  return eventsOfType(d.state.events, "delivery_submitted").some(
    (e) =>
      e.card_id === item.card_id &&
      e.created_at > at &&
      d
        .list("deliveries")
        .some(
          (delivery) =>
            delivery.id ===
              (e.payload as { delivery_id?: unknown } | null)?.delivery_id &&
            delivery.work_item_id === item.id,
        ),
  );
}

/**
 * Wake each satisfied standby wait once, inside `resumeWorkWaits`. The wake
 * reuses `work_item_resume_requested` (automatic_wait) so the per-condition
 * allowance is shared with blocker waits; the work item's state is unchanged.
 */
export function resumeStandbyWaits(
  d: CommandDraft,
  satisfied: (c: ResumeCondition, item: WorkItem) => string | undefined,
): string[] {
  const resumed: string[] = [];
  for (const item of d.list("work_items")) {
    const wait = item.standby_wait;
    if (!wait) continue;
    const card = d.card(item.card_id);
    if (
      ["done", "cancelled"].includes(card.status) ||
      item.replaced_by_work_item_id
    ) {
      clearStandby(d, item, "卡片或工作项已结束");
      continue;
    }
    if (!standbyStatus(item)) {
      clearStandby(d, item, `工作项已转为 ${item.status}`);
      continue;
    }
    if (deliveredSince(d, item, wait.registered_at)) {
      clearStandby(d, item, "登记后已有新交付");
      continue;
    }
    const condition = wait.condition;
    if (!condition || wait.auto_resume_disabled) continue;
    const guard = standbyGuard(d, item);
    if (guard) {
      // Durable obstacles need PM once; transient ones (own Run, stop in
      // progress, hold, role upgrade, host operation) just wait.
      if (DURABLE_GUARDS.has(guard) && satisfied(condition, item))
        deferStandby(d, item, wait, guard);
      continue;
    }
    const evidence = satisfied(condition, item);
    const owner = d
      .list("assignments")
      .find((a) => a.id === item.assignment_id);
    if (!evidence || !owner) continue;
    const last = d
      .list("runs")
      .filter((r) => r.assignment_id === owner.id)
      .toSorted((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
    const { standby_wait: _wait, ...cleared } = item;
    d.put("work_items", cleared);
    const body =
      condition.kind === "resource_available"
        ? `${item.id} 等待资源 ${condition.target_id}：系统请求带名额的新 Run，名额空出前在派发队列等待；工作项状态保持 ${item.status}。`
        : `${item.id} 等待条件已满足：${condition.kind} ${condition.target_id}；系统请求继续执行，工作项状态保持 ${item.status}。`;
    d.emit(
      "work_item_resume_requested",
      item.card_id,
      {
        work_item_id: item.id,
        assignment_id: owner.id,
        role_version: owner.role_version,
        automatic_wait: true,
        standby: true,
        condition: { ...condition },
        evidence,
        previous_run_id: last?.id ?? null,
        reported_blocker_cleared: false,
        body,
      },
      { type: "system", body, work_item_id: item.id },
    );
    resumed.push(item.id);
  }
  return resumed;
}

/** A next step this Run's owner already registered for the item. */
function nextStepRegistered(d: CommandDraft, item: WorkItem, owner: string) {
  if (["blocked", "waiting_decision"].includes(item.status)) return true;
  // A leftover record on an item that went back to work is not a next step.
  if (item.standby_wait && standbyStatus(item)) return true;
  // The system already owns these waits: a candidate conflict is resumed on
  // the next baseline, an author precheck in flight wakes its author.
  if (pendingPrecheckConflict(d.state.events, item, d.state.project_id))
    return true;
  if (
    prechecks(d.state.events, item.card_id).some(
      (c) =>
        c.work_item_id === item.id &&
        c.assignment_id === owner &&
        (c.status === "queued" || c.status === "running"),
    )
  )
    return true;
  if (
    d
      .list("decisions")
      .some(
        (q) =>
          OPEN_DECISION.includes(q.status) &&
          q.affected_work_items.includes(item.id),
      )
  )
    return true;
  return d
    .list("human_actions")
    .some(
      (h) =>
        h.status === "open" &&
        h.card_id === item.card_id &&
        h.requested_by === `assignment:${owner}`,
    );
}

/**
 * C-789: `finish_run(blocked)` without a registered blocker or wait. Never
 * rejects: an in-progress item is blocked with a system-registered reason
 * (PM queue via `blocker_reported`), any other open item gets a standby
 * record for PM. Closed items and standing assignments are left alone.
 */
export function registerUnreportedBlock(
  d: CommandDraft,
  run: Run,
  summary: string,
) {
  const owner = d.get("assignments", run.assignment_id);
  if (owner.scope !== "work_item") return;
  const item = d.work(owner.work_item_id);
  if (item.assignment_id !== owner.id) return;
  const card = d.card(item.card_id);
  if (
    ["done", "cancelled"].includes(card.status) ||
    item.status === "cancelled" ||
    item.replaced_by_work_item_id
  )
    return;
  // A paused card or stopped owner already explains the wait.
  if (card.hold || stoppedByHuman(d.state.events, owner.id)) return;
  // A Run that delivered or reviewed did its job.
  if (
    d.list("deliveries").some((x) => x.run_id === run.id) ||
    d.list("reviews").some((x) => x.run_id === run.id)
  )
    return;
  if (nextStepRegistered(d, item, owner.id)) return;
  const reason = `系统代登记：${run.id} 以 blocked 结束，但没有登记阻塞原因或等待条件，交 PM 核查。执行摘要：${summary}`;
  if (item.status === "in_progress") {
    const moved = transition(item.kind, item.status, "block");
    if (moved.ok) {
      d.put("work_items", {
        ...item,
        status: moved.value,
        reported_blocker: {
          reason,
          needs: "role",
          reported_by: `assignment:${owner.id}`,
          reported_at: d.now,
          auto_registered: true,
        },
      } as WorkItem);
      d.emit(
        "blocker_reported",
        item.card_id,
        {
          work_item_id: item.id,
          needs: "role",
          run_id: run.id,
          auto_registered: true,
        },
        {
          type: "status_change",
          author: "system",
          body: reason,
          work_item_id: item.id,
        },
        { kind: "system", project_id: d.state.project_id },
      );
      return;
    }
  }
  if (standbyStatus(item))
    registerStandbyWait(d, item, { reason, run, auto_registered: true });
  else
    d.emit(
      "run_next_step_missing",
      item.card_id,
      {
        work_item_id: item.id,
        run_id: run.id,
        status: item.status,
        body: reason,
      },
      { type: "system", author: "system", body: reason, work_item_id: item.id },
      { kind: "system", project_id: d.state.project_id },
    );
}
