import type { Card, Delivery, WorkItem } from "./entities.js";
import { validMergePath } from "./preferences.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const fullSha = (v: unknown): v is string =>
  typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v);

/** Only persisted DeliveryVerifier evidence is authoritative, never author parameters. */
export function autoRiskPaths(
  delivery: Delivery,
): readonly string[] | undefined {
  if (delivery.subject.kind !== "git_head") return undefined;
  const inventory = object(
    delivery.evidence.find(
      (e) =>
        e.kind === "diff" &&
        object(e.details)?.role_rule_inventory !== undefined,
    )?.details,
  )?.role_rule_inventory;
  const i = object(inventory);
  const commit = object(
    delivery.evidence.find((e) => e.kind === "commit")?.details,
  );
  if (
    i?.version !== 1 ||
    i.complete !== true ||
    !fullSha(i.sha) ||
    i.sha !== delivery.subject.value ||
    !fullSha(i.base_sha) ||
    !fullSha(i.tree_sha) ||
    commit?.sha !== i.sha ||
    commit.base_sha !== i.base_sha ||
    commit.tree_sha !== i.tree_sha ||
    !Array.isArray(i.changes) ||
    !i.changes.every((c: unknown) => validMergePath(object(c)?.path))
  )
    return undefined;
  return i.changes.map((c: unknown) => object(c)?.path as string);
}

/** D6 prerequisite for later system merging; it does not enable a new flow version. */
export function autoRiskMergeReason(
  state: {
    readonly cards: readonly Pick<Card, "id" | "flow_version">[];
    readonly work_items?: readonly WorkItem[];
    readonly deliveries?: readonly Delivery[];
  },
  cardId: Card["id"] | undefined,
): string | undefined {
  const card = state.cards.find((c) => c.id === cardId);
  if (!card || (card.flow_version ?? 1) < 4) return undefined;
  const producers = state.work_items?.filter(
    (w) =>
      w.card_id === card.id && w.kind === "produce" && w.status !== "cancelled",
  );
  if (
    producers?.length &&
    producers.every((w) => {
      const latest = state.deliveries
        ?.filter(
          (v) =>
            v.work_item_id === w.id &&
            v.kind !== "card_completion" &&
            v.status !== "superseded",
        )
        .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
      return latest && autoRiskPaths(latest) !== undefined;
    })
  )
    return undefined;
  return "缺少当前交付的完整主机改动文件证据，合并须交人确认。";
}
