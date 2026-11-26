import type { Actor, MergeCheckView, Precheck } from "../entities.js";
import {
  eventsForCompletion,
  eventsOfType,
  eventsOfTypes,
} from "../event-index.js";
import { flowAtLeast } from "../flow.js";
import type { CardId, DeliveryId } from "../ids.js";
import { prechecks, validCheckFingerprints } from "../precheck.js";
import {
  attempt,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { type MergePlan, prepareMergePlan } from "./merge.js";
import { MERGE_CHECK_EVENTS } from "./merge-check-view.js";

/**
 * C-781: a queue-mode card check may reuse the author precheck that already
 * passed on the same head. Every condition is re-derived from the event log;
 * the host only supplies the names of its configured card-tier checks.
 */
export interface PrecheckReuseInput {
  readonly card_id: CardId;
  readonly completion_id: DeliveryId;
  /** New card-check attempt; its log only points at the precheck log. */
  readonly attempt_id: string;
  readonly precheck_attempt_id: string;
  /**
   * Card-tier checks the card check would otherwise run, each with the host
   * fingerprint of its current configuration (C-798).
   */
  readonly required_checks: readonly RequiredCardCheck[];
}
/** C-798: a card-tier check name and its current configuration fingerprint. */
export interface RequiredCardCheck {
  readonly name: string;
  readonly fingerprint: string;
}

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ATTEMPT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u;
/** Statuses that never produced a result for the completion. */
const NO_RESULT = new Set([
  "queued",
  "running",
  "interrupted",
  "executor_unreachable",
]);

export const PRECHECK_REUSE_SUMMARY =
  "沿用同一提交已通过的作者预检，未重复执行";

function validRequired(required: readonly RequiredCardCheck[]) {
  return validCheckFingerprints(
    Array.isArray(required)
      ? required.map((c) =>
          typeof c === "object" && c !== null
            ? { name: c.name, fingerprint: c.fingerprint }
            : c,
        )
      : required,
  );
}

/**
 * The passed precheck a card check may reuse, or undefined. Only:
 * - the merge gate with the merge queue (card checks never authorize merged,
 *   invariant 21) on a flow >= 3 card that is not on hold;
 * - a card with exactly one producer and one planned Git delivery;
 * - a completion that has no card check result yet (a failed, timed-out or
 *   rechecked completion always runs a real check);
 * - the latest precheck attempt of that producer on exactly the delivered
 *   head (C-798): it must be a system-recorded `passed` with every required
 *   card-tier check passed. A later failed, timed-out, interrupted, queued or
 *   running attempt never lets an earlier pass count;
 * - every required check ran with the configuration it has now (C-798): the
 *   precheck's recorded fingerprint equals the current one. Prechecks recorded
 *   without fingerprints are never reused.
 */
export function reusablePrecheck(
  state: CommandState,
  card_id: CardId,
  required_checks: readonly RequiredCardCheck[],
): { readonly plan: MergePlan; readonly precheck: Precheck } | undefined {
  if (
    !state.project_settings?.merge_gate_enabled ||
    !state.project_settings.merge_queue ||
    !validRequired(required_checks)
  )
    return undefined;
  const card = state.cards.find((c) => c.id === card_id);
  if (!card || card.hold || !flowAtLeast(card, 3)) return undefined;
  const planned = attempt(() => unwrap(prepareMergePlan(state, card_id)));
  if (!planned.ok) return undefined;
  const plan = planned.value;
  const [delivery, ...others] = plan.deliveries;
  if (!delivery || others.length) return undefined;
  const producers = state.work_items.filter(
    (w) =>
      w.card_id === card_id && w.kind === "produce" && w.status !== "cancelled",
  );
  if (producers.length !== 1 || producers[0]?.id !== delivery.work_item_id)
    return undefined;
  const checked = eventsForCompletion(state.events, plan.completion_id).some(
    (e) => {
      const p = e.payload as Partial<MergeCheckView> | null;
      return (
        e.card_id === card_id &&
        MERGE_CHECK_EVENTS.includes(e.type) &&
        p?.completion_id === plan.completion_id &&
        (p.recheck_requested === true ||
          (typeof p.status === "string" && !NO_RESULT.has(p.status)))
      );
    },
  );
  if (checked) return undefined;
  // C-798: only the newest attempt on this head counts. The projection keeps
  // attempts in the order they were first recorded, each at its latest state.
  const latest = prechecks(state.events, card_id).findLast(
    (p) =>
      p.work_item_id === delivery.work_item_id && p.head_sha === delivery.sha,
  );
  if (latest?.status !== "passed") return undefined;
  // That latest state is this project's system `precheck_finished` record.
  const recorded = eventsOfType(state.events, "precheck_finished").some(
    (e) =>
      (e.payload as unknown) === latest &&
      e.card_id === card_id &&
      e.type === "precheck_finished" &&
      e.actor.kind === "system" &&
      e.actor.project_id === state.project_id,
  );
  const p = latest;
  const fingerprints = p.check_fingerprints;
  const precheck =
    recorded &&
    p.card_id === card_id &&
    typeof p.attempt_id === "string" &&
    ATTEMPT.test(p.attempt_id) &&
    typeof p.candidate_sha === "string" &&
    SHA.test(p.candidate_sha) &&
    typeof p.tree_sha === "string" &&
    SHA.test(p.tree_sha) &&
    typeof p.base_sha === "string" &&
    SHA.test(p.base_sha) &&
    Array.isArray(p.checks) &&
    p.checks.length > 0 &&
    p.checks.every((c) => c.status === "passed" && c.exit_code === 0) &&
    validCheckFingerprints(fingerprints) &&
    required_checks.every(
      (required) =>
        p.checks?.some((c) => c.name === required.name) &&
        fingerprints?.some(
          (f) =>
            f.name === required.name && f.fingerprint === required.fingerprint,
        ),
    )
      ? p
      : undefined;
  return precheck ? { plan, precheck } : undefined;
}

/**
 * Records the card check of the current completion as an explicit reuse of a
 * passed precheck (invariant 14: a bound reuse, not a new execution). The
 * record keeps the precheck's own candidate, tree and baseline and carries no
 * executor or external run, so no GitHub run is ever rebound to it (C-328).
 * It is a `level=card` pass: it never authorizes merged; the batch check
 * still decides publication (invariant 21).
 */
export function reusePrecheckForCardCheck(
  state: CommandState,
  actor: Actor,
  p: PrecheckReuseInput,
  ports: CommandPorts,
) {
  return command(state, actor, "reuse_precheck_check", ports, (d) => {
    ensure(
      typeof p.attempt_id === "string" &&
        ATTEMPT.test(p.attempt_id) &&
        typeof p.precheck_attempt_id === "string" &&
        ATTEMPT.test(p.precheck_attempt_id) &&
        validRequired(p.required_checks),
      "validation_failed",
      "Invalid precheck reuse",
    );
    const reuse = reusablePrecheck(state, p.card_id, p.required_checks);
    ensure(
      reuse &&
        reuse.plan.completion_id === p.completion_id &&
        reuse.precheck.attempt_id === p.precheck_attempt_id,
      "illegal_transition",
      "该完成申请不能沿用作者预检",
    );
    ensure(
      !eventsOfTypes(state.events, MERGE_CHECK_EVENTS).some(
        (e) =>
          (e.payload as Partial<MergeCheckView> | null)?.attempt_id ===
          p.attempt_id,
      ),
      "validation_failed",
      "Check attempt identifiers cannot be reused",
    );
    const { plan, precheck } = reuse;
    const [delivery] = plan.deliveries;
    const value: MergeCheckView = {
      level: "card",
      attempt_id: p.attempt_id,
      completion_id: p.completion_id,
      candidate_sha: precheck.candidate_sha as string,
      tree_sha: precheck.tree_sha as string,
      base_sha: precheck.base_sha as string,
      status: "passed",
      checks: (precheck.checks ?? []).map((c) => ({
        name: c.name,
        status: c.status,
        exit_code: 0,
        ...(c.duration_ms !== undefined ? { duration_ms: c.duration_ms } : {}),
      })),
      summary: PRECHECK_REUSE_SUMMARY,
      log_ref: `${p.attempt_id}.log`,
      updated_at: d.now,
      reused_precheck: {
        attempt_id: precheck.attempt_id,
        work_item_id: precheck.work_item_id,
        head_sha: precheck.head_sha,
        ...(delivery ? { delivery_id: delivery.delivery_id } : {}),
      },
    };
    d.emit(
      "merge_check_finished",
      p.card_id,
      {
        ...value,
        checks: value.checks.map((c) => ({ ...c })),
        reused_precheck: { ...value.reused_precheck },
        result: "passed",
      },
      {
        type: "status_change",
        body: `合并检查 passed：沿用作者预检 ${precheck.attempt_id}（提交 ${precheck.head_sha}）的通过结果，未重复执行；日志：get_check_log(card_id=${p.card_id}, attempt_id=${precheck.attempt_id})`,
      },
    );
    return value;
  });
}
