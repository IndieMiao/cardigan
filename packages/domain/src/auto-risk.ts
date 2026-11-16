import type { Card, Delivery, WorkItem } from "./entities.js";
import { flowAtLeast } from "./flow.js";
import { validChangedPath } from "./preferences.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const fullSha = (v: unknown): v is string =>
  typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v);

/** Only persisted DeliveryVerifier evidence is authoritative, never author parameters. */
export function autoRiskPathEvidence(delivery: Delivery):
  | {
      readonly paths: readonly string[];
      readonly complete: boolean;
    }
  | undefined {
  if (delivery.subject.kind !== "git_head") return undefined;
  const commit = object(
    delivery.evidence.find((e) => e.kind === "commit")?.details,
  );
  const ownEntry = delivery.evidence.find(
    (e) =>
      e.kind === "diff" && object(e.details)?.own_path_inventory !== undefined,
  );
  const own = object(object(ownEntry?.details)?.own_path_inventory);
  if (
    own?.version === 1 &&
    own.complete === true &&
    own.sha === delivery.subject.value &&
    fullSha(own.sha) &&
    fullSha(own.tree_sha) &&
    fullSha(own.base_sha) &&
    fullSha(own.assignment_base_sha) &&
    own.assignment_base_sha === commit?.base_sha &&
    commit?.sha === own.sha &&
    commit.tree_sha === own.tree_sha &&
    Array.isArray(own.paths)
  ) {
    const paths = own.paths.filter(validChangedPath);
    if (paths.length === own.paths.length) return { paths, complete: true };
  }
  const inventory = object(
    delivery.evidence.find(
      (e) =>
        e.kind === "diff" &&
        object(e.details)?.role_rule_inventory !== undefined,
    )?.details,
  )?.role_rule_inventory;
  const i = object(inventory);
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
    !Array.isArray(i.changes)
  )
    return undefined;
  const paths = i.changes
    .map((c: unknown) => object(c)?.path)
    .filter(validChangedPath);
  // Malformed entries restrict automatic merging; they cannot erase known matches.
  return { paths, complete: paths.length === i.changes.length && !ownEntry };
}

/** Complete evidence is required to establish automatic merge eligibility. */
export function autoRiskPaths(
  delivery: Delivery,
): readonly string[] | undefined {
  const evidence = autoRiskPathEvidence(delivery);
  return evidence?.complete ? evidence.paths : undefined;
}

/** Legacy A3 evidence boundary; Flow Lite handles missing paths as a readiness gate. */
export function autoRiskMergeReason(
  state: {
    readonly cards: readonly Pick<Card, "id" | "flow_version">[];
    readonly work_items?: readonly WorkItem[];
    readonly deliveries?: readonly Delivery[];
  },
  cardId: Card["id"] | undefined,
): string | undefined {
  const card = state.cards.find((c) => c.id === cardId);
  if (!card || !flowAtLeast(card, 4)) return undefined;
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
