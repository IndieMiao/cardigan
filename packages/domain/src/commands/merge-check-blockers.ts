import type {
  Actor,
  Event,
  MergeCheckBlocker,
  Reference,
} from "../entities.js";
import type { CardId, DeliveryId } from "../ids.js";
import { type CommandPorts, type CommandState, command } from "./core.js";
import {
  mergeBlockingDecisions,
  mergeBlockingHumanActions,
  prepareMergePlan,
} from "./merge.js";

type Reason = Omit<MergeCheckBlocker, "started_at"> & {
  readonly refs?: readonly Reference[];
};
type Unavailable = "configuration" | "repository";

function reasons(state: CommandState, card_id: CardId): Reason[] {
  const plan = prepareMergePlan(state, card_id);
  if (plan.ok) return [];
  if (plan.error.details?.merge_blocker) {
    const completion = plan.error.details.completion_id as DeliveryId;
    return [
      ...mergeBlockingDecisions(state, card_id, completion, false).map((q) => ({
        key: q.id,
        label: q.id,
        detail: q.question,
        refs: [{ kind: "decision" as const, id: q.id }],
      })),
      ...mergeBlockingHumanActions(state, card_id).map((h) => ({
        key: h.id,
        label: h.id,
        detail: h.handoff?.title ?? h.instructions,
        refs: [{ kind: "human_action" as const, id: h.id }],
      })),
    ];
  }
  return [
    {
      key: `${plan.error.code}:${plan.error.message}`,
      label: "合并前置条件",
      detail: plan.error.message,
    },
  ];
}

/** Card streams are ordered by seq; other event types do not reset the clock. */
function recorded(events: readonly Event[], card_id?: CardId) {
  const cards = new Map<CardId, Map<string, MergeCheckBlocker>>();
  for (const e of events
    .filter(
      (e) =>
        (!card_id || e.card_id === card_id) &&
        (e.type === "merge_check_blocked" ||
          e.type === "merge_check_unblocked"),
    )
    .sort((a, b) => a.seq - b.seq)) {
    if (e.actor.kind !== "system" || !e.card_id) continue;
    let active = cards.get(e.card_id);
    if (!active) {
      active = new Map();
      cards.set(e.card_id, active);
    }
    if (e.type === "merge_check_blocked") {
      const blocker = e.payload as unknown as MergeCheckBlocker;
      active.set(blocker.key, blocker);
    } else if (e.type === "merge_check_unblocked") {
      active.delete((e.payload as unknown as MergeCheckBlocker).key);
    }
  }
  return cards;
}

/** A read never writes observations or invents a start time before the first scan. */
export function mergeCheckBlockers(
  state: CommandState,
  card_id: CardId,
): MergeCheckBlocker[] {
  if (
    !state.cards.some((c) => c.id === card_id && c.status === "awaiting_merge")
  )
    return [];
  const previous = recorded(state.events, card_id).get(card_id);
  if (!previous?.size) return [];
  const current = new Map(reasons(state, card_id).map((r) => [r.key, r]));
  return [...previous.values()].flatMap((b) => {
    const reason = current.get(b.key);
    // Configuration/registration are trusted host facts, refreshed by its next scan.
    if (!reason && !b.key.startsWith("host:")) return [];
    return [
      {
        ...b,
        ...(reason ? { label: reason.label, detail: reason.detail } : {}),
      },
    ];
  });
}

/** Observation only: never changes a plan, confirmation, check attempt or card state. */
export function recordMergeCheckBlockers(
  state: CommandState,
  actor: Actor,
  p: { readonly unavailable?: Unavailable },
  ports: CommandPorts,
) {
  return command(state, actor, "record_merge_check_blockers", ports, (d) => {
    d.projectAccess();
    const observed = recorded(state.events);
    for (const card of state.cards) {
      const previous =
        observed.get(card.id) ?? new Map<string, MergeCheckBlocker>();
      if (card.status !== "awaiting_merge" && !previous.size) continue;
      const current =
        card.status === "awaiting_merge" ? reasons(state, card.id) : [];
      if (card.status === "awaiting_merge" && p.unavailable)
        current.push({
          key: `host:${p.unavailable}`,
          label:
            p.unavailable === "configuration" ? "合并闸门配置" : "项目仓库配置",
          detail:
            p.unavailable === "configuration"
              ? "合并闸门配置无效，请修复主机配置"
              : "项目仓库尚未登记，无法准备合并候选",
        });
      for (const blocker of previous.values()) {
        if (current.some((r) => r.key === blocker.key)) continue;
        d.emit(
          "merge_check_unblocked",
          card.id,
          { ...blocker },
          {
            type: "system",
            body: `合并检查已解除阻挡：${blocker.label}`,
          },
        );
      }
      for (const reason of current) {
        if (previous.has(reason.key)) continue;
        const { refs, ...fields } = reason;
        const blocker = { ...fields, started_at: d.now };
        d.emit("merge_check_blocked", card.id, blocker, {
          type: "system",
          body: `合并检查未开始：被 ${blocker.label} 挡住（自 ${blocker.started_at} 起）：${blocker.detail}`,
          ...(refs ? { refs } : {}),
        });
      }
    }
  });
}
