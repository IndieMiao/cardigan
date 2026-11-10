import type { Actor, Decision, Event } from "../entities.js";
import { type CommandPorts, type CommandState, command } from "./core.js";

const field = (e: Event, key: string) =>
  typeof e.payload === "object" && e.payload !== null && key in e.payload
    ? (e.payload as Record<string, unknown>)[key]
    : undefined;
const progressTypes = new Set([
  "card_updated",
  "card_superseded",
  "card_marked_done",
  "card_merged",
  "work_item_created",
  "work_item_updated",
  "work_item_assigned",
  "instruction_issued",
  "delivery_submitted",
  "review_submitted",
  "human_action_completed",
]);
/** Host tick: one persistent reminder per resolution, independent of bells and ACKs. */
export function remindDecisionFollowups(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(state, actor, "remind_decision_followups", ports, (d) => {
    const reminded: string[] = [];
    for (const q of d.list("decisions")) {
      if (
        q.status !== "resolved" ||
        !q.resolution ||
        !q.raised_by.startsWith("assignment:") ||
        Date.parse(d.now) - Date.parse(q.resolution.at) < 30 * 60_000
      )
        continue;
      if (
        state.events.some(
          (e) =>
            e.type === "decision_followup_due" &&
            field(e, "decision_id") === q.id &&
            field(e, "resolved_at") === q.resolution?.at,
        )
      )
        continue;
      const resolutions = state.events.filter(
        (e) =>
          e.type === "decision_resolved" && field(e, "decision_id") === q.id,
      );
      const after = (e: Event) =>
        e.created_at > (q.resolution?.at ?? "") ||
        (e.created_at === q.resolution?.at &&
          resolutions.some((r) => r.card_id === e.card_id && e.seq > r.seq));
      const cards = new Set([
        ...q.affected_cards,
        ...(q.card_id ? [q.card_id] : []),
      ]);
      const changed = state.events.some(
        (e) =>
          after(e) &&
          progressTypes.has(e.type) &&
          !!e.card_id &&
          cards.has(e.card_id) &&
          (!q.affected_work_items.length ||
            !field(e, "work_item_id") ||
            q.affected_work_items.some(
              (id) => id === field(e, "work_item_id"),
            )),
      );
      const recorded = state.timeline.some(
        (entry) =>
          entry.created_at >= (q.resolution?.at ?? "") &&
          entry.type === "comment" &&
          (entry.author === q.raised_by ||
            entry.author === "human" ||
            state.assignments.some(
              (a) =>
                `assignment:${a.id}` === entry.author &&
                a.scope === "standing" &&
                a.role_id === "pm" &&
                a.standing_mode === "ops",
            )) &&
          entry.refs.some(
            (ref) => ref.kind === "decision" && ref.id === q.id,
          ) &&
          state.events.some(
            (e) =>
              e.card_id === entry.card_id &&
              e.seq === entry.event_seq &&
              after(e),
          ),
      );
      if (changed || recorded) continue;
      d.emit(
        "decision_followup_due",
        q.card_id,
        {
          decision_id: q.id,
          resolved_at: q.resolution.at,
          raised_by: q.raised_by,
          option: q.resolution.option,
          question: q.question,
          impact:
            q.options.find((o) => o.key === q.resolution?.option)?.impact ?? "",
          rationale: q.resolution.rationale,
        },
        {
          type: "system",
          decision_id: q.id,
          body: `${q.id} 已拍板超过 30 分钟，尚未观察到落实结果，请 PM Ops 跟进发起人执行所选方案。`,
        },
      );
      reminded.push(q.id);
    }
    return reminded;
  });
}
export interface DecisionHistoryFilters {
  decider?: "human" | "pm" | "system";
  category?: string;
  card_id?: string;
  from?: string;
  to?: string;
}
export function decisionHistory(
  state: CommandState,
  filters: DecisionHistoryFilters = {},
) {
  return state.decisions
    .filter(
      (
        q,
      ): q is Decision & { resolution: NonNullable<Decision["resolution"]> } =>
        !!q.resolution &&
        (q.status === "resolved" ||
          (["superseded", "revoked"].includes(q.status) &&
            state.events.some(
              (e) =>
                e.type === "decision_resolved" &&
                field(e, "decision_id") === q.id &&
                e.created_at === q.resolution?.at,
            ))),
    )
    .map((q) => ({
      ...q,
      category: q.category ?? "general",
      decision_maker:
        q.resolution.resolved_by === "system"
          ? "system"
          : q.resolution.via === "delegated"
            ? "pm"
            : "human",
    }))
    .filter(
      (q) =>
        (!filters.decider || q.decision_maker === filters.decider) &&
        (!filters.category || q.category === filters.category) &&
        (!filters.card_id ||
          q.card_id === filters.card_id ||
          q.affected_cards.some((id) => id === filters.card_id)) &&
        (!filters.from || q.resolution.at >= filters.from) &&
        (!filters.to || q.resolution.at <= filters.to),
    )
    .sort(
      (a, b) =>
        b.resolution.at.localeCompare(a.resolution.at) ||
        b.id.localeCompare(a.id),
    );
}

/** Details are appended to the host prompt, not encoded into the ID-only bell. */
export function decisionFollowupPrompt(
  state: CommandState,
  eventIds: readonly string[],
  assignmentId: string,
) {
  return state.events
    .filter((e) => eventIds.includes(e.id) && e.type === "decision_resolved")
    .flatMap((e) => {
      const q = state.decisions.find((q) => q.id === field(e, "decision_id"));
      if (!q?.resolution || q.raised_by !== `assignment:${assignmentId}`)
        return [];
      const option = q.options.find((o) => o.key === q.resolution?.option);
      return [
        `拍板落实：${q.id} 已选择 ${q.resolution.option}（${option?.description ?? ""}）。影响：${option?.impact ?? ""}。请执行所选方案，并在卡片时间线引用 ${q.id} 写一句执行结果。`,
      ];
    })
    .join("\n");
}

/** A result notification must not start work while a different blocker remains. */
export function decisionFollowupBlocked(
  state: CommandState,
  eventId: string,
  assignmentId: string,
): boolean {
  const event = state.events.find((e) => e.id === eventId);
  if (event?.type !== "decision_resolved") return false;
  const q = state.decisions.find((q) => q.id === field(event, "decision_id"));
  if (q?.raised_by !== `assignment:${assignmentId}`) return false;
  const a = state.assignments.find((a) => a.id === assignmentId);
  const item =
    a?.scope === "work_item"
      ? state.work_items.find((w) => w.id === a.work_item_id)
      : undefined;
  return !!item && ["blocked", "waiting_decision"].includes(item.status);
}
