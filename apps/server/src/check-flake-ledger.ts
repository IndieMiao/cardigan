import type { CardId, ProjectId } from "@cardigan/domain";
import { type CheckFlakeId, checkFlakeCases } from "@cardigan/host";
import { recordNotification, type Store } from "@cardigan/store";

const week = 7 * 24 * 60 * 60 * 1000;
const eventType = "check_case_recovered";

/** One transaction across concurrent completions, summary replay and PM delivery. */
export function recordCheckFlakes(
  store: Store,
  project: ProjectId,
  card: CardId,
  attempt: string,
  at: string,
  recovered: readonly CheckFlakeId[] | undefined,
  thresholdSetting = process.env.CARDIGAN_FLAKE_WEEKLY_THRESHOLD,
) {
  if (!recovered?.length) return "";
  const configured = Number(thresholdSetting);
  const threshold =
    Number.isSafeInteger(configured) && configured > 0 ? configured : 3;
  const since = new Date(Date.parse(at) - week).toISOString();
  return store.uow.run((tx) =>
    [...new Set(recovered)]
      .map((key) => {
        const { file, name, signature } = checkFlakeCases[key];
        const rows = store.database
          .prepare(`SELECT json_extract(doc,'$.payload.attempt') AS attempt,
      json_extract(doc,'$.payload.count') AS count, json_extract(doc,'$.payload.notified') AS notified,
      json_extract(doc,'$.created_at') AS at FROM events WHERE project_id=? AND type=?
      AND json_extract(doc,'$.payload.key')=? AND (json_extract(doc,'$.payload.attempt')=? OR
      (json_extract(doc,'$.created_at')>? AND json_extract(doc,'$.created_at')<=?))`)
          .all(project, eventType, key, attempt, since, at);
        const existing = rows.find((r) => r.attempt === attempt);
        const count = existing ? Number(existing.count) : rows.length + 1;
        const text = `偶发：${file} · ${name}（${signature}，近七天 ${count} 次）`;
        if (existing) return text;
        const notified =
          count >= threshold && !rows.some((r) => r.notified === 1);
        const event = {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project, card),
          type: eventType,
          card_id: card,
          actor: { kind: "system" as const, project_id: project },
          created_at: at,
          payload: { key, attempt, file, name, signature, count, notified },
        };
        tx.events.append(project, event);
        if (notified) {
          const id = tx.ids.nextTimelineEntryId(project, card);
          tx.timeline.put(project, {
            id,
            short_id: id,
            card_id: card,
            event_seq: event.seq,
            type: "system",
            author: "system",
            body: `${text}。已交 PM Ops 排查并修复根因。`,
            refs: [],
            mentions: [],
            retracted: false,
            created_at: at,
          });
          recordNotification(store.database, {
            project_id: project,
            card_id: card,
            event_id: event.id,
            seq: event.seq,
            recipient: { kind: "pm_ops" },
            kind: "escalation",
            at,
          });
        }
        return text;
      })
      .join("\n"),
  );
}
