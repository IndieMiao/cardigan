import type { HumanAction, WorkItem } from "../entities.js";
import type { HumanActionId } from "../ids.js";
import { highRiskCategories } from "../preferences.js";
import { extractReferences } from "../references.js";
import { remoteExitAction } from "../remote-worker-loss.js";
import { transition } from "../transitions.js";
import { type CommandDraft, ensure, text, unwrap } from "./core.js";
import { mergeContentDecisions } from "./human-decided-merge.js";
import { queueResumedRun, resumeWork } from "./resumption.js";

export function humanOnlyAction(d: CommandDraft, action: HumanAction) {
  const card = action.card_id && d.card(action.card_id);
  return !!(
    action.blocks_merge ||
    action.prerequisite ||
    action.blocked_work_items.length ||
    (action.category && highRiskCategories.includes(action.category)) ||
    card?.sensitive ||
    (card &&
      mergeContentDecisions(d.state.decisions, card, d.state.events).some(
        (q) => q.category && highRiskCategories.includes(q.category),
      ))
  );
}

/** PM verifies the report's substance. The domain verifies its provenance and target. */
export function hasHostResult(
  d: CommandDraft,
  action: HumanAction,
  reason: string,
) {
  const entries = d.state.timeline;
  return extractReferences(reason).some((ref) => {
    if (ref.kind !== "timeline_entry") return false;
    const entry = entries.find((e) => e.id === ref.id);
    if (
      !entry ||
      entry.card_id !== action.card_id ||
      entry.type !== "comment" ||
      entry.retracted ||
      entries.some((e) => e.supersedes === entry.id) ||
      !entry.body.trim()
    )
      return false;
    const author = d.state.assignments.find(
      (a) => `assignment:${a.id}` === entry.author,
    );
    if (
      entry.author !== "human" &&
      !(
        author?.scope === "standing" &&
        ["host_ops", "pm"].includes(author.role_id)
      )
    )
      return false;
    return (
      entry.refs.some((r) => r.kind === "human_action" && r.id === action.id) ||
      entries.some(
        (e) =>
          e.id === entry.reply_to &&
          e.card_id === entry.card_id &&
          e.human_action_id === action.id,
      )
    );
  });
}

/** All completion routes share the human-only fences, transition and audit. */
export function completeActionDraft(
  d: CommandDraft,
  p: {
    human_action_id: HumanActionId;
    text: string;
    attachments?: readonly string[];
  },
) {
  const action = d.get("human_actions", p.human_action_id);
  ensure(
    !remoteExitAction(d.state, action.id) || d.actor.kind === "human",
    "unauthorized",
    "Only the human can confirm a remote worker exited",
  );
  ensure(
    d.actor.kind === "human" || !humanOnlyAction(d, action),
    "unauthorized",
    "阻塞、凭据或账号前置及五类交人事项只能由人结项",
  );
  text(p.text, "result");
  if (action.card_id)
    ensure(
      d.card(action.card_id).status !== "cancelled" ||
        remoteExitAction(d.state, action.id),
      "illegal_transition",
      "已取消卡片的待办不能完成",
    );
  for (const id of p.attachments ?? [])
    ensure(
      d.get("attachments", id).card_id === action.card_id,
      "validation_failed",
      "Attachment belongs to another card",
    );
  const result: HumanAction = {
    ...action,
    status: unwrap(transition("human_action", action.status, "complete")),
    result: { text: p.text, attachments: p.attachments ?? [], at: d.now },
  };
  d.put("human_actions", result);
  const resumed: WorkItem[] = [];
  for (const id of action.blocked_work_items) {
    const item = d.work(id);
    if (["done", "cancelled"].includes(d.card(item.card_id).status)) continue;
    if (resumeWork(d, item)) resumed.push(item);
  }
  const event = d.emit(
    "human_action_completed",
    action.card_id,
    {
      human_action_id: action.id,
      ...(d.tool === "complete_host_action" && d.assignment
        ? { completed_by_host_assignment_id: d.assignment.id }
        : {}),
      ...(d.actor.kind !== "human" ? { result: p.text } : {}),
      resume_work_items: resumed.map((item) => item.id),
    },
    {
      type: "human_action",
      body: p.text,
      human_action_id: action.id,
      refs: extractReferences(p.text),
    },
  );
  for (const item of resumed) queueResumedRun(d, item, event);
  return result;
}
