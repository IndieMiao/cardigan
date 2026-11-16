import type { Actor, Decision, Event, MergeCheckView } from "../entities.js";
import { flowAtLeast } from "../flow.js";
import type { CardId, DecisionId, DeliveryId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  attempt,
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { latestMergeCheck, MERGE_CHECK_EVENTS } from "./merge-check-view.js";

export { latestMergeCheck } from "./merge-check-view.js";

import { mergeContext, prepareMergePlan } from "./merge.js";
import { reopenMerge } from "./merge-rework.js";
import { deliveryTree } from "./review-reuse.js";

/** A1: an internal system transition, never a decision on the human's behalf. */
function systemReturnFailedCheck(
  d: CommandDraft,
  card_id: CardId,
  check: MergeCheckView,
) {
  const context = mergeContext(d.state, card_id);
  const { card, target } = context;
  ensure(
    target.id === check.completion_id,
    "stale_target",
    "Completion changed",
  );
  const confirmations = d
    .list("decisions")
    .filter(
      (q) =>
        q.card_id === card.id &&
        q.trigger === "merge_confirmation" &&
        q.kind === "approve" &&
        "delivery_id" in q.target &&
        q.target.delivery_id === target.id,
    )
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)));
  reopenMerge(d, card, target, target.work_item_id, "request_changes");
  // C-46: preserve every original authorization field on a resolved approval.
  for (const q of confirmations) {
    if (q.status !== "resolved" || q.resolution?.option !== "merge") continue;
    d.put("decisions", {
      ...q,
      status: unwrap(transition("decision", q.status, "supersede")),
    });
  }
  const steps = check.checks
    .filter((c) => c.status === "failed" || c.status === "timed_out")
    .map((c) => c.name);
  const reason = [
    `合并检查 ${check.status}${steps.length ? `：${steps.join("、")}` : ""}`,
    // Legacy executors already supply a bounded, redacted host summary.
    // Keep its diagnostics when an explicit excerpt is not yet available.
    check.failure_excerpt || check.summary,
  ]
    .filter(Boolean)
    .join("\n");
  d.emit(
    "merge_changes_requested",
    card.id,
    {
      ...(confirmations[0] ? { decision_id: confirmations[0].id } : {}),
      product_deliveries: d
        .list("deliveries")
        .filter(
          (v) =>
            v.kind !== "card_completion" &&
            v.status !== "superseded" &&
            d.state.work_items.some(
              (w) => w.card_id === card.id && w.id === v.work_item_id,
            ),
        )
        .map((v) => ({
          delivery_id: v.id,
          sha: v.subject.value,
          tree_sha: deliveryTree(v) ?? null,
        })),
      completion_id: target.id,
      work_item_id: target.work_item_id,
      attempt_id: check.attempt_id,
      candidate_sha: check.candidate_sha,
      tree_sha: check.tree_sha,
      run_kind: "fix",
      reason,
      via: "system_rule",
      rule: "flow-v2/A1",
    },
    {
      type: "status_change",
      body: `系统退回修改：${reason}`,
      work_item_id: target.work_item_id,
    },
  );
}

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

/** C-115 / Q-158: trust structured supervisor results, never log prose. */
export function timeoutOnly(check: MergeCheckView | undefined): boolean {
  return (
    !!check &&
    (check.status === "timed_out" ||
      (check.status === "failed" &&
        check.checks.some((c) => c.status === "timed_out"))) &&
    check.checks.every((c) =>
      ["passed", "timed_out", "not_run", "skipped"].includes(c.status),
    )
  );
}
/** C-116: the source tag of the single automatic rerun after a timeout. */
export const TIMEOUT_AUTO_RERUN = "timeout_auto_rerun";
export const INFRA_AUTO_RERUN = "infra_auto_rerun";
/** Whether this completion used its shared timeout/infrastructure rerun. */
export function hasAutoRerun(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
): boolean {
  return events.some((e) => {
    const p = e.payload as {
      completion_id?: string;
      via?: string;
    } | null;
    return (
      e.card_id === card &&
      e.type === "merge_check_requeued" &&
      p?.completion_id === completion &&
      [TIMEOUT_AUTO_RERUN, INFRA_AUTO_RERUN].includes(p.via ?? "")
    );
  });
}

/** Compatibility for C-116 consumers and historical timeout events. */
export const hasTimeoutAutoRerun = hasAutoRerun;

export function hasPassedMergeCheck(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
  tree: string,
  base?: string,
): boolean {
  // Once this completion has baseline-bound checks, unbound historical passes
  // cannot bypass their publication guard. Legacy-only event streams retain
  // their old projection; the host still rechecks them before publication.
  const bound =
    base !== undefined &&
    events.some((e) => {
      const p = e.payload as Partial<MergeCheckView> | null;
      return (
        e.card_id === card &&
        MERGE_CHECK_EVENTS.includes(e.type) &&
        p?.completion_id === completion &&
        p.base_sha !== undefined
      );
    });
  return events.some((e) => {
    const p = e.payload as Partial<MergeCheckView> | null;
    return (
      e.card_id === card &&
      e.type === "merge_check_finished" &&
      e.actor.kind === "system" &&
      p?.completion_id === completion &&
      p.tree_sha === tree &&
      (base === undefined ||
        (!bound && p.base_sha === undefined) ||
        p.base_sha === base) &&
      p.status === "passed"
    );
  });
}
type CheckUpdate = Pick<
  MergeCheckView,
  | "attempt_id"
  | "completion_id"
  | "candidate_sha"
  | "tree_sha"
  | "base_sha"
  | "scope"
  | "failure_excerpt"
  | "external_run"
  | "executor"
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
        /** C-116: supervisor classification; see `MergeCheckView.timeout_only`. */
        readonly timeout_only?: boolean;
        /** A1b: trusted host classification, never derived from domain text. */
        readonly infra_flaky?: boolean;
      }
  );
const sha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
/** D1 uses the approved D4 default as its evidence ceiling, in UTF-8 bytes. */
export const FAILURE_EXCERPT_MAX_BYTES = 4 * 1024;
function safeFailureExcerpt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let bytes = 0;
  for (const point of value) {
    const code = point.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > FAILURE_EXCERPT_MAX_BYTES) return false;
  }
  // Format guard only: the trusted host must redact configured values before
  // calling this command. Domain cannot discover arbitrary secrets from prose.
  return (
    !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\r\t]/gu, "")) &&
    !/-----+(?:BEGIN|END) [A-Z ]*PRIVATE KEY-----+/u.test(value) &&
    !/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/u.test(value) &&
    !/authorization\s*:\s*bearer\s+(?!\[REDACTED\](?:\s|$))[^\s]+/iu.test(
      value,
    ) &&
    !/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*(?!\s*\[REDACTED\](?:[\s,;]|$))[^\s,;]+/iu.test(
      value,
    )
  );
}
function validExternalRun(
  value: unknown,
): value is NonNullable<MergeCheckView["external_run"]> {
  if (typeof value !== "object" || value === null) return false;
  const run = value as NonNullable<MergeCheckView["external_run"]>;
  return (
    Object.keys(run).every((key) =>
      [
        "provider",
        "run_id",
        "run_attempt",
        "html_url",
        "workflow_sha",
      ].includes(key),
    ) &&
    run.provider === "github" &&
    Number.isSafeInteger(run.run_id) &&
    run.run_id > 0 &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0 &&
    typeof run.workflow_sha === "string" &&
    /^[a-f0-9]{40}$/u.test(run.workflow_sha) &&
    typeof run.html_url === "string" &&
    new RegExp(
      `^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/${run.run_id}(?:/attempts/${run.run_attempt})?$`,
      "u",
    ).test(run.html_url)
  );
}
function sameExternalRun(
  a: MergeCheckView["external_run"],
  b: MergeCheckView["external_run"],
) {
  return a === undefined
    ? b === undefined
    : b !== undefined &&
        a.provider === b.provider &&
        a.run_id === b.run_id &&
        a.run_attempt === b.run_attempt &&
        a.html_url === b.html_url &&
        a.workflow_sha === b.workflow_sha;
}
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
    if (p.status === "queued")
      ensure(
        !d.card(p.card_id).hold,
        "illegal_transition",
        "卡片已暂停，请先解除暂停",
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
        (p.base_sha === undefined ||
          (sha(p.base_sha) && p.base_sha.length === p.tree_sha.length)) &&
        p.candidate_sha.length === p.tree_sha.length,
      "validation_failed",
      "Invalid merge check identity",
    );
    if (p.scope !== undefined)
      ensure(
        p.scope !== null &&
          typeof p.scope === "object" &&
          ["docs_only", "affected", "full"].includes(p.scope.kind) &&
          (p.scope.packages === undefined ||
            (p.scope.kind === "affected" &&
              Array.isArray(p.scope.packages) &&
              p.scope.packages.every(
                (path) =>
                  typeof path === "string" &&
                  /^(packages|apps)\/[a-z0-9-]+$/u.test(path),
              ))),
        "validation_failed",
        "Invalid merge check scope",
      );
    ensure(
      p.failure_excerpt === undefined || safeFailureExcerpt(p.failure_excerpt),
      "validation_failed",
      "Failure excerpt must be redacted and at most 4 KiB in UTF-8",
    );
    ensure(
      p.external_run === undefined || validExternalRun(p.external_run),
      "validation_failed",
      "Invalid external check run identity",
    );
    ensure(
      p.executor === undefined ||
        (p.executor !== null &&
          typeof p.executor === "object" &&
          Object.keys(p.executor).every((key) =>
            ["name", "type"].includes(key),
          ) &&
          typeof p.executor.name === "string" &&
          /^[a-z][a-z0-9_-]{0,31}$/u.test(p.executor.name) &&
          ["ssh", "github"].includes(p.executor.type)),
      "validation_failed",
      "Invalid check executor",
    );
    const latest = latestMergeCheck(state.events, p.card_id, p.completion_id);
    const same =
      latest?.attempt_id === p.attempt_id &&
      latest.candidate_sha === p.candidate_sha &&
      latest.tree_sha === p.tree_sha &&
      latest.base_sha === p.base_sha;
    if (same)
      ensure(
        latest.executor?.name === p.executor?.name &&
          latest.executor?.type === p.executor?.type,
        "stale_target",
        "Check executor cannot change within an attempt",
      );
    if (p.executor?.type === "github") {
      const unboundExit =
        same &&
        (latest.status === "queued" || latest.status === p.status) &&
        !latest.external_run &&
        (p.status === "executor_unreachable" || p.status === "interrupted") &&
        "checks" in p &&
        p.checks.length === 0;
      ensure(
        p.status === "queued" || unboundExit || p.external_run !== undefined,
        "validation_failed",
        "GitHub running and terminal checks require an external run",
      );
      ensure(
        p.external_run === undefined || p.external_run.run_attempt === 1,
        "validation_failed",
        "GitHub check reruns cannot be trusted",
      );
    }
    if (same)
      ensure(
        JSON.stringify(latest.scope) === JSON.stringify(p.scope),
        "stale_target",
        "Check scope cannot change within an attempt",
      );
    if (same && latest.external_run !== undefined)
      ensure(
        sameExternalRun(latest.external_run, p.external_run),
        "stale_target",
        "External run identity cannot change within an attempt",
      );
    if (same && latest.status === p.status && !latest.recheck_requested) {
      ensure(
        latest.failure_excerpt === p.failure_excerpt &&
          sameExternalRun(latest.external_run, p.external_run),
        "stale_target",
        "Check evidence cannot be overwritten",
      );
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
          (previous.status === "passed" &&
            p.base_sha !== undefined &&
            previous.base_sha !== p.base_sha) ||
          previous.status === "interrupted" ||
          previous.status === "executor_unreachable" ||
          previous.recheck_requested,
        "illegal_transition",
        "This tree already has a result; a failed check requires an explicit recheck",
      );
      ensure(
        !state.events.some(
          (e) =>
            MERGE_CHECK_EVENTS.includes(e.type) &&
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
              "skipped",
            ].includes(c.status) &&
            (c.status === "skipped"
              ? c.reason === "docs_only" &&
                p.scope?.kind === "docs_only" &&
                c.exit_code == null &&
                (c.duration_ms === undefined || c.duration_ms === 0)
              : c.reason === undefined) &&
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
        [p.timeout_only, p.infra_flaky].every(
          (classification) =>
            classification === undefined ||
            (typeof classification === "boolean" &&
              (!classification ||
                ((p.status === "failed" || p.status === "timed_out") &&
                  p.checks.some((c) =>
                    ["failed", "timed_out"].includes(c.status),
                  ) &&
                  p.checks.every((c) =>
                    [
                      "passed",
                      "failed",
                      "timed_out",
                      "not_run",
                      "skipped",
                    ].includes(c.status),
                  )))),
        ),
        "validation_failed",
        "Only a failed or timed-out check can carry a retry classification",
      );
      ensure(
        p.status !== "passed" ||
          (p.checks.length > 0 &&
            p.checks.every(
              (c) =>
                c.status === "skipped" ||
                (c.status === "passed" && c.exit_code === 0),
            )),
        "invariant_violation",
        "A passed check must have only successful commands",
      );
    }
    const value: MergeCheckView = {
      attempt_id: p.attempt_id,
      completion_id: p.completion_id,
      candidate_sha: p.candidate_sha,
      tree_sha: p.tree_sha,
      ...(p.base_sha ? { base_sha: p.base_sha } : {}),
      ...(p.scope ? { scope: p.scope } : {}),
      ...(p.failure_excerpt !== undefined
        ? { failure_excerpt: p.failure_excerpt }
        : {}),
      ...(p.executor ? { executor: { ...p.executor } } : {}),
      ...(p.external_run ? { external_run: { ...p.external_run } } : {}),
      status: p.status,
      checks: "checks" in p ? p.checks : [],
      updated_at: d.now,
      ...("checks" in p ? { summary: p.summary, log_ref: p.log_ref } : {}),
      ...("checks" in p && p.timeout_only ? { timeout_only: true } : {}),
      ...("checks" in p && p.infra_flaky ? { infra_flaky: true } : {}),
    };
    // C-116 / A1b: a host-classified timeout or v2 infrastructure failure is
    // queued again automatically, once per completion; any other or later
    // failure follows the card version (legacy PM handling or A1 return).
    // Only the supervisor, which sees the full
    // output, can tell a clean timeout from a step that failed and then hung,
    // so structured statuses alone never trigger the rerun.
    const plan =
      "checks" in p &&
      (p.status === "failed" || p.status === "timed_out") &&
      (p.timeout_only === true ||
        (flowAtLeast(d.card(p.card_id), 2) && p.infra_flaky === true)) &&
      !hasAutoRerun(state.events, p.card_id, p.completion_id)
        ? attempt(() => unwrap(prepareMergePlan(state, p.card_id)))
        : undefined;
    const rerun = plan?.ok && plan.value.completion_id === p.completion_id;
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
        ...(rerun ? { auto_rerun: true } : {}),
      },
      {
        type: "status_change",
        body: `合并检查 ${p.status}${"checks" in p && p.summary ? `：${p.summary}` : ""}${"checks" in p ? `；日志：get_check_log(card_id=${p.card_id}, attempt_id=${p.attempt_id})` : ""}`,
      },
    );
    if (!rerun) {
      if (
        (p.status === "failed" || p.status === "timed_out") &&
        flowAtLeast(d.card(p.card_id), 2)
      )
        systemReturnFailedCheck(d, p.card_id, value);
      return value;
    }
    const requeued: MergeCheckView = {
      attempt_id: value.attempt_id,
      completion_id: value.completion_id,
      candidate_sha: value.candidate_sha,
      tree_sha: value.tree_sha,
      ...(value.scope ? { scope: value.scope } : {}),
      status: "queued",
      checks: [],
      recheck_requested: true,
      updated_at: d.now,
    };
    d.emit(
      "merge_check_requeued",
      p.card_id,
      {
        ...requeued,
        via: value.timeout_only ? TIMEOUT_AUTO_RERUN : INFRA_AUTO_RERUN,
        failed_status: p.status,
      },
      {
        type: "status_change",
        body: value.timeout_only
          ? "因超时自动重跑"
          : "因基础设施偶发失败自动重跑",
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
  // Classification belongs to the failed attempt, not to the requeue.
  const {
    timeout_only: _classified,
    infra_flaky: _infra,
    failure_excerpt: _excerpt,
    external_run: _external,
    ...previous
  } = latest;
  const value: MergeCheckView = {
    ...previous,
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
