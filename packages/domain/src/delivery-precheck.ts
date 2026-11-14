import type {
  Card,
  Delivery,
  DeliveryPrecheck,
  Event,
  WorkItem,
} from "./entities.js";
import type { ProjectId } from "./ids.js";
import type { ProjectPreferences } from "./preferences.js";

export type { DeliveryPrecheck } from "./entities.js";

export interface PrecheckState {
  readonly project_id?: ProjectId;
  readonly cards?: readonly Card[];
  readonly work_items: readonly WorkItem[];
  readonly deliveries: readonly Delivery[];
  readonly events?: readonly Event[];
  readonly project_preferences?: readonly ProjectPreferences[];
}
const indexes = new WeakMap<
  readonly Event[],
  ReadonlyMap<string, DeliveryPrecheck>
>();
export function latestDeliveryPrecheck(
  events: readonly Event[],
  delivery: Delivery,
): DeliveryPrecheck | undefined {
  let index = indexes.get(events);
  if (!index) {
    const latest = new Map<string, { seq: number; check: DeliveryPrecheck }>();
    for (const e of events) {
      if (
        ![
          "delivery_precheck_requested",
          "delivery_precheck_updated",
          "delivery_precheck_settled",
        ].includes(e.type) ||
        (e.type !== "delivery_precheck_requested" && e.actor.kind !== "system")
      )
        continue;
      const c = e.payload as unknown as DeliveryPrecheck | null;
      if (!c?.delivery_id || !c.subject) continue;
      if ((latest.get(c.delivery_id)?.seq ?? -1) < e.seq)
        latest.set(c.delivery_id, { seq: e.seq, check: c });
    }
    index = new Map(
      [...latest].map(([id, value]) => {
        const { via: _via, ...check } = value.check as DeliveryPrecheck & {
          via?: unknown;
        };
        return [id, check];
      }),
    );
    indexes.set(events, index);
  }
  const check = index.get(delivery.id);
  return check?.subject.kind === delivery.subject.kind &&
    check.subject.value === delivery.subject.value
    ? check
    : undefined;
}
export function requiresDeliveryPrecheck(
  state: PrecheckState,
  delivery: Delivery,
): boolean {
  if (delivery.kind === "card_completion") return false;
  const item = state.work_items.find((w) => w.id === delivery.work_item_id);
  return (
    !!item &&
    !!state.cards?.some((c) => c.id === item.card_id && c.risk_tags?.length) &&
    state.work_items.some(
      (w) =>
        w.card_id === item.card_id &&
        w.kind === "verify" &&
        w.target_work_item_id === item.id &&
        w.role_id === "independent_reviewer" &&
        w.required &&
        w.status !== "cancelled" &&
        !w.replaced_by_work_item_id,
    )
  );
}
export function verificationPrecheckPending(
  state: PrecheckState,
  item: WorkItem,
): boolean {
  if (item.kind !== "verify" || !item.target_work_item_id) return false;
  const wait =
    item.role_id === "independent_reviewer" ||
    (item.role_id === "reviewer" &&
      state.project_preferences?.some(
        (p) =>
          p.id === state.project_id &&
          p.code_review_waits_for_precheck === true,
      ));
  if (!wait) return false;
  const target = state.deliveries.find(
    (d) =>
      d.work_item_id === item.target_work_item_id &&
      d.kind !== "card_completion" &&
      d.status !== "superseded",
  );
  if (!target) return false;
  const check = latestDeliveryPrecheck(state.events ?? [], target);
  const applicable = !!check || requiresDeliveryPrecheck(state, target);
  return (
    applicable &&
    !!wait &&
    (target.status === "rejected" || check?.status !== "passed")
  );
}
export function currentDeliveryPrechecks(
  state: PrecheckState,
  cardId: string,
): DeliveryPrecheck[] {
  return state.deliveries
    .filter(
      (d) =>
        d.status !== "superseded" &&
        d.kind !== "card_completion" &&
        state.work_items.some(
          (w) => w.id === d.work_item_id && w.card_id === cardId,
        ),
    )
    .flatMap((d) => {
      const c = latestDeliveryPrecheck(state.events ?? [], d);
      return c ? [c] : [];
    });
}
