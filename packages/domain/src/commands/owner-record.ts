import type { Decision, OwnerEvidence, TimelineEntry } from "../entities.js";
import {
  appendEvents,
  eventsForDecision,
  eventsOfType,
} from "../event-index.js";
import type { AttachmentId, CardId, TimelineEntryId } from "../ids.js";
import { type CommandDraft, ensure } from "./core.js";

/**
 * C-617 / Q-1198: PM Ops decides a PM-routed decision under its existing
 * delegation and cites the answer the owner already gave on the card as
 * evidence, instead of asking the owner again. The formal answer and
 * rationale stay PM's; the quote is copied from the record, never typed by
 * PM, and never counts as the owner's personal confirmation.
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
 * V-3065: only a complete, explicit affirmative answer counts: the whole
 * comment is "选 split" / "选择：并入本卡" / "choose split", optionally
 * prefixed with the decision ID and ending with one full stop. Anything
 * else (reasons, objections, questions, hedges) stays with the existing
 * PM decision route instead of a growing list of negation words.
 */
const SELECT = "(?:选择|选定|改选|选|定为|choose|pick)";
function explicitlyChosen(
  body: string,
  decision: Decision["id"],
  o: Decision["options"][number],
) {
  const text = body
    .trim()
    .replace(
      new RegExp(`^${escapeRegExp(decision)}\\s*[:：,，]?\\s*`, "u"),
      "",
    );
  return optionPatterns(o).some((p) =>
    new RegExp(
      `^${SELECT}\\s*[:：]?\\s*["“「]?${p}["”」]?\\s*[。.!！]?$`,
      "iu",
    ).test(text),
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
): OwnerEvidence {
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
    "所有者原话须在本项目、本拍板所在的卡片上",
  );
  // V-3065: the quote is copied into the decision, its events and timeline on
  // every card the decision touches. Equal sensitivity flags do not mean equal
  // readers, so only a decision confined to the quote's own card may cite it:
  // whoever can read the decision can already read the original comment.
  reject(
    q.card_id === card.id && cards.size === 1,
    "所有者原话只能用于同一张卡上、且不涉及其它卡的拍板，以免让读不到来源卡的人看到原话",
  );
  reject(
    ownerEntry(entry),
    "只认所有者本人在卡片上发的评论，不认代理转述或其它身份的记录",
  );
  stale(
    !entry.retracted && !timeline.some((e) => e.supersedes === entry.id),
    "所有者原话已撤回或已被改写",
  );
  const events = appendEvents(d.state.events, d.events);
  const opened = eventsForDecision(events, q.id)
    .filter((e) => e.type === "decision_requested")
    .map((e) => ({ card_id: e.card_id, seq: e.seq, at: e.created_at }));
  const here = pointOf(entry);
  const asked = opened.find((e) => e.card_id === entry.card_id) ?? opened[0];
  // Which decisions an entry answers: its own decision refs (or the request
  // it is), otherwise whatever the entry it replies to or revises answers.
  const byId = new Map(timeline.map((e) => [e.id as string, e]));
  const answered = new Map<string, ReadonlySet<string>>();
  const decisionsOf = (e: TimelineEntry): ReadonlySet<string> => {
    const known = answered.get(e.id);
    if (known) return known;
    answered.set(e.id, new Set());
    const own = new Set<string>(
      e.refs.flatMap((r) => (r.kind === "decision" ? [r.id] : [])),
    );
    if (e.type === "decision_request" && e.decision_id) own.add(e.decision_id);
    const result = own.size
      ? own
      : new Set(
          [e.reply_to, e.supersedes].flatMap((id) => {
            const parent = id ? byId.get(id) : undefined;
            return parent ? [...decisionsOf(parent)] : [];
          }),
        );
    answered.set(e.id, result);
    return result;
  };
  const targets = decisionsOf(entry);
  reject(
    asked !== undefined && isAfter(here, asked) && targets.has(q.id),
    `所有者原话须在 ${q.id} 提出之后，并引用 ${q.id} 或回复这条拍板`,
  );
  const otherDecisions = [...targets].filter((id) => id !== q.id);
  reject(
    otherDecisions.length === 0,
    `所有者原话（含所回复的内容）同时涉及其它拍板（${otherDecisions.join("、")}），无法确定答的是哪一条`,
  );
  // Replies and revisions in the cited answer's thread may retract it without citing the decision.
  const thread = new Set<string>([entry.id]);
  for (const e of [...timeline].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.event_seq - b.event_seq,
  ))
    if ([e.reply_to, e.supersedes].some((id) => id && thread.has(id)))
      thread.add(e.id);
  const later = timeline.filter(
    (e) =>
      e.id !== entry.id &&
      cards.has(e.card_id) &&
      ownerEntry(e) &&
      !e.retracted &&
      !timeline.some((x) => x.supersedes === e.id) &&
      (decisionsOf(e).has(q.id) || thread.has(e.id)) &&
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
    explicitlyChosen(entry.body, q.id, chosen) && others.length === 0,
    `所有者原话须只写一句明确的选择（如“${q.id} 选 ${chosen.key}”），不带理由、反对、疑问或其它选项`,
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
  };
}

/**
 * Q-1198: the timeline keeps PM's own answer first; the owner's words follow
 * as cited evidence with source and time, never as the formal answer.
 */
export function withOwnerEvidence(
  record: OwnerEvidence | undefined,
  body: string,
) {
  if (!record) return body;
  const quote = record.quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const source = [
    record.timeline_entry_id,
    record.at,
    ...(record.attachment_id ? [`附件 ${record.attachment_id}`] : []),
  ].join("，");
  return `${body}\n\n依据：所有者原话（${source}）\n${quote}\n\nPM 按委派作出决定，并引用所有者原话作为依据。该记录不等于所有者亲自确认。`;
}
