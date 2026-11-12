import type { Actor, Decision, Event, MergeCheckView } from "../entities.js";
import type { CardId, DecisionId, DeliveryId } from "../ids.js";
import {
  attempt,
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { mergeContext, prepareMergePlan } from "./merge.js";

/** The latest check of the confirmation's current completion, when it failed or timed out. */
export function failedCurrentMergeCheck(
  state: CommandState,
  decision: Decision,
): MergeCheckView | undefined {
  if (
    decision.trigger !== "merge_confirmation" ||
    !decision.card_id ||
    decision.kind !== "approve" ||
    !("delivery_id" in decision.target)
  )
    return undefined;
  const card_id = decision.card_id;
  const context = attempt(() => mergeContext(state, card_id));
  if (!context.ok || context.value.target.id !== decision.target.delivery_id)
    return undefined;
  const check = latestMergeCheck(
    state.events,
    decision.card_id,
    context.value.target.id,
  );
  return check && ["failed", "timed_out"].includes(check.status)
    ? check
    : undefined;
}
/** Only the current failed completion can withdraw an existing merge approval. */
export function failedConfirmedMergeCheck(
  state: CommandState,
  decision: Decision,
): MergeCheckView | undefined {
  return decision.status === "resolved" &&
    decision.resolution?.option === "merge"
    ? failedCurrentMergeCheck(state, decision)
    : undefined;
}

const types = [
  "merge_check_queued",
  "merge_check_started",
  "merge_check_finished",
  "merge_check_requeued",
];
export function latestMergeCheck(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
  tree?: string,
): MergeCheckView | undefined {
  const event = events
    .filter((e) => {
      const p = e.payload as Partial<MergeCheckView> | null;
      return (
        e.card_id === card &&
        types.includes(e.type) &&
        p?.completion_id === completion &&
        (!tree || p.tree_sha === tree)
      );
    })
    .sort((a, b) => b.seq - a.seq)[0];
  if (!event) return undefined;
  return {
    ...(event.payload as unknown as MergeCheckView),
    updated_at: event.created_at,
  };
}
export function hasPassedMergeCheck(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
  tree: string,
): boolean {
  return events.some((e) => {
    const p = e.payload as Partial<MergeCheckView> | null;
    return (
      e.card_id === card &&
      e.type === "merge_check_finished" &&
      e.actor.kind === "system" &&
      p?.completion_id === completion &&
      p.tree_sha === tree &&
      p.status === "passed"
    );
  });
}
type CheckUpdate = Pick<
  MergeCheckView,
  "attempt_id" | "completion_id" | "candidate_sha" | "tree_sha"
> & {
  readonly card_id: CardId;
} & (
    | { readonly status: "queued" | "running" }
    | {
        readonly status:
          | "passed"
          | "failed"
          | "timed_out"
          | "interrupted"
          | "executor_unreachable";
        readonly checks: MergeCheckView["checks"];
        readonly summary: string;
        readonly log_ref: string;
      }
  );
const sha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
export function recordMergeCheck(
  state: CommandState,
  actor: Actor,
  p: CheckUpdate,
  ports: CommandPorts,
) {
  return command(state, actor, "record_merge_check", ports, (d) => {
    ensure(
      [
        "queued",
        "running",
        "passed",
        "failed",
        "timed_out",
        "interrupted",
        "executor_unreachable",
      ].includes(p.status),
      "validation_failed",
      "Invalid check status",
    );
    ensure(
      state.project_settings?.merge_gate_enabled,
      "illegal_transition",
      "Merge gate is not enabled",
    );
    const completion_id =
      p.status === "queued"
        ? unwrap(prepareMergePlan(state, p.card_id)).completion_id
        : mergeContext(state, p.card_id).target.id;
    ensure(
      completion_id === p.completion_id,
      "stale_target",
      "Check belongs to an older completion",
    );
    ensure(
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(p.attempt_id) &&
        sha(p.candidate_sha) &&
        sha(p.tree_sha) &&
        p.candidate_sha.length === p.tree_sha.length,
      "validation_failed",
      "Invalid merge check identity",
    );
    const latest = latestMergeCheck(state.events, p.card_id, p.completion_id);
    const same =
      latest?.attempt_id === p.attempt_id &&
      latest.candidate_sha === p.candidate_sha &&
      latest.tree_sha === p.tree_sha;
    if (same && latest.status === p.status && !latest.recheck_requested) {
      if ("checks" in p)
        ensure(
          JSON.stringify(latest.checks) === JSON.stringify(p.checks) &&
            latest.summary === p.summary &&
            latest.log_ref === p.log_ref,
          "stale_target",
          "Check result cannot be overwritten",
        );
      return latest;
    }
    if (p.status === "queued") {
      ensure(
        !latest ||
          !["queued", "running"].includes(latest.status) ||
          latest.recheck_requested,
        "illegal_transition",
        "Another merge check is already queued or running",
      );
      const previous = latestMergeCheck(
        state.events,
        p.card_id,
        p.completion_id,
        p.tree_sha,
      );
      ensure(
        !previous ||
          previous.status === "interrupted" ||
          previous.status === "executor_unreachable" ||
          previous.recheck_requested,
        "illegal_transition",
        "This tree already has a result; a failed check requires an explicit recheck",
      );
      ensure(
        !state.events.some(
          (e) =>
            types.includes(e.type) &&
            (e.payload as Partial<MergeCheckView> | null)?.attempt_id ===
              p.attempt_id,
        ),
        "validation_failed",
        "Check attempt identifiers cannot be reused",
      );
    } else {
      ensure(
        same && !latest.recheck_requested,
        "stale_target",
        "Check does not match the current attempt",
      );
      ensure(
        p.status === "running"
          ? latest.status === "queued"
          : latest.status === "running" ||
              (latest.status === "queued" &&
                (p.status === "interrupted" ||
                  ((p.status === "failed" ||
                    p.status === "executor_unreachable") &&
                    p.checks.length === 0))),
        "illegal_transition",
        "Invalid merge check transition",
      );
    }
    if ("checks" in p) {
      ensure(
        p.summary.length <= 16000 &&
          /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.log$/u.test(p.log_ref) &&
          p.log_ref === `${p.attempt_id}.log`,
        "validation_failed",
        "Invalid check summary or log reference",
      );
      ensure(
        p.checks.every(
          (c) =>
            c.name.trim() &&
            [
              "passed",
              "failed",
              "timed_out",
              "interrupted",
              "not_run",
            ].includes(c.status) &&
            (c.exit_code === undefined ||
              c.exit_code === null ||
              Number.isSafeInteger(c.exit_code)) &&
            (c.duration_ms === undefined ||
              (Number.isFinite(c.duration_ms) && c.duration_ms >= 0)),
        ),
        "validation_failed",
        "Invalid per-command check result",
      );
      ensure(
        p.status !== "passed" ||
          (p.checks.length > 0 &&
            p.checks.every((c) => c.status === "passed" && c.exit_code === 0)),
        "invariant_violation",
        "A passed check must have only successful commands",
      );
    }
    const value: MergeCheckView = {
      attempt_id: p.attempt_id,
      completion_id: p.completion_id,
      candidate_sha: p.candidate_sha,
      tree_sha: p.tree_sha,
      status: p.status,
      checks: "checks" in p ? p.checks : [],
      updated_at: d.now,
      ...("checks" in p ? { summary: p.summary, log_ref: p.log_ref } : {}),
    };
    const type =
      p.status === "queued"
        ? "merge_check_queued"
        : p.status === "running"
          ? "merge_check_started"
          : "merge_check_finished";
    d.emit(
      type,
      p.card_id,
      {
        ...value,
        checks: value.checks.map((c) => ({ ...c })),
        ...("checks" in p ? { result: p.status } : {}),
      },
      {
        type: "status_change",
        body: `合并检查 ${p.status}${"checks" in p && p.summary ? `：${p.summary}` : ""}`,
      },
    );
    return value;
  });
}
export function recheckMerge(
  state: CommandState,
  actor: Actor,
  p: { readonly card_id: CardId },
  ports: CommandPorts,
) {
  return command(state, actor, "recheck_merge", ports, (d) => {
    ensure(
      state.project_settings?.merge_gate_enabled,
      "illegal_transition",
      "Merge gate is not enabled",
    );
    d.card(p.card_id);
    const result = requeueMergeCheck(d, p.card_id);
    if (actor.kind === "assignment")
      d.emit("host_ops_action_taken", p.card_id, {
        tool: "host_ops_recheck_merge",
        target_id: p.card_id,
        reason: "Retry failed or timed-out merge check",
      });
    return result;
  });
}
/**
 * Queue the current completion's failed or timed-out candidate again. Shared
 * by the human `recheck_merge` and PM Ops (`resolve_delegated_decision`
 * option `recheck`, §7.4); `delegated` records PM's reason and notice.
 */
export function requeueMergeCheck(
  d: CommandDraft,
  card_id: CardId,
  delegated?: {
    readonly decision_id: DecisionId;
    readonly rationale: string;
    readonly notice: string;
    readonly proxy_authority: string;
  },
) {
  const plan = unwrap(prepareMergePlan(d.state, card_id));
  const latest = latestMergeCheck(d.state.events, card_id, plan.completion_id);
  ensure(
    latest && ["failed", "timed_out"].includes(latest.status),
    "illegal_transition",
    "Only a failed or timed-out current completion can be rechecked",
  );
  const value: MergeCheckView = {
    ...latest,
    status: "queued",
    checks: [],
    recheck_requested: true,
    updated_at: d.now,
  };
  d.emit(
    "merge_check_requeued",
    card_id,
    {
      ...value,
      checks: [],
      ...(delegated
        ? {
            via: "delegated",
            decision_id: delegated.decision_id,
            rationale: delegated.rationale,
            notice: delegated.notice,
            proxy_authority: delegated.proxy_authority,
          }
        : {}),
    },
    {
      type: "status_change",
      body: delegated
        ? `项目经理已请求重新检查合并候选：${delegated.rationale}`
        : "已请求重新检查合并候选",
    },
  );
  return value;
}
