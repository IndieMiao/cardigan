import { verificationPrecheckPending } from "../delivery-precheck.js";
import type { Actor, Delivery, Event, WorkItem } from "../entities.js";
import type { WorkItemId } from "../ids.js";
import { validSystemReminderPolicy } from "../preferences.js";
import { isCompletionVerifier } from "../templates.js";
import {
  attempt,
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { selectEmployee } from "./employee-assignment.js";
import { assignWorkItem } from "./pm.js";
import { effectivePreMergeChecks } from "./pre-merge-checks.js";
import { projectPreferences } from "./preferences.js";
import { screenshotCheckEnforced } from "./screenshot-check.js";
import { resolveCardTemplate } from "./templates.js";
import { canStartWork } from "./workflow.js";

const payload = (e: Event) => e.payload as Record<string, unknown>;
const noAssignment = (d: CommandDraft, w: WorkItem) =>
  !w.assignment_id &&
  !d
    .list("assignments")
    .some((a) => a.scope === "work_item" && a.work_item_id === w.id);
const openItem = (d: CommandDraft, w: WorkItem) => {
  const card = d.get("cards", w.card_id);
  return (
    card &&
    !["backlog", "done", "cancelled"].includes(card.status) &&
    !w.manual_assign &&
    !w.replaced_by_work_item_id &&
    !w.reported_blocker &&
    ![
      "cancelled",
      "passed",
      "accepted",
      "blocked",
      "waiting_decision",
    ].includes(w.status)
  );
};

/** Require the newest live delivery of the correct producer and kind to request this verifier. */
function reviewTarget(d: CommandDraft, w: WorkItem): Delivery | undefined {
  if (w.kind !== "verify") return;
  const card = d.card(w.card_id);
  const template = resolveCardTemplate(d, card);
  const completion = !w.target_work_item_id;
  if (
    completion &&
    (!isCompletionVerifier(template, w) ||
      template.completion.mode !== "review" ||
      template.completion.reviewer === "human")
  )
    return;
  const producer = d
    .list("work_items")
    .find(
      (p) =>
        p.card_id === w.card_id &&
        p.kind === "produce" &&
        (completion
          ? p.template_key === template.primary_work_item_key
          : p.id === w.target_work_item_id),
    );
  if (!producer || producer.status === "cancelled") return;
  const latest = d
    .list("deliveries")
    .filter(
      (v) =>
        v.work_item_id === producer.id &&
        (v.kind === "card_completion") === completion &&
        v.status !== "superseded",
    )
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  return latest?.requested_verifiers.includes(w.id) ? latest : undefined;
}

export function autoAssignVerifier(
  state: CommandState,
  actor: Actor,
  p: { work_item_id: WorkItemId },
  ports: CommandPorts,
) {
  return command(state, actor, "auto_assign_verifier", ports, (d) => {
    if (projectPreferences(state).system_auto_assign_verifiers !== true)
      return null;
    const item = d.work(p.work_item_id);
    if (item.kind !== "verify" || !openItem(d, item) || !noAssignment(d, item))
      return null;
    const target = reviewTarget(d, item);
    if (!target || verificationPrecheckPending(state, item)) return null;
    // Selection/checks fail before any assignment, token request or event is written.
    // Manual assignment preserves legacy employee-less behavior; automation never does.
    const selected = attempt(() => {
      const employee = selectEmployee(d, item);
      ensure(
        employee,
        "invariant_violation",
        "没有合格的在职员工，请 PM Ops 安排",
      );
      return assignWorkItem(
        d,
        {
          work_item_id: item.id,
          role_id: item.role_id,
          employee_id: employee.id,
        },
        target.id,
      );
    });
    if (selected.ok) return selected.value;
    if (
      !state.events.some(
        (e) =>
          e.type === "system_assignment_deferred" &&
          payload(e).work_item_id === item.id &&
          payload(e).delivery_id === target.id &&
          payload(e).reason === selected.error.message,
      )
    )
      d.emit(
        "system_assignment_deferred",
        item.card_id,
        {
          rule: "C-225/auto-assign",
          work_item_id: item.id,
          delivery_id: target.id,
          reason: selected.error.message,
        },
        {
          type: "system",
          body: `系统未能指派 ${item.id}：${selected.error.message}`,
          work_item_id: item.id,
        },
      );
    return null;
  });
}

interface Wait {
  key: string;
  since: string;
  card_id: WorkItem["card_id"];
  work_item_id?: WorkItemId;
  assignment_id?: WorkItem["assignment_id"];
  delivery_id?: Delivery["id"];
  label?: string;
  after_minutes: number;
  body: string;
}

/** Persistent wait cycles: process restarts, repeated ticks and config edits cannot reset the count. */
export function remindSystemWaits(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(state, actor, "remind_system_waits", ports, (d) => {
    const policy = projectPreferences(state).system_reminder_policy;
    const waits = systemWaits(d, d.now);
    const starts = new Map<string, Event>();
    const closed = new Set(
      state.events
        .filter((e) => e.type === "system_wait_closed")
        .map((e) => payload(e).wait_id),
    );
    for (const e of state.events)
      if (
        e.type === "system_wait_started" &&
        typeof payload(e).key === "string" &&
        !closed.has(e.id)
      )
        starts.set(payload(e).key as string, e);
    for (const [key, e] of starts)
      if (!waits.some((w) => w.key === key))
        d.emit("system_wait_closed", e.card_id, { wait_id: e.id });
    for (const wait of waits) {
      if (!policy) continue;
      let start = starts.get(wait.key);
      if (!start)
        start = d.emit("system_wait_started", wait.card_id, {
          key: wait.key,
          since: state.events.some(
            (e) =>
              e.type === "system_wait_started" && payload(e).key === wait.key,
          )
            ? d.now
            : wait.since,
          rule: "C-225/reminder",
          ...(wait.work_item_id ? { work_item_id: wait.work_item_id } : {}),
          ...(wait.label ? { label: wait.label } : {}),
        });
      const sent = state.events.filter(
        (e) =>
          e.type === "system_wait_reminded" && payload(e).wait_id === start.id,
      );
      const deferred =
        wait.delivery_id &&
        state.events.some(
          (e) =>
            e.type === "system_assignment_deferred" &&
            payload(e).work_item_id === wait.work_item_id &&
            payload(e).delivery_id === wait.delivery_id,
        );
      // Auto-assignment fallback already notified Ops for this delivery; no second timer notice.
      if (
        deferred ||
        (sent.length && !policy.repeat) ||
        sent.length >= policy.max_reminders
      )
        continue;
      const from =
        sent.at(-1)?.created_at ??
        (typeof payload(start).since === "string"
          ? (payload(start).since as string)
          : start.created_at);
      const minutes = sent.length
        ? policy.repeat_interval_minutes
        : wait.after_minutes;
      if (
        minutes === null ||
        !Number.isFinite(Date.parse(d.now)) ||
        !Number.isFinite(Date.parse(from)) ||
        Date.parse(d.now) - Date.parse(from) < minutes * 60_000
      )
        continue;
      d.emit(
        "system_wait_reminded",
        wait.card_id,
        {
          rule: "C-225/reminder",
          wait_id: start.id,
          key: wait.key,
          count: sent.length + 1,
          body: wait.body,
          ...(wait.work_item_id ? { work_item_id: wait.work_item_id } : {}),
          ...(wait.assignment_id ? { assignment_id: wait.assignment_id } : {}),
        },
        {
          type: "system",
          body: wait.body,
          ...(wait.work_item_id ? { work_item_id: wait.work_item_id } : {}),
        },
      );
    }
    return null;
  });
}

/** Wait from persisted readiness facts; enabling the timer starts observation, never backfills old alerts. */
function waitSince(
  d: CommandDraft,
  at: string,
  times: readonly (string | undefined)[],
) {
  const enabled = d.state.events
    .filter(
      (e) =>
        e.type === "project_preferences_updated" &&
        payload(e).preference === "system_reminders" &&
        payload(e).new_value === true,
    )
    .at(-1)?.created_at;
  const valid = [...times, enabled].filter(
    (s): s is string =>
      !!s && Number.isFinite(Date.parse(s)) && Date.parse(s) <= Date.parse(at),
  );
  return valid.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? at;
}

/** Review events identify a Review and Delivery, not a work item. */
function reviewConcernsDependency(
  state: CommandState,
  item: WorkItem,
  event: Event,
) {
  if (event.type !== "review_submitted") return false;
  const review = state.reviews.find(
    (r) =>
      r.id === payload(event).review_id &&
      r.delivery_id === payload(event).delivery_id,
  );
  const delivery = state.deliveries.find((v) => v.id === review?.delivery_id);
  return (
    !!review &&
    !!delivery &&
    (item.depends_on.includes(review.work_item_id) ||
      (delivery.kind !== "card_completion" &&
        item.depends_on.includes(delivery.work_item_id)))
  );
}

function systemWaits(d: CommandDraft, at: string): Wait[] {
  const state = d.state;
  const pref = projectPreferences(d.state),
    policy = pref.system_reminder_policy;
  const epoch = state.events
    .filter(
      (e) =>
        e.type === "project_preferences_updated" &&
        payload(e).preference === "system_reminders" &&
        payload(e).new_value === true,
    )
    .at(-1)?.id;
  const waits: Wait[] = [];
  if (
    pref.system_reminders === true &&
    policy &&
    validSystemReminderPolicy(policy)
  ) {
    if (policy.unassigned_ready_after_minutes !== null)
      for (const item of state.work_items) {
        if (!openItem(d, item) || !noAssignment(d, item)) continue;
        const target = reviewTarget(d, item);
        const card = d.card(item.card_id);
        if (
          item.kind === "verify"
            ? !target
            : !["todo", "in_progress"].includes(card.status) ||
              !canStartWork({ item, work_items: state.work_items })
        )
          continue;
        // Holds and resumptions start a new cycle, including changes between scans.
        const hold =
          state.events
            .filter(
              (e) =>
                e.type === "work_item_updated" &&
                payload(e).work_item_id === item.id &&
                (payload(e).manual_assign !== undefined ||
                  payload(e).reported_blocker_cleared === true ||
                  (Array.isArray(payload(e).resume_work_items) &&
                    (payload(e).resume_work_items as unknown[]).includes(
                      item.id,
                    ))),
            )
            .at(-1)?.id ?? "";
        const facts = state.events.filter(
          (e) =>
            e.card_id === item.card_id &&
            ((e.type === "delivery_submitted" &&
              target?.id === payload(e).delivery_id) ||
              (e.type === "work_item_created" &&
                payload(e).work_item_id === item.id) ||
              (["delivery_accepted", "work_item_updated"].includes(e.type) &&
                item.depends_on.includes(
                  payload(e).work_item_id as WorkItemId,
                )) ||
              reviewConcernsDependency(state, item, e) ||
              (e.type === "card_updated" && payload(e).status === "todo") ||
              e.id === hold),
        );
        const since = waitSince(d, at, [
          card.created_at,
          ...facts.map((e) => e.created_at),
        ]);
        waits.push({
          key: JSON.stringify(["ready", item.id, target?.id, hold, epoch]),
          since,
          card_id: item.card_id,
          work_item_id: item.id,
          ...(target ? { delivery_id: target.id } : {}),
          after_minutes: policy.unassigned_ready_after_minutes,
          body: `${item.id} 已就绪但尚未指派，请安排负责人。`,
        });
      }
    if (policy.pre_merge_check_pending_after_minutes !== null)
      for (const card of state.cards) {
        if (card.status !== "awaiting_merge") continue;
        for (const check of effectivePreMergeChecks(
          card,
          state.work_items,
          state.deliveries,
          screenshotCheckEnforced(state),
        )) {
          if (check.status !== "pending") continue;
          const reserved =
            check.label === "独立复核" ||
            (check.label === "截图核对" && screenshotCheckEnforced(state));
          const reviewers = reserved
            ? state.work_items.filter(
                (w) =>
                  w.card_id === card.id &&
                  w.kind === "verify" &&
                  w.role_id === "independent_reviewer" &&
                  w.status !== "cancelled" &&
                  !w.replaced_by_work_item_id,
              )
            : [];
          // Reserved checks are driven by the verifier; unassigned items use the ready timer.
          const recipients = reserved
            ? reviewers.filter(
                (w) =>
                  !w.manual_assign &&
                  w.assignment_id &&
                  state.assignments.some(
                    (a) => a.id === w.assignment_id && a.status === "active",
                  ),
              )
            : [undefined];
          const versions = state.deliveries
            .filter(
              (v) =>
                v.status !== "superseded" &&
                v.kind !== "card_completion" &&
                state.work_items.some(
                  (w) => w.id === v.work_item_id && w.card_id === card.id,
                ),
            )
            .map((v) => v.id)
            .sort();
          const completionIds = state.deliveries
            .filter(
              (v) =>
                v.status !== "superseded" &&
                v.kind === "card_completion" &&
                state.work_items.some(
                  (w) => w.id === v.work_item_id && w.card_id === card.id,
                ),
            )
            .map((v) => v.id);
          const facts = state.events.filter(
            (e) =>
              e.card_id === card.id &&
              ((e.type === "delivery_submitted" &&
                versions.includes(payload(e).delivery_id as Delivery["id"])) ||
                (["review_submitted", "completion_reviewed"].includes(e.type) &&
                  completionIds.includes(
                    payload(e).delivery_id as Delivery["id"],
                  ))),
          );
          for (const reviewer of recipients) {
            const hold = reviewer
              ? state.events.findLast(
                  (e) =>
                    e.type === "work_item_updated" &&
                    payload(e).work_item_id === reviewer.id &&
                    payload(e).manual_assign !== undefined,
                )
              : undefined;
            const since = waitSince(
              d,
              at,
              facts.length || hold
                ? [
                    check.updated_at,
                    ...facts.map((e) => e.created_at),
                    hold?.created_at,
                  ]
                : [at],
            );
            waits.push({
              key: JSON.stringify([
                "check",
                card.id,
                check.label,
                check.updated_at,
                versions,
                completionIds,
                reviewer?.id,
                hold?.id ?? null,
                epoch,
              ]),
              since,
              card_id: card.id,
              label: check.label,
              ...(reviewer
                ? {
                    work_item_id: reviewer.id,
                    assignment_id: reviewer.assignment_id,
                  }
                : {}),
              after_minutes: policy.pre_merge_check_pending_after_minutes,
              body: `合并前核对「${check.label}」仍待完成，请核对当前交付。`,
            });
          }
        }
      }
  }
  return waits;
}

/** Read model used by Needs You and PM Ops; stale or handled waits disappear immediately. */
export function systemRuleAttention(d: CommandDraft, now: string) {
  const state = d.state;
  const pref = projectPreferences(state);
  const waits = systemWaits(d, now);
  const latest = new Map<string, Event>();
  for (const e of state.events) {
    if (e.actor.kind !== "system" || !e.card_id) continue;
    const p = payload(e);
    if (
      e.type === "system_assignment_deferred" &&
      pref.system_auto_assign_verifiers === true
    ) {
      const item = state.work_items.find((w) => w.id === p.work_item_id);
      if (
        !item ||
        !openItem(d, item) ||
        !noAssignment(d, item) ||
        reviewTarget(d, item)?.id !== p.delivery_id
      )
        continue;
      latest.set(`assign:${item.id}`, e);
    }
    if (
      e.type === "system_wait_reminded" &&
      waits.some((w) => w.key === p.key) &&
      !state.events.some(
        (closed) =>
          closed.type === "system_wait_closed" &&
          payload(closed).wait_id === p.wait_id,
      )
    )
      latest.set(`wait:${p.wait_id}`, e);
  }
  return [...latest.values()].flatMap((e) =>
    e.card_id
      ? [
          {
            event_id: e.id,
            card_id: e.card_id,
            work_item_id:
              typeof payload(e).work_item_id === "string"
                ? (payload(e).work_item_id as WorkItemId)
                : null,
            assignment_id:
              typeof payload(e).assignment_id === "string"
                ? (payload(e).assignment_id as string)
                : null,
            detail:
              e.type === "system_assignment_deferred"
                ? `系统未能指派 ${payload(e).work_item_id}：${payload(e).reason}`
                : String(payload(e).body),
            waited_ms: Math.max(0, Date.parse(now) - Date.parse(e.created_at)),
          },
        ]
      : [],
  );
}
