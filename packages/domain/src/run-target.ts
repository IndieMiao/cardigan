import {
  type PrecheckState,
  verificationPrecheckPending,
} from "./delivery-precheck.js";
import type { Assignment, Delivery, WorkItem } from "./entities.js";

interface RunTargetIndex {
  /** First work item per id, matching `Array.prototype.find`. */
  readonly items: ReadonlyMap<string, WorkItem>;
  /** Live non-completion deliveries: work item id → cards of that work item id. */
  readonly targets: ReadonlyMap<string, ReadonlySet<string>>;
  /** Live completion requests: requested verifier id → cards of the delivery's work item. */
  readonly completions: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * C-221: state collections are immutable snapshots — every change produces new
 * arrays (Store snapshots, reducers and fixtures all copy) — so an index keyed
 * by the identity of both arrays can never observe stale contents. A rolled-back
 * transaction hands out the previous arrays again, which still map to their own
 * index. Weak keys let unused snapshots and their indexes be collected.
 */
const indexes = new WeakMap<
  readonly Delivery[],
  WeakMap<readonly WorkItem[], RunTargetIndex>
>();

function buildIndex(
  work_items: readonly WorkItem[],
  deliveries: readonly Delivery[],
): RunTargetIndex {
  const items = new Map<string, WorkItem>();
  const cards = new Map<string, Set<string>>();
  for (const w of work_items) {
    if (!items.has(w.id)) items.set(w.id, w);
    const set = cards.get(w.id) ?? new Set<string>();
    set.add(w.card_id);
    cards.set(w.id, set);
  }
  const targets = new Map<string, ReadonlySet<string>>();
  const completions = new Map<string, Set<string>>();
  for (const delivery of deliveries) {
    if (delivery.status === "superseded") continue;
    const owners = cards.get(delivery.work_item_id);
    if (!owners) continue;
    if (delivery.kind !== "card_completion") {
      targets.set(delivery.work_item_id, owners);
      continue;
    }
    for (const verifier of delivery.requested_verifiers) {
      const set = completions.get(verifier) ?? new Set<string>();
      for (const card of owners) set.add(card);
      completions.set(verifier, set);
    }
  }
  return { items, targets, completions };
}

function runTargetIndex(state: {
  readonly work_items: readonly WorkItem[];
  readonly deliveries: readonly Delivery[];
}): RunTargetIndex {
  let byItems = indexes.get(state.deliveries);
  if (!byItems) {
    byItems = new WeakMap();
    indexes.set(state.deliveries, byItems);
  }
  let index = byItems.get(state.work_items);
  if (!index) {
    index = buildIndex(state.work_items, state.deliveries);
    byItems.set(state.work_items, index);
  }
  return index;
}

/**
 * Verification Runs need a current target, regardless of their trigger or role:
 * a non-superseded delivery of the same card that is either the target work
 * item's (non-completion) delivery, or a completion request naming this item.
 * Lookups are keyed (C-221) instead of scanning deliveries × work items.
 */
export function hasRunTarget(
  assignment: Assignment,
  state: PrecheckState,
): boolean {
  if (assignment.scope !== "work_item") return true;
  const index = runTargetIndex(state);
  const item = index.items.get(assignment.work_item_id);
  if (!item) return false;
  if (item.kind !== "verify") return true;
  if (verificationPrecheckPending(state, item)) return false;
  return item.target_work_item_id
    ? index.targets.get(item.target_work_item_id)?.has(item.card_id) === true
    : index.completions.get(item.id)?.has(item.card_id) === true;
}
