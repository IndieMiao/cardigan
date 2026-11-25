import type {
  CardId,
  Delivery,
  ProjectId,
  QualifiedReference,
  ResolvedReference,
  TimelineEntry,
  WorkItem,
} from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { inIds, readDocs } from "./sql-state.js";

/**
 * C-674: a full number in a body (`SEN-C-34`), resolved in the project its
 * code names. `id` keeps the text as written so the body can be linked in
 * place; `local_id` and `project_id` are the link target.
 */
export type QualifiedResolvedReference = ResolvedReference & {
  readonly project_id?: ProjectId;
  readonly local_id: string;
};

export type QualifiedReferenceResolver = (
  refs: readonly QualifiedReference[],
) => readonly QualifiedResolvedReference[];

/** Only the kinds the Workbench links; other full numbers stay text. */
const LINKED = new Set<QualifiedReference["kind"]>([
  "card",
  "decision",
  "human_action",
  "delivery",
  "timeline_entry",
]);

/**
 * Look each full number up by its project's code. One query per project and
 * kind; an unknown code or number resolves as nonexistent, so it stays text.
 */
export function qualifiedReferenceResolver(
  store: Store,
): QualifiedReferenceResolver {
  return (refs) => {
    const wanted = refs.filter(
      (ref) => "id" in ref && LINKED.has(ref.kind),
    ) as (QualifiedReference & { id: string })[];
    if (!wanted.length) return [];
    const projects = new Map<string, ProjectId | undefined>();
    for (const ref of wanted)
      if (!projects.has(ref.code))
        projects.set(ref.code, store.projectByCode(ref.code)?.id);
    const found = new Map<string, { status: string; card_id?: CardId }>();
    const ids = (project: ProjectId, kind: QualifiedReference["kind"]) => [
      ...new Set(
        wanted
          .filter((r) => r.kind === kind && projects.get(r.code) === project)
          .map((r) => r.id),
      ),
    ];
    for (const project of new Set(projects.values())) {
      if (project === undefined) continue;
      const key = (kind: string, id: string) => `${project}:${kind}:${id}`;
      const read = <T>(table: string, list: readonly string[]) =>
        list.length
          ? (readDocs(store, project, table as "cards", inIds("id"), [
              JSON.stringify(list),
            ]) as unknown as T[])
          : [];
      for (const card of read<{ id: CardId; status: string }>(
        "cards",
        ids(project, "card"),
      ))
        found.set(key("card", card.id), {
          status: card.status,
          card_id: card.id,
        });
      for (const kind of ["decision", "human_action"] as const)
        for (const item of read<{
          id: string;
          status: string;
          card_id?: CardId;
        }>(
          kind === "decision" ? "decisions" : "human_actions",
          ids(project, kind),
        ))
          found.set(key(kind, item.id), {
            status: item.status,
            ...(item.card_id ? { card_id: item.card_id } : {}),
          });
      const deliveries = read<Delivery>("deliveries", ids(project, "delivery"));
      const workCards = new Map(
        read<WorkItem>(
          "work_items",
          deliveries.map((d) => d.work_item_id),
        ).map((w) => [w.id, w.card_id]),
      );
      for (const delivery of deliveries) {
        const card_id = workCards.get(delivery.work_item_id);
        found.set(key("delivery", delivery.id), {
          status: delivery.status,
          ...(card_id ? { card_id } : {}),
        });
      }
      for (const entry of read<TimelineEntry>(
        "timeline",
        ids(project, "timeline_entry"),
      ))
        found.set(key("timeline_entry", entry.id), {
          status: entry.retracted ? "retracted" : "active",
          card_id: entry.card_id,
        });
    }
    return wanted.map((ref) => {
      const project_id = projects.get(ref.code);
      const entity =
        project_id === undefined
          ? undefined
          : found.get(`${project_id}:${ref.kind}:${ref.id}`);
      return {
        kind: ref.kind as ResolvedReference["kind"],
        id: ref.qualified,
        local_id: ref.id,
        exists: entity !== undefined,
        status: entity?.status ?? null,
        ...(entity && project_id !== undefined ? { project_id } : {}),
        ...(entity?.card_id ? { card_id: entity.card_id } : {}),
      };
    });
  };
}
