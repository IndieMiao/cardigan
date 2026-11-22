import type { WorkItem } from "../entities.js";
import type { AssignmentId, WorkItemId } from "../ids.js";
import type { CommandDraft, CommandState } from "./core.js";

type Attention = {
  card_id: WorkItem["card_id"];
  work_item_id: WorkItemId;
  assignment_id: AssignmentId | null;
  reason: string;
  body: string;
};

const cache = new WeakMap<CommandState, ReadonlyMap<WorkItemId, Attention>>();

/** Rebuild the PM inbox from card facts. A new report starts a new wait;
 * a wake, successor Run or inline delivery settles the previous incident. */
export function resumeAttention(state: CommandState) {
  const cached = cache.get(state);
  if (cached) return cached;
  const open = new Map<WorkItemId, Attention>();
  const items = new Map(state.work_items.map((w) => [w.id, w]));
  const byOwner = new Map(state.work_items.map((w) => [w.assignment_id, w.id]));
  for (const e of state.events) {
    if (!e.card_id || e.actor.project_id !== state.project_id) continue;
    if (typeof e.payload !== "object" || !e.payload || Array.isArray(e.payload))
      continue;
    const p = e.payload as Partial<Attention> & { status?: string };
    if (
      (e.type === "delivery_submitted" || e.type === "review_submitted") &&
      e.actor.kind === "assignment"
    ) {
      const id = byOwner.get(e.actor.assignment_id);
      if (id && items.get(id)?.card_id === e.card_id) open.delete(id);
      continue;
    }
    if (
      e.type === "card_merged" ||
      (e.type === "card_updated" &&
        ["done", "cancelled"].includes(p.status ?? ""))
    ) {
      for (const [id, row] of open)
        if (row.card_id === e.card_id) open.delete(id);
      continue;
    }
    if (e.type === "run_queued" && p.assignment_id) {
      const id = byOwner.get(p.assignment_id);
      if (id && items.get(id)?.card_id === e.card_id) open.delete(id);
      continue;
    }
    const w = p.work_item_id && items.get(p.work_item_id);
    if (!w || w.card_id !== e.card_id) continue;
    if (
      [
        "work_item_resume_requested",
        "precheck_wait_delivered",
        "blocker_reported",
        "work_item_assigned",
        "work_item_replaced",
      ].includes(e.type)
    )
      open.delete(w.id);
    if (
      e.type === "blocker_reported" &&
      "auto_resume_disabled" in p &&
      p.auto_resume_disabled === true &&
      e.actor.kind === "assignment" &&
      w.assignment_id === e.actor.assignment_id
    ) {
      open.set(w.id, {
        card_id: w.card_id,
        work_item_id: w.id,
        assignment_id: w.assignment_id,
        reason: "auto_resume_disabled",
        body: `${w.id} 再次阻塞，自动恢复次数已用完，请 PM 核查。`,
      });
    }
    if (
      e.actor.kind !== "system" ||
      ![
        "work_item_resume_deferred",
        "precheck_wait_escalated",
        "baseline_conflict_limit_reached",
      ].includes(e.type) ||
      p.assignment_id !== (w.assignment_id ?? null) ||
      !p.body
    )
      continue;
    open.set(w.id, {
      card_id: w.card_id,
      work_item_id: w.id,
      assignment_id: p.assignment_id,
      reason: p.reason ?? e.type,
      body: p.body,
    });
  }
  cache.set(state, open);
  return open;
}

export function deferResume(
  d: CommandDraft,
  item: WorkItem,
  reason: string,
  evidence?: string,
) {
  if (resumeAttention(d.state).get(item.id)?.reason === reason) return;
  const body = `${item.id} 未能继续执行：${reason}。请 PM 核查。`;
  d.emit(
    "work_item_resume_deferred",
    item.card_id,
    {
      work_item_id: item.id,
      assignment_id: item.assignment_id ?? null,
      reason,
      ...(evidence ? { evidence } : {}),
      requested_by: d.author,
      body,
    },
    { type: "system", work_item_id: item.id, author: "system", body },
    { kind: "system", project_id: d.state.project_id },
  );
}
