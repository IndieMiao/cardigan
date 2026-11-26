import type {
  Actor,
  Decision,
  Event,
  HumanAction,
  HumanActionMergeBlockingChange,
  WorkItem,
} from "../entities.js";
import { isMergePrerequisite } from "../human-action.js";
import type { DecisionId, HumanActionId } from "../ids.js";
import { isRoleActive } from "../role.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  ensure,
  text,
} from "./core.js";
import { isPmOps } from "./delegation.js";
import { queueResumedRun, resumeWork } from "./resumption.js";
import { commandWithReadyVerifiers as command } from "./system-rules.js";

type Prerequisite = NonNullable<HumanAction["prerequisite"]>;
const PREREQUISITES: readonly Prerequisite[] = [
  "credential",
  "external_account",
];
const PREREQUISITE_LABEL: Record<Prerequisite, string> = {
  credential: "凭据",
  external_account: "外部账号",
};

export interface MergeBlockingBasis {
  readonly decision_id: DecisionId;
  readonly raw_quote: string;
}

const decisionText = (q: Decision) =>
  [
    q.question,
    q.context,
    q.resolution?.raw_quote ?? "",
    q.resolution?.rationale ?? "",
    ...q.options.map((o) => `${o.description}\n${o.impact}`),
  ].join("\n");

/**
 * C-760: a decision the human resolved that may carry out a merge-blocking
 * change for an Agent. It must be the human's own answer and concern the
 * action's card, or name the action when the action has no card.
 */
export function ownerMergeBlockingBasis(
  d: CommandDraft,
  action: HumanAction,
  decision_id: DecisionId,
): MergeBlockingBasis {
  const q = d.get("decisions", decision_id);
  ensure(
    q.status === "resolved" && q.resolution?.resolved_by === "human",
    "unauthorized",
    `拍板 ${q.id} 不是人已作出的决定，不能作为依据`,
  );
  const related = action.card_id
    ? q.card_id === action.card_id || q.affected_cards.includes(action.card_id)
    : decisionText(q).includes(action.id);
  ensure(
    related,
    "unauthorized",
    `拍板 ${q.id} 与待办 ${action.id} 无关，不能作为依据`,
  );
  return { decision_id: q.id, raw_quote: q.resolution.raw_quote };
}

/** C-760: the audit record a reclassification appends to the action. */
export function mergeBlockingAudit(
  d: CommandDraft,
  action: HumanAction,
  change: {
    readonly blocks_merge: boolean;
    readonly prerequisite?: Prerequisite;
    readonly reason: string;
    readonly basis?: MergeBlockingBasis;
    readonly via: HumanActionMergeBlockingChange["via"];
  },
): HumanActionMergeBlockingChange {
  return {
    at: d.now,
    by: d.author,
    blocks_merge: change.blocks_merge,
    ...(change.prerequisite ? { prerequisite: change.prerequisite } : {}),
    previous_blocks_merge: isMergePrerequisite(action),
    ...(action.prerequisite
      ? { previous_prerequisite: action.prerequisite }
      : {}),
    reason: change.reason.trim(),
    ...(change.basis
      ? {
          decision_id: change.basis.decision_id,
          raw_quote: change.basis.raw_quote,
        }
      : {}),
    via: change.via,
  };
}

const holdLabel = (
  action: Pick<HumanAction, "blocks_merge" | "prerequisite">,
) =>
  isMergePrerequisite(action)
    ? `挡合并${action.prerequisite ? `（${PREREQUISITE_LABEL[action.prerequisite]}）` : ""}`
    : "合并后跟进";

/**
 * C-760: switch an open action between holding the merge and post-merge
 * follow-up, append the audit record and resume work it no longer blocks.
 * Callers check who may do it.
 */
export function changeMergeBlocking(
  d: CommandDraft,
  action: HumanAction,
  change: {
    readonly blocks_merge: boolean;
    readonly prerequisite?: Prerequisite;
    readonly reason: string;
    readonly basis?: MergeBlockingBasis;
    readonly via: HumanActionMergeBlockingChange["via"];
  },
): { next: HumanAction; event: Event; resumed: WorkItem[] } {
  ensure(
    action.status === "open",
    "illegal_transition",
    "只能修改未结待办的合并前置",
  );
  if (action.card_id)
    ensure(
      d.card(action.card_id).status !== "cancelled",
      "illegal_transition",
      "已取消卡片的待办不能改写",
    );
  ensure(
    change.blocks_merge
      ? !!change.prerequisite && PREREQUISITES.includes(change.prerequisite)
      : change.prerequisite === undefined,
    "validation_failed",
    "挡合并须注明凭据或外部账号前置；改为合并后跟进时不填前置",
  );
  const reason = change.reason.trim();
  const card =
    action.card_id ??
    action.blocked_work_items
      .map((id) => d.list("work_items").find((w) => w.id === id)?.card_id)
      .find((id) => id !== undefined);
  const {
    prerequisite: _prerequisite,
    ready_when: readyWhen,
    ready_released: released,
    ...rest
  } = action;
  const audit = mergeBlockingAudit(d, action, { ...change, reason });
  const history = [...(action.merge_blocking_changes ?? []), audit];
  let next: HumanAction;
  if (change.blocks_merge) {
    // A hold that waits for its own card's merge would never be shown.
    const selfDeferred =
      readyWhen?.kind === "card_merged" && readyWhen.card_id === card;
    next = {
      ...rest,
      blocks_merge: true,
      ...(change.prerequisite ? { prerequisite: change.prerequisite } : {}),
      ...(readyWhen && !selfDeferred ? { ready_when: readyWhen } : {}),
      ...(released && !selfDeferred ? { ready_released: released } : {}),
      merge_blocking_changes: history,
    };
  } else {
    next = {
      ...rest,
      blocks_merge: false,
      blocked_work_items: [],
      follow_up_work_items: [
        ...new Set([
          ...(action.follow_up_work_items ?? []),
          ...action.blocked_work_items,
        ]),
      ],
      ...(card
        ? { ready_when: { kind: "card_merged" as const, card_id: card } }
        : readyWhen
          ? {
              ready_when: readyWhen,
              ...(released ? { ready_released: released } : {}),
            }
          : {}),
      merge_blocking_changes: history,
    };
  }
  d.put("human_actions", next);
  const resumed: WorkItem[] = [];
  if (!change.blocks_merge)
    for (const id of action.blocked_work_items) {
      const item = d.work(id);
      if (["done", "cancelled"].includes(d.card(item.card_id).status)) continue;
      const result = resumeWork(d, item);
      if (result) resumed.push(result);
    }
  const who =
    d.actor.kind === "human"
      ? "所有者"
      : change.via === "merge_override"
        ? "强行确认合并"
        : "项目经理";
  const basis = change.basis
    ? `\n\n依据拍板 ${change.basis.decision_id}：“${change.basis.raw_quote}”`
    : "";
  const event = d.emit(
    "human_action_merge_blocking_changed",
    action.card_id,
    {
      human_action_id: action.id,
      via: change.via,
      previous_blocks_merge: audit.previous_blocks_merge,
      previous_prerequisite: action.prerequisite ?? null,
      blocks_merge: change.blocks_merge,
      prerequisite: change.prerequisite ?? null,
      reason,
      decision_id: change.basis?.decision_id ?? null,
      ...(change.basis ? { raw_quote: change.basis.raw_quote } : {}),
      previous_blocked_work_items: action.blocked_work_items,
      follow_up_work_items: next.follow_up_work_items ?? [],
      resume_work_items: resumed.map((item) => item.id),
    },
    {
      type: "human_action",
      human_action_id: action.id,
      body: `${who}把 ${action.id} 改为${holdLabel(next)}（原为${holdLabel(action)}）：${reason}${basis}`,
    },
  );
  for (const item of resumed) queueResumedRun(d, item, event);
  return { next, event, resumed };
}

/**
 * C-760: the owner (Workbench, local CLI) switches an action between holding
 * the merge and post-merge follow-up in either direction. PM Ops may add a
 * hold, and may lift a credential or account hold only by citing the human's
 * decision on it.
 */
export function setHumanActionMergeBlocking(
  state: CommandState,
  actor: Actor,
  p: {
    human_action_id: HumanActionId;
    blocks_merge: boolean;
    prerequisite?: Prerequisite;
    reason: string;
    decision_id?: DecisionId;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "triage_human_action", ports, (d) => {
    ensure(
      actor.kind === "human" || (isPmOps(d) && isRoleActive(state.roles, "pm")),
      "forbidden_tool",
      "只有人或后台项目经理能修改待办的合并前置",
    );
    ensure(
      typeof p.blocks_merge === "boolean",
      "validation_failed",
      "blocks_merge must be a boolean",
    );
    text(p.reason, "reason");
    const action = d.get("human_actions", p.human_action_id);
    ensure(
      action.status === "open",
      "illegal_transition",
      "只能修改未结待办的合并前置",
    );
    ensure(
      p.blocks_merge
        ? !!p.prerequisite && PREREQUISITES.includes(p.prerequisite)
        : p.prerequisite === undefined,
      "validation_failed",
      "挡合并须注明凭据或外部账号前置；改为合并后跟进时不填前置",
    );
    const basis =
      p.decision_id === undefined
        ? undefined
        : ownerMergeBlockingBasis(d, action, p.decision_id);
    ensure(
      actor.kind === "human" ||
        p.blocks_merge ||
        !action.prerequisite ||
        !!basis,
      "unauthorized",
      "移除凭据或账号前置须由人操作，或引用人已作出的拍板（decision_id）",
    );
    const holds = isMergePrerequisite(action);
    if (
      holds === p.blocks_merge &&
      (!p.blocks_merge || action.prerequisite === p.prerequisite)
    )
      return action;
    return changeMergeBlocking(d, action, {
      blocks_merge: p.blocks_merge,
      ...(p.prerequisite ? { prerequisite: p.prerequisite } : {}),
      reason: p.reason,
      ...(basis ? { basis } : {}),
      via: "direct",
    }).next;
  });
}
