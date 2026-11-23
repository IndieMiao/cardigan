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

// A bare "-" is literal outside a character class; "\\-" is a syntax error with the u flag.
const escapeRegExp = (value: string) =>
  value.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
/** Whole-token pattern for ASCII keys, literal pattern for other text. */
function pattern(needle: string): string | undefined {
  const value = needle.trim();
  if (!value) return undefined;
  return /^[\w-]+$/u.test(value)
    ? `(?<![\\w-])${escapeRegExp(value)}(?![\\w-])`
    : escapeRegExp(value);
}
const optionPatterns = (o: Decision["options"][number]) =>
  [pattern(o.key), pattern(o.description)].filter(
    (p): p is string => p !== undefined,
  );
const optionMentioned = (body: string, o: Decision["options"][number]) =>
  optionPatterns(o).some((p) => new RegExp(p, "iu").test(body));
/**
 * An explicit selection word right before the option ("选 split"、"选择：并入本卡"、
 * "choose split"). Bare mentions, questions, hedges and any negation in the
 * same clause ("不要选 split") are ambiguous.
 */
const SELECT = "(?:选择|选定|选|定为|choose|pick|option)";
const NEGATION =
  /不|别|没|未|勿|非|don'?t|(?<![\w-])(?:not|no|never)(?![\w-])/iu;
const HEDGE =
  /[?？]|吗|么|是否|还是|或者|再想想|再说|再等|等等|先等|等实测|等一下|搁置|暂缓|待定|回头|稍后|maybe|later/iu;
const CLAUSE = /[，。,.;；！!\n]+/u;
function explicitlyChosen(body: string, o: Decision["options"][number]) {
  if (HEDGE.test(body)) return false;
  const chosen = optionPatterns(o).map(
    (p) => new RegExp(`${SELECT}\\s*[:：]?\\s*["“「]?${p}`, "iu"),
  );
  const clauses = body
    .split(CLAUSE)
    .filter((c) => chosen.some((r) => r.test(c)));
  return clauses.length > 0 && clauses.every((c) => !NEGATION.test(c));
}

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
/** Staleness side: an equal time on another card cannot be ordered, so it counts. */
const notBefore = (a: Point, b: Point) =>
  a.card_id === b.card_id ? a.seq > b.seq : a.at >= b.at;

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
  // The quote is written to every decision card; never widen a sensitive card's audience.
  reject(
    !card.sensitive ||
      [...cards].every(
        (id) => d.list("cards").find((c) => c.id === id)?.sensitive,
      ),
    "所有者原话在敏感卡上，不能写到可见范围更大的卡片",
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
  // Bound entries and the cited answer's thread both follow replies and
  // revisions: an edit or a reply keeps its place even without repeating refs.
  const bound = new Set<string>(requests);
  const thread = new Set<string>([entry.id]);
  for (const e of [...timeline].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.event_seq - b.event_seq,
  )) {
    const links = [e.reply_to, e.supersedes].filter(
      (id): id is NonNullable<typeof id> => id !== undefined,
    );
    if (boundTo(e, q, requests) || links.some((id) => bound.has(id)))
      bound.add(e.id);
    if (links.some((id) => thread.has(id))) thread.add(e.id);
  }
  reject(
    asked !== undefined && isAfter(here, asked) && bound.has(entry.id),
    `所有者原话须在 ${q.id} 提出之后，并引用 ${q.id} 或回复这条拍板`,
  );
  const otherDecisions = entry.refs.flatMap((r) =>
    r.kind === "decision" && r.id !== q.id ? [r.id] : [],
  );
  reject(
    otherDecisions.length === 0,
    `所有者原话同时涉及其它拍板（${otherDecisions.join("、")}），无法确定答的是哪一条`,
  );
  const later = timeline.filter(
    (e) =>
      e.id !== entry.id &&
      cards.has(e.card_id) &&
      ownerEntry(e) &&
      !e.retracted &&
      !timeline.some((x) => x.supersedes === e.id) &&
      (bound.has(e.id) || thread.has(e.id)) &&
      notBefore(pointOf(e), here),
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
    explicitlyChosen(entry.body, chosen) && others.length === 0,
    `所有者原话须明确写出所选选项（如“选 ${chosen.key}”），不带疑问或否定，且不提及其它选项`,
  );
  const submitted = new Map<string | undefined, Point>(
    eventsOfType(events, "delivery_submitted").map((e) => [
      (e.payload as { delivery_id?: string } | null)?.delivery_id,
      { card_id: e.card_id, seq: e.seq, at: e.created_at },
    ]),
  );
  const submittedAfter = (id: string) => {
    const at = submitted.get(id);
    return !at || notBefore(at, here);
  };
  if (q.kind === "approve") {
    const goal = q.target;
    const candidates =
      "delivery_id" in goal
        ? d.list("deliveries").filter((v) => v.id === goal.delivery_id)
        : d
            .list("deliveries")
            .filter(
              (v) =>
                v.subject.kind === goal.subject.kind &&
                v.subject.value === goal.subject.value &&
                v.status !== "superseded" &&
                d
                  .list("work_items")
                  .some((w) => w.id === v.work_item_id && cards.has(w.card_id)),
            );
    // A subject must name exactly one current delivery on the decision's cards.
    const target = candidates.length === 1 ? candidates[0] : undefined;
    stale(
      target &&
        (target.status === "submitted" || target.status === "accepted") &&
        !submittedAfter(target.id),
      "所有者原话须针对当前适用的交付版本",
    );
  }
  // Any product delivery on the decision's cards after the answer changes what it applies to.
  const items = new Set<string>([
    ...q.affected_work_items,
    ...d
      .list("work_items")
      .filter((w) => cards.has(w.card_id))
      .map((w) => w.id),
  ]);
  const changed = d
    .list("deliveries")
    .filter(
      (v) =>
        items.has(v.work_item_id) &&
        v.kind !== "card_completion" &&
        submittedAfter(v.id),
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
