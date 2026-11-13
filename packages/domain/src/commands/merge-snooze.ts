import type { Actor, Decision } from "../entities.js";
import {
  mergeConfirmSnoozeDefaultMinutes,
  mergeConfirmSnoozeMaxMinutes,
} from "../preferences.js";
import { transition } from "../transitions.js";
import {
  attempt,
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { mergeContext } from "./merge.js";
import { projectPreferences } from "./preferences.js";

/** C-180: query shared by the stall detector and its callers. */
export function mergeConfirmationSnoozed(q: Decision, now: string): boolean {
  return (
    q.trigger === "merge_confirmation" &&
    q.status === "snoozed" &&
    !!q.snooze &&
    Date.parse(q.snooze.until) > Date.parse(now)
  );
}

/** Entry-point authorization stays in recordDecision / resolveDelegatedDecision. */
export function snoozeMergeConfirmation(
  d: CommandDraft,
  q: Decision,
  p: {
    rationale: string;
    snooze_until?: string;
    raw_quote: string;
    taken_over_from?: "role:pm";
  },
): Decision {
  text(p.rationale, "暂缓原因");
  ensure(
    q.trigger === "merge_confirmation" &&
      q.card_id &&
      q.kind === "approve" &&
      "delivery_id" in q.target,
    "illegal_transition",
    "只能暂缓合并确认",
  );
  const current = mergeContext(d.state, q.card_id);
  ensure(
    current.target.id === q.target.delivery_id,
    "illegal_transition",
    "合并确认属于旧的完成申请",
  );
  const at = d.now;
  const now = Date.parse(at);
  const preferences = projectPreferences(d.state);
  const due =
    p.snooze_until === undefined
      ? now + mergeConfirmSnoozeDefaultMinutes(preferences) * 60_000
      : Date.parse(p.snooze_until);
  ensure(
    Number.isFinite(now) &&
      Number.isFinite(due) &&
      due > now &&
      (p.snooze_until === undefined ||
        /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(p.snooze_until)),
    "validation_failed",
    "暂缓到期时间须为带时区的未来时间",
  );
  const maxMinutes = mergeConfirmSnoozeMaxMinutes(preferences);
  ensure(
    due - now <= maxMinutes * 60_000,
    "validation_failed",
    `暂缓到期时间距现在不能超过 ${maxMinutes} 分钟（merge-confirm-snooze-max）`,
  );
  // Expiry removes q.snooze. Persisted events keep the first hold across
  // renewals, expiry/reopening and restarts, including holds predating C-193.
  const first = d.state.events
    .filter(
      (e) =>
        e.card_id === q.card_id &&
        e.type === "merge_confirmation_snoozed" &&
        typeof e.payload === "object" &&
        e.payload !== null &&
        "decision_id" in e.payload &&
        e.payload.decision_id === q.id,
    )
    .reduce(
      (start, e) => Math.min(start, Date.parse(e.created_at)),
      q.snooze ? Date.parse(q.snooze.at) : now,
    );
  ensure(
    due - first <= maxMinutes * 60_000,
    "validation_failed",
    `暂缓累计时长不能超过 ${maxMinutes} 分钟（从首次暂缓开始计算）；请选择更早的到期时间，已达上限请交人或处理合并确认`,
  );
  const until = new Date(due).toISOString();
  const result: Decision = {
    ...q,
    status: unwrap(transition("decision", q.status, "snooze")),
    snooze: {
      reason: p.rationale.trim(),
      until,
      at,
      by: d.author,
    },
  };
  d.put("decisions", result);
  d.emit(
    "merge_confirmation_snoozed",
    q.card_id,
    {
      decision_id: q.id,
      reason: p.rationale.trim(),
      until,
      raw_quote: p.raw_quote,
      ...(p.taken_over_from ? { taken_over_from: p.taken_over_from } : {}),
    },
    {
      type: "system",
      decision_id: q.id,
      body: `已暂缓：${p.rationale.trim()}（${q.card_id}，到 ${until}）`,
    },
  );
  return result;
}

/** Maintenance only: never renews authorization or revives an obsolete completion. */
export function expireMergeSnoozes(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(state, actor, "expire_merge_snoozes", ports, (d) => {
    const resumed: Decision[] = [];
    for (const q of d.list("decisions")) {
      if (
        q.trigger !== "merge_confirmation" ||
        q.status !== "snoozed" ||
        !q.snooze ||
        !q.card_id ||
        !(Date.parse(q.snooze.until) <= Date.parse(d.now))
      )
        continue;
      const cardId = q.card_id;
      const context = attempt(() => mergeContext(d.state, cardId));
      const current =
        context.ok &&
        q.kind === "approve" &&
        "delivery_id" in q.target &&
        context.value.target.id === q.target.delivery_id;
      const { snooze, ...rest } = q;
      const next: Decision = {
        ...rest,
        status: unwrap(
          transition("decision", q.status, current ? "resume" : "supersede"),
        ),
      };
      d.put("decisions", next);
      if (!current) {
        d.emit("decision_superseded", q.card_id, {
          decision_id: q.id,
          reason: "completion_no_longer_current",
        });
        continue;
      }
      const reason = `暂缓已到期：${snooze.reason}（${q.card_id}）`;
      // Reuse decision-request routing and the persisted wait-start fact. This
      // also gives human confirmations a fresh window under existing policy.
      d.emit(
        "decision_requested",
        q.card_id,
        {
          decision_id: q.id,
          affected_work_items: [...q.affected_work_items],
          snooze_expired: true,
          reason,
          snooze_until: snooze.until,
        },
        { type: "decision_request", decision_id: q.id, body: reason },
      );
      resumed.push(next);
    }
    return resumed;
  });
}
