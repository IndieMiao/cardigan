import type { Actor, Event, TimelineEntry } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import { needsYouItemReady } from "../readiness.js";
import { type CommandPorts, type CommandState, command } from "./core.js";
import { decisionImplementationRecorded } from "./decision-followup.js";

const fields = (e: Event): Record<string, unknown> =>
  e.payload && typeof e.payload === "object" && !Array.isArray(e.payload)
    ? (e.payload as Record<string, unknown>)
    : {};
export const OFFICE_WAIT_MS = 30 * 60_000;

const replyIndexes = new WeakMap<
  readonly TimelineEntry[],
  ReadonlyMap<string, readonly TimelineEntry[]>
>();

function repliesFor(timeline: readonly TimelineEntry[]) {
  let index = replyIndexes.get(timeline);
  if (!index) {
    const replies = new Map<string, TimelineEntry[]>();
    for (const reply of timeline) {
      if (reply.retracted) continue;
      const sources = new Set([
        reply.reply_to,
        reply.supersedes,
        ...reply.refs
          .filter(
            (r) => r.kind === "timeline_entry" || r.kind === "human_action",
          )
          .map((r) => r.id),
      ]);
      for (const source of sources) {
        if (!source) continue;
        const rows = replies.get(source);
        if (rows) rows.push(reply);
        else replies.set(source, [reply]);
      }
    }
    index = replies;
    replyIndexes.set(timeline, index);
  }
  return index;
}

/** System projection of explicit requests and recorded implementation evidence. */
export function maintainPmCoordination(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(state, actor, "maintain_pm_coordination", ports, (d) => {
    const systemEvents = (type: string) =>
      eventsOfType(state.events, type).filter((e) => e.actor.kind === "system");
    const start = systemEvents("pm_coordination_started").at(0);
    if (!start) {
      if (
        !state.cards.length &&
        !state.decisions.length &&
        !state.human_actions.length &&
        !eventsOfType(state.events, "standing_pm_recovered").length
      )
        return;
      d.emit("pm_coordination_started", undefined, {});
      return;
    }
    const startedRecoveries = new Set(
      systemEvents("standing_pm_recovery_started").map(
        (e) => fields(e).source_recovery_event_id,
      ),
    );
    for (const recovery of systemEvents("standing_pm_recovered")) {
      if (startedRecoveries.has(recovery.id)) continue;
      const started = eventsOfType(state.events, "run_started").find(
        (e) =>
          !e.card_id &&
          e.seq > recovery.seq &&
          fields(e).assignment_id === fields(recovery).assignment_id,
      );
      if (started)
        d.emit("standing_pm_recovery_started", undefined, {
          source_recovery_event_id: recovery.id,
          source_event_id: started.id,
          assignment_id: String(fields(recovery).assignment_id),
          run_id: String(fields(started).run_id),
          notice: "常驻 PM 的自动恢复已进入新执行，原责任身份和待办保持。",
        });
    }
    const readySources = new Set(
      systemEvents("delivery_ready").map((e) => fields(e).source_event_id),
    );
    const implemented = new Set(
      systemEvents("decision_implementation_recorded").map((e) =>
        JSON.stringify([fields(e).decision_id, fields(e).resolved_at]),
      ),
    );
    const waits = new Map<string, Set<string>>();
    const actionWaits = new Map<string, Event[]>();
    for (const e of [
      ...systemEvents("office_wait_started"),
      ...systemEvents("office_wait_overdue"),
      ...systemEvents("office_wait_closed"),
    ]) {
      const actionId = fields(e).source_action_id;
      if (e.type === "office_wait_started" && typeof actionId === "string") {
        const starts = actionWaits.get(actionId) ?? [];
        starts.push(e);
        actionWaits.set(actionId, starts);
      }
      const source = fields(e).wait_key ?? fields(e).source_entry_id;
      if (typeof source !== "string") continue;
      const types = waits.get(source) ?? new Set<string>();
      types.add(e.type);
      waits.set(source, types);
    }
    const deliveries = new Map(
      state.deliveries.map((v) => [v.id as string, v]),
    );
    const cards = new Map(state.cards.map((c) => [c.id, c]));
    const opsAuthors = new Set(
      state.assignments
        .filter(
          (a) =>
            a.scope === "standing" &&
            a.role_id === "pm" &&
            a.standing_mode === "ops",
        )
        .map((a) => `assignment:${a.id}`),
    );
    const offices = state.assignments.filter(
      (a) =>
        a.scope === "standing" &&
        a.role_id === "pm" &&
        a.standing_mode === "office",
    );
    const officeAuthors = new Set(offices.map((a) => `assignment:${a.id}`));
    const repliesBySource = repliesFor(state.timeline);
    for (const source of eventsOfType(state.events, "delivery_submitted")) {
      if (source.created_at < start.created_at || readySources.has(source.id))
        continue;
      const delivery = deliveries.get(String(fields(source).delivery_id));
      if (!delivery || delivery.status === "superseded") continue;
      d.emit(
        "delivery_ready",
        source.card_id,
        {
          source_event_id: source.id,
          delivery_id: delivery.id,
          subject: { ...delivery.subject },
          requested_verifiers: [...delivery.requested_verifiers],
        },
        {
          type: "system",
          delivery_id: delivery.id,
          work_item_id: delivery.work_item_id,
          body: `交付 ${delivery.id} 已就绪，版本 ${delivery.subject.value}；验证目标：${delivery.requested_verifiers.join("、") || "无"}。审核与后续门禁按当前流程处理。`,
        },
      );
    }
    for (const entry of state.timeline) {
      if (
        entry.created_at < start.created_at ||
        entry.type !== "comment" ||
        !opsAuthors.has(entry.author)
      )
        continue;
      const office = offices.find((a) =>
        entry.mentions.some((mention) => mention.replace(/^@/u, "") === a.id),
      );
      // A request must say what Office should do; acknowledgements/ordinary mentions do not start waits.
      if (!office || !/请|需要|麻烦/u.test(entry.body)) continue;
      const card = cards.get(entry.card_id);
      const replies = (repliesBySource.get(entry.id) ?? []).filter(
        (t) => t.card_id === entry.card_id && t.event_seq > entry.event_seq,
      );
      const answered =
        entry.retracted ||
        ["done", "cancelled"].includes(card?.status ?? "") ||
        replies.some(
          (t) =>
            t.author === "human" ||
            officeAuthors.has(t.author) ||
            (t.author === entry.author && t.supersedes === entry.id),
        );
      const prior = waits.get(entry.id) ?? new Set<string>();
      if (prior.has("office_wait_closed")) continue;
      const payload = {
        source_entry_id: entry.id,
        office_assignment_id: office.id,
        since: entry.created_at,
        notice: `等待 PM Office 处理：${entry.body}\n来源：${entry.id}`,
      };
      if (answered) {
        if (prior.has("office_wait_started"))
          d.emit("office_wait_closed", entry.card_id, payload);
        continue;
      }
      if (!prior.has("office_wait_started"))
        d.emit("office_wait_started", entry.card_id, payload, {
          type: "system",
          body: payload.notice,
          refs: [{ kind: "timeline_entry", id: entry.id }],
        });
      if (
        Date.parse(d.now) - Date.parse(entry.created_at) > OFFICE_WAIT_MS &&
        !prior.has("office_wait_overdue")
      )
        d.emit(
          "office_wait_overdue",
          entry.card_id,
          {
            ...payload,
            notice: `PM Office 超过 30 分钟未回应，请跟进。来源：${entry.id}`,
          },
          {
            type: "system",
            body: `PM Office 超过 30 分钟未回应，请跟进 ${entry.id}。`,
            refs: [{ kind: "timeline_entry", id: entry.id }],
          },
        );
    }
    // Structured requests handed to an external operator also wait on Office.
    for (const action of state.human_actions) {
      const handoff = action.handoff;
      const key = `${action.id}/${handoff?.rewritten_at ?? ""}`;
      const replied = (repliesBySource.get(action.id) ?? []).some(
        (t) =>
          t.created_at >= (handoff?.rewritten_at ?? d.now) &&
          (officeAuthors.has(t.author) || t.author === "human"),
      );
      const pending =
        !replied &&
        action.status === "open" &&
        action.triage === "host" &&
        action.host_operator === "external" &&
        handoff &&
        opsAuthors.has(handoff.rewritten_by) &&
        needsYouItemReady(state, action);
      const priorStarts = actionWaits.get(action.id) ?? [];
      for (const old of priorStarts) {
        const oldKey = String(fields(old).wait_key);
        if (
          (!pending || oldKey !== key) &&
          !waits.get(oldKey)?.has("office_wait_closed")
        )
          d.emit("office_wait_closed", action.card_id, {
            wait_key: oldKey,
            source_action_id: action.id,
          });
      }
      if (!pending || !handoff || handoff.rewritten_at < start.created_at)
        continue;
      const prior = waits.get(key) ?? new Set<string>();
      if (prior.has("office_wait_closed")) continue;
      const first = priorStarts.find((e) => fields(e).wait_key === key);
      const since = String(
        first
          ? fields(first).since
          : action.ready_when
            ? d.now
            : handoff.rewritten_at,
      );
      const payload = {
        wait_key: key,
        source_action_id: action.id,
        since,
        notice: `等待 PM Office 处理外接操作：${handoff.title}。来源：${action.id}`,
      };
      if (!prior.has("office_wait_started"))
        d.emit("office_wait_started", action.card_id, payload, {
          type: "system",
          human_action_id: action.id,
          body: payload.notice,
        });
      if (
        Date.parse(d.now) - Date.parse(since) > OFFICE_WAIT_MS &&
        !prior.has("office_wait_overdue")
      )
        d.emit(
          "office_wait_overdue",
          action.card_id,
          {
            ...payload,
            notice: `PM Office 超过 30 分钟未回应外接操作，请跟进 ${action.id}。`,
          },
          {
            type: "system",
            human_action_id: action.id,
            body: `PM Office 外接操作等待超过 30 分钟：${action.id}。`,
          },
        );
    }
    for (const q of state.decisions) {
      if (
        q.status !== "resolved" ||
        !q.resolution ||
        q.resolution.at < start.created_at ||
        implemented.has(JSON.stringify([q.id, q.resolution.at])) ||
        !decisionImplementationRecorded(state, q)
      )
        continue;
      d.emit(
        "decision_implementation_recorded",
        q.card_id,
        {
          decision_id: q.id,
          resolved_at: q.resolution.at,
          raised_by: q.raised_by,
        },
        {
          type: "system",
          decision_id: q.id,
          body: `${q.id} 已记录落实进展，详见原决定后的变更或结果回帖；最终完成仍以交付和验收为准。`,
        },
      );
    }
  });
}
