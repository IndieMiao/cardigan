import type {
  Decision,
  ReviewPause,
  ReviewPauseInput,
  TimelineEntry,
} from "../entities.js";
import type { AssignmentId } from "../ids.js";
import { pauseOwners, pendingPause } from "../review-pause.js";
import { type CommandDraft, ensure } from "./core.js";

function participant(d: CommandDraft, q: Decision, id: AssignmentId) {
  const a = d.list("assignments").find((a) => a.id === id);
  const w = a?.scope === "work_item" && d.work(a.work_item_id);
  ensure(
    a?.status === "active" &&
      w &&
      w.card_id === q.card_id &&
      w.assignment_id === id &&
      w.role_id === a.role_id &&
      !["cancelled", "passed", "accepted"].includes(w.status),
    "validation_failed",
    `暂停参与人 ${id} 必须是本卡未关闭工作项的当前活跃 Assignment`,
  );
  return w;
}
function instruct(
  d: CommandDraft,
  q: Decision,
  id: AssignmentId,
  body: string,
  proposal?: TimelineEntry["id"],
) {
  const w = participant(d, q, id);
  d.emit(
    "instruction_issued",
    q.card_id,
    {
      work_item_id: w.id,
      decision_id: q.id,
      pause_recipient: id,
      ...(proposal ? { proposal } : {}),
    },
    {
      type: "instruction",
      author: "system",
      work_item_id: w.id,
      decision_id: q.id,
      body,
    },
    { kind: "system", project_id: d.state.project_id },
  );
}
export function prepareReviewPause(
  d: CommandDraft,
  q: Decision,
  p?: ReviewPauseInput,
): ReviewPause {
  ensure(
    p?.owner &&
      Array.isArray(p.confirmers) &&
      p.confirmers.length &&
      p.next_step?.trim(),
    "validation_failed",
    "暂停须填写 pause_plan.owner（负责人 Assignment）、confirmers（待确认 Assignment 列表）和 next_step（下一步动作）；review_at 默认 30 分钟后",
  );
  ensure(
    q.card_id &&
      !["done", "cancelled", "awaiting_merge"].includes(
        d.card(q.card_id).status,
      ),
    "illegal_transition",
    "已关闭或待合并的卡片不能新增暂停跟进",
  );
  const ids = [p.owner, ...p.confirmers];
  ensure(
    new Set(ids).size === ids.length,
    "validation_failed",
    "负责人和待确认人不得相同或重复",
  );
  for (const id of ids) participant(d, q, id);
  const employees = ids
    .map((id) => d.get("assignments", id).employee_id)
    .filter(Boolean);
  ensure(
    new Set(employees).size === employees.length,
    "validation_failed",
    "负责人和待确认 Assignment 不得属于同一员工",
  );
  const now = Date.parse(d.now);
  const due =
    p.review_at === undefined ? now + 30 * 60_000 : Date.parse(p.review_at);
  ensure(
    Number.isFinite(due) &&
      due > now &&
      (p.review_at === undefined ||
        /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(p.review_at)),
    "validation_failed",
    "review_at 必须是带时区的未来复查时间",
  );
  const review_at = new Date(due).toISOString();
  const target = q.review_intervention
    ? d.get(
        "deliveries",
        d.get("reviews", q.review_intervention.review_id).delivery_id,
      )
    : undefined;
  return {
    ...(target
      ? {
          repair_target: {
            delivery_id: target.id,
            target_sha: target.subject.value,
          },
        }
      : {}),
    owner: p.owner,
    confirmers: p.confirmers,
    next_step: p.next_step.trim(),
    review_at,
    period_ms: due - now,
    confirmations: [],
  };
}
export function instructPauseOwner(
  d: CommandDraft,
  q: Decision,
  p: ReviewPause,
) {
  instruct(
    d,
    q,
    p.owner,
    `${q.id} 暂停返工。${p.next_step.trim()}。请用 post_comment 的 review_plan={decision_id:"${q.id}",step:"propose"} 提交方案，待 ${p.confirmers.join("、")} 确认；复查时间 ${p.review_at}。`,
  );
}
export function pauseNotice(
  d: CommandDraft,
  q: Decision,
  audience: "pm_ops" | "pm_office",
  body: string,
) {
  d.emit(
    "review_pause_notice",
    q.card_id,
    { decision_id: q.id, audience, body },
    { type: "system", author: "system", decision_id: q.id, body },
    { kind: "system", project_id: d.state.project_id },
  );
}
export function recordPauseComment(
  d: CommandDraft,
  q: Decision,
  entry: TimelineEntry,
  step: "propose" | "confirm",
) {
  const p = pendingPause(q);
  const a = d.assignment;
  ensure(
    p &&
      q.card_id === entry.card_id &&
      !["done", "cancelled", "awaiting_merge"].includes(
        d.card(entry.card_id).status,
      ),
    "illegal_transition",
    "本卡没有等待跟进的暂停",
  );
  ensure(
    a?.scope === "work_item",
    "unauthorized",
    "只有指定 Assignment 能提交或确认方案",
  );
  d.ownWork(participant(d, q, a.id).id);
  if (step === "propose") {
    ensure(
      a.id === p.owner && pauseOwners(p).length,
      "unauthorized",
      "只有指定负责人能提交待确认方案；确认完成后不可换版",
    );
    d.put("decisions", {
      ...q,
      review_pause: { ...p, proposal: entry.id, confirmations: [] },
    });
    for (const id of p.confirmers)
      instruct(
        d,
        q,
        id,
        `${q.id} 请核对方案 ${entry.id}，同意后用 post_comment 回复该条并传 review_plan={decision_id:"${q.id}",step:"confirm"}。方向确认不等于审核通过。`,
        entry.id,
      );
  } else {
    ensure(
      step === "confirm" && p.proposal && entry.reply_to === p.proposal,
      "validation_failed",
      "请回复当前版本的暂停方案",
    );
    ensure(
      pauseOwners(p).includes(a.id),
      "unauthorized",
      "不是当前待确认人，或已经确认",
    );
    const updated = {
      ...p,
      confirmations: [...p.confirmations, { by: a.id, entry: entry.id }],
    };
    d.put("decisions", { ...q, review_pause: updated });
    if (!pauseOwners(updated).length)
      pauseNotice(
        d,
        q,
        "pm_ops",
        `${q.id} 方案 ${entry.reply_to} 已全部确认，请按原拍板权限结案并恢复返工。`,
      );
  }
}
