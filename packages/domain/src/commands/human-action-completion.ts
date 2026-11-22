import type { HumanAction, WorkItem } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import type { HumanActionId } from "../ids.js";
import { highRiskCategories } from "../preferences.js";
import { extractReferences } from "../references.js";
import { remoteExitAction, remoteWorkerLosses } from "../remote-worker-loss.js";
import { transition } from "../transitions.js";
import { workerHelperAction } from "../worker-helper-action.js";
import { type CommandDraft, ensure, text, unwrap } from "./core.js";
import { mergeContentDecisions } from "./human-decided-merge.js";
import { correctRemoteLoss } from "./remote-loss-recovery.js";
import { queueResumedRun, resumeWork } from "./resumption.js";

export function humanOnlyAction(d: CommandDraft, action: HumanAction) {
  const card = action.card_id && d.card(action.card_id);
  return !!(
    action.blocks_merge ||
    action.prerequisite ||
    action.blocked_work_items.length ||
    (action.category && highRiskCategories.includes(action.category)) ||
    (action.requested_by === "system" &&
      eventsOfType(d.state.events, "human_action_requested").some((e) => {
        const p = e.payload as {
          human_action_id?: string;
          host_ops_action_id?: string;
          preparation_run_id?: string;
        };
        return (
          e.actor.kind === "system" &&
          e.actor.project_id === d.state.project_id &&
          p.human_action_id === action.id &&
          (p.host_ops_action_id || p.preparation_run_id)
        );
      })) ||
    card?.sensitive ||
    (card &&
      mergeContentDecisions(d.state.decisions, card, d.state.events).some(
        (q) => q.category && highRiskCategories.includes(q.category),
      ))
  );
}

/** Before category was persisted, deployment evidence waits used a system-only key. */
function legacyDeploymentEvidence(d: CommandDraft, action: HumanAction) {
  return (
    action.requested_by === "system" &&
    !action.card_id &&
    eventsOfType(d.state.events, "host_deployment_action_requested").some(
      (e) => {
        const p = e.payload as { human_action_id?: string; key?: string };
        return (
          e.actor.kind === "system" &&
          e.actor.project_id === d.state.project_id &&
          !e.card_id &&
          p.human_action_id === action.id &&
          /^deployment-evidence:[a-f0-9]{40}$/u.test(p.key ?? "")
        );
      },
    )
  );
}

/** All completion routes share the human-only fences, transition and audit. */
export function completeActionDraft(
  d: CommandDraft,
  p: {
    human_action_id: HumanActionId;
    text: string;
    conclusion?: "exited" | "false_alarm";
    attachments?: readonly string[];
  },
  helperVerified = false,
) {
  const action = d.get("human_actions", p.human_action_id);
  ensure(
    !workerHelperAction(d.state, action) || helperVerified,
    "illegal_transition",
    "请在 Needs You 确认并通过两项机器核验",
  );
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
  ensure(
    d.actor.kind !== "assignment" ||
      action.triage !== "host" ||
      !!action.category ||
      legacyDeploymentEvidence(d, action),
    "unauthorized",
    "未分类主机待办须先核对原始请求，不能仅凭完成回帖结项",
  );
  const remote = remoteExitAction(d.state, action.id);
  ensure(
    remote
      ? ["exited", "false_alarm"].includes(p.conclusion ?? "")
      : !p.conclusion,
    "validation_failed",
    "失联待办须选择已退出或误报，其他待办不适用",
  );
  if (p.conclusion === "false_alarm") {
    const request = d.state.events.findLast(
      (e) =>
        e.type === "human_action_requested" &&
        (e.payload as { human_action_id?: string }).human_action_id ===
          action.id,
    );
    const loss = remoteWorkerLosses(d.state.events).find(
      (l) =>
        l.action_id ===
        (request?.payload as { host_ops_action_id?: string })
          ?.host_ops_action_id,
    );
    ensure(loss, "stale_target", "Loss has been superseded");
    correctRemoteLoss(d, loss);
  }
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
    result: {
      ...(p.conclusion ? { conclusion: p.conclusion } : {}),
      text: p.text,
      attachments: p.attachments ?? [],
      at: d.now,
    },
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
      ...(p.conclusion ? { conclusion: p.conclusion } : {}),
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
