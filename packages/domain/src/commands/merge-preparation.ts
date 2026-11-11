import type { Actor, Event } from "../entities.js";
import type { CardId, DeliveryId } from "../ids.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { prepareMergePlan } from "./merge.js";

const readinessEvents = new Set([
  "merge_preparation_recorded",
  "merge_check_queued",
  "merge_check_started",
  "merge_check_finished",
  "merge_check_requeued",
]);

/** A host-verified noop makes the confirmation visible; it never authorizes publication. */
export function hasVerifiedMergeNoop(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
): boolean {
  const latest = events
    .filter(
      (e) =>
        e.card_id === card &&
        readinessEvents.has(e.type) &&
        (e.payload as { completion_id?: string } | null)?.completion_id ===
          completion,
    )
    .sort((a, b) => b.seq - a.seq)[0];
  return (
    latest?.type === "merge_preparation_recorded" &&
    latest.actor.kind === "system" &&
    (latest.payload as { noop?: boolean }).noop === true
  );
}

/** Only the host records Git ancestry verification, bound to the current completion. */
export function recordMergePreparation(
  state: CommandState,
  actor: Actor,
  p: {
    card_id: CardId;
    completion_id: DeliveryId;
    base_sha: string;
    noop: boolean;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "record_merge_preparation", ports, (d) => {
    ensure(
      state.project_settings?.merge_gate_enabled,
      "illegal_transition",
      "Merge gate is not enabled",
    );
    const plan = unwrap(prepareMergePlan(state, p.card_id));
    ensure(
      plan.completion_id === p.completion_id,
      "stale_target",
      "Preparation belongs to an older completion",
    );
    ensure(
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(p.base_sha) &&
        typeof p.noop === "boolean",
      "validation_failed",
      "Invalid merge preparation",
    );
    const latest = state.events
      .filter(
        (e) =>
          e.card_id === p.card_id &&
          readinessEvents.has(e.type) &&
          (e.payload as { completion_id?: string } | null)?.completion_id ===
            p.completion_id,
      )
      .sort((a, b) => b.seq - a.seq)[0];
    const previous = latest?.payload as
      | { noop?: boolean; base_sha?: string }
      | undefined;
    if (
      latest?.type === "merge_preparation_recorded" &&
      previous?.noop === p.noop &&
      previous.base_sha === p.base_sha
    )
      return p;
    // Ordinary candidates already have check events. Only record their preparation
    // when revoking a previous noop, so normal ticks do not produce extra events.
    if (
      !p.noop &&
      !hasVerifiedMergeNoop(state.events, p.card_id, p.completion_id)
    )
      return p;
    d.emit(
      "merge_preparation_recorded",
      p.card_id,
      { ...p },
      {
        type: "status_change",
        body: p.noop
          ? "主机已验证交付均在基线中，无需合并检查；仍须按原规则确认。"
          : "合并候选已变化，需要重新确认检查结果。",
      },
    );
    return p;
  });
}
