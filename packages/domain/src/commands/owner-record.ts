import type {
  Decision,
  OwnerDecisionRecord,
  TimelineEntry,
} from "../entities.js";
import { eventsForDecision, eventsOfType } from "../event-index.js";
import type { AttachmentId, CardId, TimelineEntryId } from "../ids.js";
import { type CommandDraft, ensure } from "./core.js";

/**
 * C-617: PM Ops links an answer the owner already gave on the card to a
 * PM-routed decision instead of asking the owner again. The record only
 * replaces the repeated question: the caller's existing authorization
 * (category delegation, human-only reasons, merge gates) is checked
 * unchanged, and the quote is copied from the record, never typed by PM.
 */
export interface OwnerRecordInput {
  readonly timeline_entry_id: TimelineEntryId;
  /** Owner-uploaded attachment on that same entry (e.g. an annotated image). */
  readonly attachment_id?: AttachmentId;
}

const FALLBACK = "请按现有途径处理（PM 按授权自行决定，或交给人）";

function reject(condition: unknown, message: string): asserts condition {
  ensure(condition, "validation_failed", `${message}；${FALLBACK}`);
}

function stale(condition: unknown, message: string): asserts condition {
  ensure(condition, "stale_target", `${message}；${FALLBACK}`);
}

/** Whole-token match for ASCII keys, literal match for other text. */
function mentions(body: string, needle: string): boolean {
  const value = needle.trim();
  if (!value) return false;
  if (!/^[\w-]+$/u.test(value)) return body.includes(value);
  const escaped = value.replace(/[-\\^$.*+?()[\]{}|]/gu, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "iu").test(body);
}

const optionMentioned = (body: string, o: Decision["options"][number]) =>
  mentions(body, o.key) || mentions(body, o.description);

function boundTo(entry: TimelineEntry, q: Decision, requests: Set<string>) {
  return (
    entry.refs.some((r) => r.kind === "decision" && r.id === q.id) ||
    (!!entry.reply_to && requests.has(entry.reply_to))
  );
}

/** Per-card sequence on the same card (constant clocks tie), time across cards. */
interface Point {
  readonly card_id?: CardId | undefined;
  readonly seq: number;
  readonly at: string;
}
const pointOf = (e: TimelineEntry): Point => ({
  card_id: e.card_id,
  seq: e.event_seq,
  at: e.created_at,
});
const isAfter = (a: Point, b: Point) =>
  a.card_id === b.card_id ? a.seq > b.seq : a.at > b.at;

const ownerEntry = (entry: TimelineEntry) =>
  entry.type === "comment" &&
  entry.author === "human" &&
  entry.on_behalf_of === undefined;

/** Validate the cited owner record against the open decision in this draft. */
export function bindOwnerRecord(
  d: CommandDraft,
  q: Decision,
  option: string,
  input: OwnerRecordInput,
): OwnerDecisionRecord {
  reject(
    !q.trigger && q.decider === "role:pm" && !q.human_required_reason,
    "只有路由给 PM、且无须由人亲自确认的普通拍板可以关联所有者原话",
  );
  stale(
    ["open", "provisional"].includes(q.status) && !q.superseded_by,
    "拍板已结案或已被替换，不能重复结案",
  );
  const cards = new Set<CardId>([
    ...(q.card_id ? [q.card_id] : []),
    ...q.affected_cards,
  ]);
  const timeline = [...d.state.timeline, ...d.timeline];
  const entry = timeline.find((e) => e.id === input.timeline_entry_id);
  ensure(entry, "not_found", "引用的所有者原话不存在");
  const card = d.list("cards").find((c) => c.id === entry.card_id);
  reject(
    card && card.project_id === d.state.project_id && cards.has(card.id),
    "所有者原话须在本项目、本拍板所在或受影响的卡片上",
  );
  reject(
    ownerEntry(entry),
    "只认所有者本人在卡片上发的评论，不认代理转述或其它身份的记录",
  );
  stale(
    !entry.retracted && !timeline.some((e) => e.supersedes === entry.id),
    "所有者原话已撤回或已被改写",
  );
  const events = [...d.state.events, ...d.events];
  const opened = eventsForDecision(events, q.id)
    .filter((e) => e.type === "decision_requested")
    .map((e) => ({ card_id: e.card_id, seq: e.seq, at: e.created_at }));
  const here = pointOf(entry);
  const asked = opened.find((e) => e.card_id === entry.card_id) ?? opened[0];
  const requests = new Set<string>(
    timeline
      .filter((e) => e.type === "decision_request" && e.decision_id === q.id)
      .map((e) => e.id),
  );
  reject(
    asked !== undefined && isAfter(here, asked) && boundTo(entry, q, requests),
    `所有者原话须在 ${q.id} 提出之后，并引用 ${q.id} 或回复这条拍板`,
  );
  const later = timeline.filter(
    (e) =>
      e.id !== entry.id &&
      cards.has(e.card_id) &&
      ownerEntry(e) &&
      !e.retracted &&
      !timeline.some((x) => x.supersedes === e.id) &&
      boundTo(e, q, requests) &&
      isAfter(pointOf(e), here),
  );
  reject(
    later.length === 0,
    `所有者之后对 ${q.id} 另有答复（${later.map((e) => e.id).join("、")}），无法确定以哪条为准`,
  );
  const chosen = q.options.find((o) => o.key === option);
  reject(chosen, "所选选项不在这条拍板里");
  const others = q.options.filter(
    (o) => o.key !== option && optionMentioned(entry.body, o),
  );
  reject(
    optionMentioned(entry.body, chosen) && others.length === 0,
    `所有者原话须明确写出所选选项（${chosen.key}），且不提及其它选项`,
  );
  const submitted = new Map<string | undefined, Point>(
    eventsOfType(events, "delivery_submitted").map((e) => [
      (e.payload as { delivery_id?: string } | null)?.delivery_id,
      { card_id: e.card_id, seq: e.seq, at: e.created_at },
    ]),
  );
  const submittedAfter = (id: string) => {
    const at = submitted.get(id);
    return !at || isAfter(at, here);
  };
  if (q.kind === "approve") {
    const goal = q.target;
    const target =
      "delivery_id" in goal
        ? d.list("deliveries").find((v) => v.id === goal.delivery_id)
        : undefined;
    stale(
      target && target.status !== "superseded" && !submittedAfter(target.id),
      "所有者原话须针对当前适用的交付版本",
    );
  }
  const changed = d
    .list("deliveries")
    .filter(
      (v) =>
        q.affected_work_items.includes(v.work_item_id) && submittedAfter(v.id),
    );
  stale(
    changed.length === 0,
    `所有者答复后交付有变化（${changed.map((v) => v.id).join("、")}）`,
  );
  if (input.attachment_id !== undefined) {
    const file = d
      .list("attachments")
      .find((a) => a.id === input.attachment_id);
    reject(
      file &&
        file.card_id === entry.card_id &&
        file.uploaded_by === "human" &&
        file.attach_to.kind === "timeline_entry" &&
        file.attach_to.id === entry.id &&
        !d.list("attachments").some((a) => a.supersedes === file.id),
      "附件须由所有者本人上传在这条原话上，且未被替换",
    );
  }
  return {
    author: "human",
    card_id: entry.card_id,
    timeline_entry_id: entry.id,
    quote: entry.body,
    at: entry.created_at,
    ...(input.attachment_id !== undefined
      ? { attachment_id: input.attachment_id }
      : {}),
    registered_by: d.author,
  };
}

/** Timeline wording: who decided (with source and time) and who registered. */
export function ownerRecordBody(
  record: OwnerDecisionRecord,
  rationale: string,
) {
  const quote = record.quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const source = [
    record.timeline_entry_id,
    record.at,
    ...(record.attachment_id ? [`附件 ${record.attachment_id}`] : []),
  ].join("，");
  return `所有者已在卡上答复（${source}）：\n${quote}\n\nPM 关联登记，不代替所有者作决定；登记说明：${rationale.trim()}`;
}
