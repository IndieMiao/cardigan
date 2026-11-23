import type { GitRef } from "@cardigan/domain";
import { parseId } from "@cardigan/domain";
import type { Store } from "@cardigan/store";

/**
 * C-637 / Q-1233 (owner, 2026-11-23): candidate and precheck refs in the
 * central repository are kept until their card has ended (done or cancelled)
 * for 14 days. "Ended for 14 days" is measured from the card's latest event,
 * so any later activity on the card restarts the period. Delivery, backup and
 * incoming refs never expire here, and a ref whose owner cannot be resolved
 * (merge batches, unknown names) is always kept.
 */
export const DEFAULT_CENTRAL_REF_RETENTION_MS = 14 * 86_400_000;
export const RETAINED_REF_PREFIXES = [
  "refs/cardigan/candidates/",
  "refs/cardigan/prechecks/",
] as const;

export interface RefOwners {
  /** Cards that ended and have been quiet since before the cutoff. */
  readonly expiredCards: ReadonlySet<string>;
  readonly assignmentCard: ReadonlyMap<string, string>;
  readonly deliveryCard: ReadonlyMap<string, string>;
  readonly precheckCard: ReadonlyMap<string, string>;
}

const sha = "[a-f0-9]{40}(?:[a-f0-9]{24})?";
const assignmentHead = new RegExp(
  `^refs/cardigan/(?:prechecks|candidates)/([^/]+)/(${sha})$`,
  "u",
);
const recovery = /^refs\/cardigan\/candidates\/recovery\/([^/]+)$/u;
const precheck = /^refs\/cardigan\/candidates\/precheck-([A-Za-z0-9_-]+)$/u;
const macos = new RegExp(
  `^refs/cardigan/candidates/macos-([^/]+)-(${sha})$`,
  "u",
);
const single = /^refs\/cardigan\/candidates\/([^/]+)$/u;

const normalized = (
  kind: "assignment" | "delivery",
  id: string | undefined,
) => {
  const parsed = parseId(kind, id);
  return parsed.ok ? (parsed.value.id as string) : undefined;
};

/** The card a retained ref belongs to, or undefined when it is not ours to judge. */
export function refCard(ref: string, owners: RefOwners): string | undefined {
  const head = assignmentHead.exec(ref);
  if (head) {
    const id = normalized("assignment", head[1]);
    return id && owners.assignmentCard.get(id);
  }
  const restored = recovery.exec(ref);
  if (restored) {
    const id = normalized("assignment", restored[1]);
    return id && owners.assignmentCard.get(id);
  }
  const attempt = precheck.exec(ref)?.[1];
  if (attempt) return owners.precheckCard.get(attempt);
  const mac = macos.exec(ref);
  if (mac) {
    const id = normalized("delivery", mac[1]);
    return id && owners.deliveryCard.get(id);
  }
  const completion = normalized("delivery", single.exec(ref)?.[1]);
  return completion && owners.deliveryCard.get(completion);
}

export function expiredRefs(
  refs: readonly GitRef[],
  owners: RefOwners,
): readonly GitRef[] {
  return refs.filter(({ ref }) => {
    if (!RETAINED_REF_PREFIXES.some((prefix) => ref.startsWith(prefix)))
      return false;
    const card = refCard(ref, owners);
    return card !== undefined && owners.expiredCards.has(card);
  });
}

/** Owners from the database; `cutoff` is an ISO timestamp. */
export function storeRefOwners(
  store: Pick<Store, "uow" | "database">,
  project_id: string,
  cutoff: string,
): RefOwners {
  return store.uow.read((tx) => {
    const latest = new Map(
      (
        store.database
          .prepare(
            "SELECT card_id, MAX(json_extract(doc, '$.created_at')) AS at " +
              "FROM events WHERE project_id = ? AND card_id IS NOT NULL GROUP BY card_id",
          )
          .all(project_id) as { card_id: string; at: string | null }[]
      ).map((row) => [row.card_id, row.at]),
    );
    const cutoffMs = Date.parse(cutoff);
    const expiredCards = new Set(
      tx.cards
        .list(project_id as never)
        .filter((card) => {
          if (card.status !== "done" && card.status !== "cancelled")
            return false;
          const at = Date.parse(latest.get(card.id) ?? card.created_at);
          return Number.isFinite(at) && at < cutoffMs;
        })
        .map((card) => card.id as string),
    );
    const itemCard = new Map(
      tx.work_items
        .list(project_id as never)
        .map((item) => [item.id as string, item.card_id as string]),
    );
    const assignmentCard = new Map<string, string>();
    for (const a of tx.assignments.list(project_id as never)) {
      const card =
        a.scope === "work_item" ? itemCard.get(a.work_item_id) : undefined;
      if (card) assignmentCard.set(a.id, card);
    }
    const deliveryCard = new Map<string, string>();
    for (const d of tx.deliveries.list(project_id as never)) {
      const card = itemCard.get(d.work_item_id);
      if (card) deliveryCard.set(d.id, card);
    }
    const precheckCard = new Map(
      (
        store.database
          .prepare(
            "SELECT json_extract(doc, '$.payload.attempt_id') AS attempt, card_id " +
              "FROM events WHERE project_id = ? AND type = 'precheck_queued' AND card_id IS NOT NULL",
          )
          .all(project_id) as { attempt: unknown; card_id: string }[]
      )
        .filter(
          (row): row is { attempt: string; card_id: string } =>
            typeof row.attempt === "string",
        )
        .map((row) => [row.attempt, row.card_id]),
    );
    return { expiredCards, assignmentCard, deliveryCard, precheckCard };
  });
}
