import type { CommandState } from "./commands/core.js";
import type { Reference } from "./entities.js";
import type { CardId } from "./ids.js";
import { parseId, parseTimelineEntryId } from "./ids.js";

const kinds = {
  C: "card",
  W: "work_item",
  D: "delivery",
  A: "assignment",
  R: "run",
  V: "review",
  q: "decision",
  h: "human_action",
} as const;
export function extractReferences(body: string): readonly Reference[] {
  const refs: Reference[] = [];
  for (const [token] of body.matchAll(
    /(?<![A-Za-z0-9_-])(?:C-[1-9][0-9]*(?:#[1-9][0-9]*)?|[WDARV]-[1-9][0-9]*|[qh]\([1-9][0-9]*\))(?![A-Za-z0-9_#])/gu,
  )) {
    if (token.includes("#")) {
      const parsed = parseTimelineEntryId(token);
      if (parsed.ok) refs.push({ kind: "timeline_entry", id: parsed.value.id });
    } else {
      const kind = kinds[token[0] as keyof typeof kinds],
        parsed = parseId(kind, token);
      if (parsed.ok) refs.push({ kind, id: parsed.value.id } as Reference);
    }
  }
  for (const [url] of body.matchAll(
    /https?:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/[^\s<>()]*?(?:\/pull\/[1-9][0-9]*|\/-\/merge_requests\/[1-9][0-9]*)(?:[?#][^\s<>()]*)?/gu,
  ))
    refs.push({ kind: "pr", url: url.replace(/[.,;，。；]+$/u, "") });
  return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()];
}
export interface ResolvedReference {
  readonly kind: Exclude<Reference["kind"], "pr">;
  readonly id: string;
  readonly exists: boolean;
  readonly status: string | null;
  /** Only present for existing objects linked to a card; adapters choose their URL. */
  readonly card_id?: CardId;
}
/** Resolve only against one coherent project snapshot; nonexistent references have no link target. */
export function resolveReferences(
  state: CommandState,
  body: string,
): readonly ResolvedReference[] {
  const found = new Map<string, { status: string; card_id?: CardId }>();
  const add = (
    kind: ResolvedReference["kind"],
    id: string,
    status: string,
    card_id?: CardId,
  ) => found.set(`${kind}:${id}`, { status, ...(card_id ? { card_id } : {}) });
  const workCard = (id: string) =>
    state.work_items.find((w) => w.id === id)?.card_id;
  const assignmentCard = (id: string) => {
    const a = state.assignments.find((a) => a.id === id);
    return a?.scope === "work_item" ? workCard(a.work_item_id) : undefined;
  };
  for (const e of state.cards) add("card", e.id, e.status, e.id);
  for (const e of state.work_items) add("work_item", e.id, e.status, e.card_id);
  for (const e of state.assignments)
    add("assignment", e.id, e.status, assignmentCard(e.id));
  for (const e of state.runs)
    add("run", e.id, e.status, assignmentCard(e.assignment_id));
  for (const e of state.deliveries)
    add("delivery", e.id, e.status, workCard(e.work_item_id));
  for (const e of state.reviews)
    add("review", e.id, e.verdict, workCard(e.work_item_id));
  for (const e of state.decisions) add("decision", e.key, e.status, e.card_id);
  for (const e of state.human_actions)
    add("human_action", e.key, e.status, e.card_id);
  for (const e of state.timeline)
    add(
      "timeline_entry",
      e.short_id,
      e.retracted ? "retracted" : "active",
      e.card_id,
    );
  return extractReferences(body).flatMap((ref) => {
    if (ref.kind === "pr") return [];
    const entity = found.get(`${ref.kind}:${ref.id}`);
    return [
      {
        kind: ref.kind,
        id: ref.id,
        exists: entity !== undefined,
        status: entity?.status ?? null,
        ...(entity?.card_id ? { card_id: entity.card_id } : {}),
      },
    ];
  });
}
