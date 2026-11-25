import type { Actor, Delivery, WorkItem } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import type { AssignmentId, DeliveryId } from "../ids.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

/**
 * C-630: what a readonly verifier checks out for its current target.
 *
 * - `git`: the current delivery is a Git commit; check out that commit.
 * - `artifact`: the current delivery has no Git commit (artifact or document).
 *   Its recorded source commit is the latest earlier Git delivery of the same
 *   product (for example the commit the APK was built from); without one the
 *   verifier reads the card's baseline HEAD. Never a substitute Git delivery.
 */
export type ReadonlyReviewTarget =
  | {
      readonly kind: "git";
      readonly delivery_id: DeliveryId;
      readonly sha: string;
    }
  | {
      readonly kind: "artifact";
      readonly delivery_id: DeliveryId;
      readonly source?: {
        readonly delivery_id: DeliveryId;
        readonly sha: string;
      };
    };

const deliveryNumber = (d: Delivery) => Number(d.id.slice(2));

/** Select from persisted deliveries only; the same rule for host and domain. */
export function readonlyReviewTarget(
  deliveries: readonly Delivery[],
  item: WorkItem,
): ReadonlyReviewTarget | undefined {
  if (item.kind !== "verify") return undefined;
  const target = item.target_work_item_id;
  const completion = target === undefined;
  const current = deliveries
    .filter(
      (d) =>
        d.status !== "superseded" &&
        (target
          ? d.work_item_id === target && d.kind !== "card_completion"
          : d.kind === "card_completion" &&
            d.requested_verifiers.includes(item.id)),
    )
    .sort((a, b) => deliveryNumber(b) - deliveryNumber(a))[0];
  if (!current) return undefined;
  if (current.subject.kind === "git_head")
    return {
      kind: "git",
      delivery_id: current.id,
      sha: current.subject.value,
    };
  const source = deliveries
    .filter(
      (d) =>
        d.work_item_id === current.work_item_id &&
        (d.kind === "card_completion") === completion &&
        d.subject.kind === "git_head" &&
        deliveryNumber(d) < deliveryNumber(current),
    )
    .sort((a, b) => deliveryNumber(b) - deliveryNumber(a))[0];
  return {
    kind: "artifact",
    delivery_id: current.id,
    ...(source
      ? { source: { delivery_id: source.id, sha: source.subject.value } }
      : {}),
  };
}

export interface ReadonlyCheckoutObservation {
  readonly assignment_id: AssignmentId;
  readonly delivery_id: DeliveryId;
  /** The commit the host actually checked out. */
  readonly sha: string;
  readonly source: "baseline" | "source_commit";
  /** Baseline remote ref, e.g. `origin/main`; required for `baseline`. */
  readonly baseline_ref?: string;
}

export const READONLY_CHECKOUT_EVENT = "readonly_checkout_recorded";

/**
 * Host-only: record which commit a readonly verifier of an artifact delivery
 * was given. A stale observation (the target moved on) records nothing; the
 * same assignment, delivery and commit are recorded once.
 */
export function recordReadonlyCheckout(
  state: CommandState,
  actor: Actor,
  p: ReadonlyCheckoutObservation,
  ports: CommandPorts,
) {
  return command(state, actor, "record_readonly_checkout", ports, (d) => {
    ensure(
      /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(p.sha) &&
        (p.source === "source_commit" ||
          (p.source === "baseline" &&
            typeof p.baseline_ref === "string" &&
            p.baseline_ref.length <= 255 &&
            /^origin\/[^\s\\]+$/u.test(p.baseline_ref))),
      "validation_failed",
      "Invalid readonly checkout observation",
    );
    const assignment = d.get("assignments", p.assignment_id);
    ensure(
      assignment.scope === "work_item",
      "validation_failed",
      "Readonly checkout requires a work-item Assignment",
    );
    const item = d.get("work_items", assignment.work_item_id);
    ensure(
      item.kind === "verify",
      "validation_failed",
      "Readonly checkout requires a verification work item",
    );
    if (
      assignment.status !== "active" ||
      item.assignment_id !== assignment.id ||
      item.status === "cancelled"
    )
      return false;
    const target = readonlyReviewTarget(d.list("deliveries"), item);
    if (
      target?.kind !== "artifact" ||
      target.delivery_id !== p.delivery_id ||
      (p.source === "source_commit"
        ? target.source?.sha.toLowerCase() !== p.sha
        : target.source !== undefined)
    )
      return false;
    if (
      eventsOfType(d.state.events, READONLY_CHECKOUT_EVENT).some((e) => {
        const seen = e.payload as Record<string, unknown> | null;
        return (
          e.actor.kind === "system" &&
          seen?.assignment_id === p.assignment_id &&
          seen.delivery_id === p.delivery_id &&
          seen.sha === p.sha
        );
      })
    )
      return false;
    const delivery = d.get("deliveries", p.delivery_id);
    const checkout =
      p.source === "baseline"
        ? `基线 ${p.baseline_ref} 的当前 HEAD ${p.sha}`
        : `制品记录的源码提交 ${p.sha}（来自 ${target.source?.delivery_id}）`;
    d.emit(
      READONLY_CHECKOUT_EVENT,
      item.card_id,
      {
        assignment_id: assignment.id,
        work_item_id: item.id,
        delivery_id: p.delivery_id,
        subject_kind: delivery.subject.kind,
        source: p.source,
        sha: p.sha,
        ...(p.source === "baseline"
          ? { baseline_ref: p.baseline_ref ?? null }
          : { source_delivery_id: target.source?.delivery_id ?? null }),
      },
      {
        type: "system",
        body: `${p.delivery_id} 是制品交付，没有 Git 提交；${item.id} 的只读工作区检出${checkout}。`,
        delivery_id: p.delivery_id,
        work_item_id: item.id,
      },
    );
    return true;
  });
}
