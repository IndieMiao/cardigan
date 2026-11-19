import {
  type Assignment,
  type CommandState,
  type Delivery,
  eventsOfType,
  type Run,
} from "@cardigan/domain";
import type { BellAttempt } from "@cardigan/store";

/** Rechecked inside the final send transaction, after status and adapter queue waits. */
export function legacyRepairAuthority(
  state: CommandState,
  owner: Assignment,
  run: Run,
  target: Delivery,
) {
  const groups = state.decisions.filter(
    (q) =>
      q.status !== "withdrawn" &&
      q.review_limit_group?.delivery_id === target.id &&
      q.review_limit_group.target_sha === target.subject.value,
  );
  if (!groups.length) return;
  const resolution = eventsOfType(state.events, "decision_resolved").findLast(
    (e) => {
      const p = e.payload as Record<string, unknown> | null;
      return groups.some((q) => q.id === p?.decision_id);
    },
  )?.payload as Record<string, unknown> | undefined;
  return (
    owner.work_item_id === target.work_item_id &&
    target.status === "rejected" &&
    !state.deliveries.some((d) => d.supersedes === target.id) &&
    resolution?.rework_run_id === run.id
  );
}

// v42 did not store a send boundary. The dispatcher's pre-wake failure audit
// and the failed row committed together, but that audit had no attempt ID.
// Require an unambiguous one-to-one match; direct launches have no such audit.
export function legacyRepairWake(
  state: CommandState,
  owner: Assignment,
  run: Run,
  target: Delivery,
  history: readonly BellAttempt[],
) {
  if (history.length && history.every((t) => t.review_wake)) return;
  const authority = legacyRepairAuthority(state, owner, run, target);
  if (authority === undefined) return;
  if (!authority || !history.length) return "reconcile";
  const audits = eventsOfType(
    state.events,
    "bell_delivery_attempt_failed",
  ).filter(
    (e) => e.actor.kind === "system" && e.actor.project_id === state.project_id,
  );
  const key = (ids: readonly string[]) => JSON.stringify([...ids].sort());
  const proven = history.every((t) => {
    if (t.outcome !== "failed") return false;
    if (t.review_wake)
      return (
        t.review_wake.delivery_id === target.id &&
        t.review_wake.target_sha === target.subject.value &&
        !t.review_wake.sending_at
      );
    const notes = key(t.notification_ids);
    if (
      history.filter(
        (other) =>
          other.finished_at === t.finished_at &&
          key(other.notification_ids) === notes,
      ).length !== 1
    )
      return false;
    const matched = audits.filter((e) => {
      const p = e.payload as Record<string, unknown> | null;
      return (
        e.created_at === t.finished_at &&
        p?.assignment_id === owner.id &&
        p.run_id === run.id &&
        Array.isArray(p.notification_ids) &&
        key(p.notification_ids) === notes
      );
    });
    const audit = matched[0]?.payload as Record<string, unknown> | undefined;
    return (
      matched.length === 1 &&
      audit?.reason === "before_wake_failed" &&
      !audit.unconfirmed_attempt_id
    );
  });
  return proven ? "unsent" : "reconcile";
}
