import { categoryDelegated } from "../decision-authorization.js";
import type {
  Actor,
  Assignment,
  Author,
  Decision,
  PlainSummary,
} from "../entities.js";
import { appendEvents } from "../event-index.js";
import type { AssignmentId, CardId, EventId } from "../ids.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { buildSuggestion } from "./decision-suggestion.js";
import { assignDecision } from "./delegation.js";
import { projectPreferences } from "./preferences.js";
import {
  ASSIGNMENT_HOLD_RESUMED,
  type HeldPause,
  heldPause,
} from "./stop-state.js";

/**
 * C-732: the system's question "resume this paused Assignment?". It is a
 * `permission` decision, so the project's category delegation routes it to PM
 * Ops (since 11-20 by default) or to the human's Needs You, both with a
 * one-click suggestion. Answering `resume` ends the pause on the human's
 * behalf; nothing here starts a session: the Dispatcher delivers the waiting
 * bells once the fence is gone.
 */
export const HELD_RESUME_TRIGGER = "held_assignment_resume";
export const HELD_RESUME_OPTION = "resume";
export const HELD_KEEP_OPTION = "keep_paused";

export const HELD_RESUME_PLAIN_SUMMARY: PlainSummary = {
  changed:
    "有一名员工被人手动暂停了，但卡片还在进行，给它的新任务一直排着送不出去",
  impact:
    "选恢复后系统会按排着的任务重新开工；选保持暂停就继续等，排着的任务不会丢",
  risk: "无",
};

/** Plain description of who recorded a pause: "人", "系统" or the Assignment. */
export function pauseAuthorLabel(by: string) {
  if (by === "human") return "人";
  if (by === "system") return "系统";
  return by.replace(/^assignment:/u, "");
}
export function describeHeldPause(pause: HeldPause) {
  return `${pauseAuthorLabel(pause.by)}于 ${pause.at} 人工暂停`;
}

export type HeldResumeReason = "pending_work" | "card_hold_released";
export interface HeldResumeRequest {
  readonly assignment_id: AssignmentId;
  readonly reason: HeldResumeReason;
  /** Oldest undelivered bell, when the reason is waiting work. */
  readonly pending_since?: string;
  readonly pending_count?: number;
}

/** The current resume question for this pause (open or already answered). */
export function heldResumeDecision(
  decisions: readonly Decision[],
  assignment_id: AssignmentId,
  pause: HeldPause,
) {
  return decisions.findLast(
    (q) =>
      q.trigger === HELD_RESUME_TRIGGER &&
      q.assignment_id === assignment_id &&
      q.status !== "withdrawn" &&
      q.status !== "superseded" &&
      q.held_pause?.event_id === pause.event_id,
  );
}

function heldTarget(d: CommandDraft, id: AssignmentId) {
  const a = d.get("assignments", id);
  const events = appendEvents(d.state.events, d.events);
  const pause = heldPause(events, id);
  if (a.scope !== "work_item" || a.status !== "active" || a.external || !pause)
    return undefined;
  const item = d.list("work_items").find((w) => w.id === a.work_item_id);
  const card = item && d.list("cards").find((c) => c.id === item.card_id);
  if (!item || item.assignment_id !== a.id || !card) return undefined;
  return { a, item, card, pause };
}

/**
 * Raise (once per pause) the resume question. Requires: the pause still holds,
 * its card is open and not itself held, and the stopped terminal is released
 * (a session still being released must not meet a second one).
 */
export function raiseHeldResumeInDraft(
  d: CommandDraft,
  p: HeldResumeRequest,
): Decision | undefined {
  const target = heldTarget(d, p.assignment_id);
  if (!target) return undefined;
  const { a, item, card, pause } = target;
  if (
    card.hold ||
    ["done", "cancelled"].includes(card.status) ||
    a.runtime_ref ||
    heldResumeDecision(d.list("decisions"), a.id, pause)
  )
    return undefined;
  const id = d.ids.next(d.state.project_id, "decision");
  const waiting =
    p.reason === "pending_work"
      ? `有 ${p.pending_count ?? 1} 条待送达的指令或门铃，最早一条从 ${p.pending_since ?? "未知时间"} 起一直排队。`
      : `${card.id} 刚解除卡片暂停，但这个指派仍处于人工暂停，卡片的继续指令送不到它。`;
  const draft: Decision = {
    id,
    key: id,
    card_id: card.id,
    raised_by: "system",
    trigger: HELD_RESUME_TRIGGER,
    assignment_id: a.id,
    kind: "choose",
    category: "permission",
    question: `${card.id} 的 ${a.id}（${item.id}）被人工暂停，要恢复吗？`,
    context: `${a.id} 由${describeHeldPause(pause)}。${card.id} 未暂停、未完成。${waiting}\n选 resume 等同于 cardigan assignment start：解除人工暂停，系统随后按排队的待办起新 Run，并记录操作者、知会人。选 keep_paused 则保持暂停，本次暂停内不再询问。`,
    options: [
      {
        key: HELD_RESUME_OPTION,
        description: "恢复指派",
        impact: "解除人工暂停，系统按排队的待办起新 Run",
      },
      {
        key: HELD_KEEP_OPTION,
        description: "保持暂停",
        impact: "继续暂停，待办继续排队，本次暂停内不再询问",
      },
    ],
    recommended: HELD_RESUME_OPTION,
    plain_summary: { ...HELD_RESUME_PLAIN_SUMMARY },
    held_pause: {
      event_id: pause.event_id as EventId,
      by: pause.by as Author,
      at: pause.at,
    },
    affected_cards: [],
    affected_work_items: [],
    blocking: false,
    decider: "human",
    doc_refs: [],
    status: "open",
  };
  const decision = assignDecision(d, {
    ...draft,
    suggestion: buildSuggestion(d, draft, {
      option: HELD_RESUME_OPTION,
      rationale: "卡片在进行、待办在排队，人工暂停没有其它出口",
    }),
  });
  d.put("decisions", decision);
  d.emit(
    "decision_requested",
    card.id,
    {
      decision_id: id,
      assignment_id: a.id,
      affected_work_items: [],
      held_resume: {
        reason: p.reason,
        paused_by: pause.by,
        paused_at: pause.at,
        ...(p.pending_since ? { pending_since: p.pending_since } : {}),
        ...(p.pending_count !== undefined
          ? { pending_count: p.pending_count }
          : {}),
      },
    },
    {
      type: "decision_request",
      decision_id: id,
      body: `${a.id} 仍处于人工暂停（${describeHeldPause(pause)}），${p.reason === "pending_work" ? "待办排队已超过阈值" : "卡片已解除暂停"}；已请${decision.decider === "human" ? "人" : "项目经理"}在 ${id} 中一键恢复或保持暂停。`,
    },
  );
  return decision;
}

/** System entry used by the host patrol. */
export function requestHeldAssignmentResume(
  state: CommandState,
  actor: Actor,
  p: HeldResumeRequest,
  ports: CommandPorts,
) {
  return command(state, actor, "request_held_assignment_resume", ports, (d) =>
    raiseHeldResumeInDraft(d, p),
  );
}

/** The pause this question is about, while it still holds. */
function samePause(d: CommandDraft, q: Decision) {
  const target = q.assignment_id && heldTarget(d, q.assignment_id);
  return target && q.held_pause?.event_id === target.pause.event_id
    ? target
    : undefined;
}

/**
 * Validate an answer before it is recorded. A pause that already ended (a
 * human start) or was replaced by a newer pause makes `resume` a no-op; the
 * same pause must not be resumed while its card is held or closed, or while
 * its stopped terminal is still being released.
 */
export function checkHeldResumeAnswer(
  d: CommandDraft,
  q: Decision,
  option: string,
) {
  if (q.trigger !== HELD_RESUME_TRIGGER || option !== HELD_RESUME_OPTION)
    return;
  const target = samePause(d, q);
  if (!target) return;
  ensure(
    !target.card.hold && !["done", "cancelled"].includes(target.card.status),
    "illegal_transition",
    `${target.card.id} 已暂停或已结束，不能恢复它的指派`,
  );
  ensure(
    !target.a.runtime_ref,
    "illegal_transition",
    `${target.a.id} 的终端还在释放，稍后再恢复`,
  );
}

/** Apply a `resume` answer: end the pause, recording who answered. */
export function applyHeldResumeAnswer(
  d: CommandDraft,
  q: Decision,
  option: string,
) {
  if (q.trigger !== HELD_RESUME_TRIGGER || option !== HELD_RESUME_OPTION)
    return;
  const target = samePause(d, q);
  if (!target) return;
  const { a, card, pause } = target;
  const by =
    d.actor.kind === "human" ? "人" : pauseAuthorLabel(d.author as string);
  d.emit(
    ASSIGNMENT_HOLD_RESUMED,
    card.id,
    {
      assignment_id: a.id,
      work_item_id: a.work_item_id as NonNullable<Assignment["work_item_id"]>,
      decision_id: q.id,
      resumed_by: d.author,
      paused_by: pause.by,
      paused_at: pause.at,
    },
    {
      type: "status_change",
      body: `${by}按 ${q.id} 恢复了 ${a.id}（原由${describeHeldPause(pause)}），系统将按排队的待办起新 Run。`,
    },
  );
}

/** Paused Assignments of a card, for the card hold release notice. */
export function heldAssignmentsOfCard(d: CommandDraft, card: CardId) {
  const events = appendEvents(d.state.events, d.events);
  return d
    .list("work_items")
    .filter((w) => w.card_id === card && w.assignment_id)
    .flatMap((w) => {
      const a = d
        .list("assignments")
        .find((x) => x.id === w.assignment_id && x.status === "active");
      const pause = a && heldPause(events, a.id);
      return a && pause ? [{ assignment: a, work_item: w, pause }] : [];
    });
}

/**
 * C-732: who can end a pause: PM Ops while the project delegates the
 * `permission` category and an Ops session can resolve delegated decisions,
 * otherwise the human (Needs You). Host operations cannot end a pause.
 */
export function heldPauseHandler(state: CommandState): "pm_ops" | "needs_you" {
  const ops = state.assignments.some(
    (a) =>
      a.status === "active" &&
      a.scope === "standing" &&
      a.role_id === "pm" &&
      a.standing_mode === "ops" &&
      state.roles.some(
        (r) =>
          r.role_id === a.role_id &&
          r.role_version === a.role_version &&
          r.allowed_tools.includes("resolve_delegated_decision"),
      ),
  );
  return ops &&
    categoryDelegated(projectPreferences(state), state.events, "permission")
    ? "pm_ops"
    : "needs_you";
}

/** C-732: the paused Assignments a card hold release leaves behind. */
export function heldReleaseNotice(
  paused: readonly {
    readonly assignment_id: string;
    readonly work_item_id: string;
    readonly paused_by: string;
    readonly paused_at: string;
    readonly resume_decision_id: string | null;
  }[],
) {
  if (!paused.length) return "";
  const rows = paused.map(
    (p) =>
      `${p.assignment_id}（${p.work_item_id}，${pauseAuthorLabel(p.paused_by)}于 ${p.paused_at} 暂停）：${
        p.resume_decision_id
          ? `在 ${p.resume_decision_id} 一键恢复`
          : `用 cardigan assignment start ${p.assignment_id} 恢复`
      }`,
  );
  return `\n以下指派仍处于人工暂停，不会随卡片继续：\n${rows.join("\n")}`;
}
