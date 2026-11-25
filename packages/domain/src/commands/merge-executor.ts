import type { Actor, HumanAction } from "../entities.js";
import type { HumanActionId } from "../ids.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

/**
 * Which dispatch_unknown branch. C-758 splits the former `push_incomplete`
 * (still accepted for old hosts) by the real cause of the candidate push.
 */
export type MergeExecutorStage =
  | "not_sent"
  | "push_incomplete"
  | "push_cancelled"
  | "push_timeout"
  | "push_rejected"
  | "push_unreachable"
  | "push_failed"
  | "run_not_found";
const STAGES: readonly MergeExecutorStage[] = [
  "not_sent",
  "push_incomplete",
  "push_cancelled",
  "push_timeout",
  "push_rejected",
  "push_unreachable",
  "push_failed",
  "run_not_found",
];
/** Candidate transport reasons the host reports with a failed push. */
const PUSH_FAILURES = [
  "cancelled",
  "timeout",
  "local",
  "network",
  "auth",
  "rejected",
  "github_error",
  "other",
] as const;
export type MergeExecutorPushFailure = (typeof PUSH_FAILURES)[number];
/** C-758: a local abort says nothing about the executor; it is not recorded. */
const LOCAL_CANCEL: readonly MergeExecutorStage[] = [
  "not_sent",
  "push_cancelled",
];
/** C-758: GitHub answered (or the host's own transfer failed): not unreachable. */
const PUSH_FAILED: Readonly<Partial<Record<MergeExecutorStage, string>>> = {
  push_timeout: "候选推送超时",
  push_rejected: "GitHub 拒绝或报错候选推送",
  push_failed: "候选推送在本机失败",
};
/** C-681: host-observed cause of one failed attempt; fixed fields only. */
export type MergeExecutorFailure = {
  readonly category: string;
  readonly stage?: MergeExecutorStage;
  /** C-758: the candidate transport's fixed reason for a failed push. */
  readonly push_failure?: MergeExecutorPushFailure;
  /** C-758: Git's exit status, push tries and total push time of the attempt. */
  readonly push_exit_code?: number;
  readonly push_attempts?: number;
  readonly push_duration_ms?: number;
  /** Latest provider HTTP status observed by the attempt. */
  readonly http_status?: number;
  readonly request_id?: string;
};
const boundedInteger = (value: unknown, max: number) =>
  value === undefined ||
  (Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= max);
const pushFailed = (failure: MergeExecutorFailure | undefined) =>
  failure?.stage !== undefined && Object.hasOwn(PUSH_FAILED, failure.stage);
const OUTAGE_EVENTS = [
  "merge_executor_unreachable",
  "merge_executor_push_failed",
  "merge_executor_attention_required",
  "merge_executor_recovered",
];
interface Outage {
  readonly executor: string;
  readonly attempt_id: string;
  /** Cause of the latest unreachable attempt, when the host could classify it. */
  readonly failure?: MergeExecutorFailure;
  readonly failure_count: number;
  readonly first_failed_at: string;
  readonly next_retry_at: string;
  readonly human_action_id?: HumanActionId;
}

/** Project events survive controller restarts; no in-memory retry budget. */
export function mergeExecutorOutage(state: CommandState, executor: string) {
  const latest = state.events
    .filter(
      (e) =>
        !e.card_id &&
        e.actor.kind === "system" &&
        OUTAGE_EVENTS.includes(e.type) &&
        (e.payload as { executor?: string } | null)?.executor === executor,
    )
    .sort((a, b) => a.seq - b.seq)
    .at(-1);
  return latest && latest.type !== "merge_executor_recovered"
    ? (latest.payload as unknown as Outage)
    : undefined;
}

/**
 * Host-only connectivity evidence and timer polling, independent of card state.
 * C-758: one backoff state per executor, recorded by cause. Only a failure that
 * could not reach GitHub is `merge_executor_unreachable`; a timed-out, rejected
 * or locally failed candidate push is `merge_executor_push_failed` with the same
 * backoff; a local cancellation is not an executor observation at all.
 */
export function recordMergeExecutor(
  state: CommandState,
  actor: Actor,
  p: { executor: string } & (
    | {
        status: "unreachable";
        attempt_id: string;
        failure?: MergeExecutorFailure;
      }
    | { status: "reachable" | "poll" }
  ),
  ports: CommandPorts,
) {
  return command(state, actor, "record_merge_executor", ports, (d) => {
    ensure(
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(p.executor) &&
        ["unreachable", "reachable", "poll"].includes(p.status),
      "validation_failed",
      "Invalid merge executor observation",
    );
    const previous = mergeExecutorOutage(state, p.executor);
    const pushOutage = pushFailed(previous?.failure);
    if (p.status === "reachable") {
      if (!previous) return undefined;
      const action = state.human_actions.find(
        (h) => h.id === previous.human_action_id,
      );
      if (action?.status === "open") {
        d.put("human_actions", { ...action, status: "cancelled" });
        d.emit("human_action_cancelled", undefined, {
          human_action_id: action.id,
          reason: pushOutage
            ? "候选推送已恢复，合并检查自动继续，无需处理"
            : "远程检查机已恢复连接，合并检查自动继续，无需处理",
        });
      }
      d.emit("merge_executor_recovered", undefined, {
        executor: p.executor,
        first_failed_at: previous.first_failed_at,
        description: pushOutage
          ? "候选推送已恢复，合并检查自动继续"
          : "远程检查机已恢复连接，合并检查自动继续",
      });
      return undefined;
    }
    const now = Date.parse(d.now);
    ensure(Number.isFinite(now), "validation_failed", "Invalid clock");
    let outage = previous;
    if (p.status === "unreachable") {
      ensure(
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(p.attempt_id),
        "validation_failed",
        "Invalid merge executor attempt",
      );
      const failure = p.failure;
      ensure(
        failure === undefined ||
          (/^[a-z][a-z0-9_]{0,39}$/u.test(failure.category) &&
            (failure.stage === undefined || STAGES.includes(failure.stage)) &&
            (failure.push_failure === undefined ||
              PUSH_FAILURES.includes(failure.push_failure)) &&
            boundedInteger(failure.push_exit_code, 255) &&
            boundedInteger(failure.push_attempts, 16) &&
            boundedInteger(failure.push_duration_ms, 24 * 60 * 60_000) &&
            (failure.http_status === undefined ||
              (Number.isSafeInteger(failure.http_status) &&
                failure.http_status >= 100 &&
                failure.http_status <= 599)) &&
            (failure.request_id === undefined ||
              /^[A-Za-z0-9:._-]{1,80}$/u.test(failure.request_id))),
        "validation_failed",
        "Invalid merge executor failure",
      );
      // A local cancellation is neither a failure nor a recovery.
      if (failure?.stage && LOCAL_CANCEL.includes(failure.stage))
        return previous;
      // Replaying a finished attempt must not consume another retry or reopen
      // an outage already recovered by a later connection.
      if (
        state.events.some(
          (e) =>
            !e.card_id &&
            (e.type === "merge_executor_unreachable" ||
              e.type === "merge_executor_push_failed") &&
            (e.payload as unknown as Outage).executor === p.executor &&
            (e.payload as unknown as Outage).attempt_id === p.attempt_id,
        )
      )
        return previous;
      const count = (previous?.failure_count ?? 0) + 1;
      const { failure: _previousFailure, ...rest } = previous ?? {};
      outage = {
        ...rest,
        executor: p.executor,
        attempt_id: p.attempt_id,
        ...(failure
          ? {
              failure: {
                category: failure.category,
                ...(failure.stage ? { stage: failure.stage } : {}),
                ...(failure.push_failure
                  ? { push_failure: failure.push_failure }
                  : {}),
                ...(failure.push_exit_code !== undefined
                  ? { push_exit_code: failure.push_exit_code }
                  : {}),
                ...(failure.push_attempts !== undefined
                  ? { push_attempts: failure.push_attempts }
                  : {}),
                ...(failure.push_duration_ms !== undefined
                  ? { push_duration_ms: failure.push_duration_ms }
                  : {}),
                ...(failure.http_status !== undefined
                  ? { http_status: failure.http_status }
                  : {}),
                ...(failure.request_id
                  ? { request_id: failure.request_id }
                  : {}),
              },
            }
          : {}),
        failure_count: count,
        first_failed_at: previous?.first_failed_at ?? d.now,
        next_retry_at: new Date(
          now + Math.min(2 ** Math.min(count - 1, 5), 30) * 60_000,
        ).toISOString(),
      };
    }
    if (!outage) return undefined;
    // One notice for the entire outage, even if somebody manually closes it.
    // Polling also escalates between retries, immediately after 30 minutes.
    if (
      !outage.human_action_id &&
      now - Date.parse(outage.first_failed_at) > 30 * 60_000
    ) {
      const id = d.ids.next(state.project_id, "human_action");
      const pushLabel = PUSH_FAILED[outage.failure?.stage ?? "not_sent"];
      const action: HumanAction = {
        id,
        key: id,
        requested_by: "system",
        status: "open",
        blocked_work_items: [],
        ...(pushLabel
          ? {
              instructions: `合并检查执行器 ${p.executor} 的候选推送持续失败（${pushLabel}），合并检查正在排队等待。请检查 GitHub App 的仓库权限和推送规则、主机到 GitHub 的传输时限以及中心仓库；系统会继续重试，恢复后自动继续检查，此事项自动失效，无需手动重排。`,
              why_human: "候选推送已连续失败超过 30 分钟",
              expected_return: "恢复候选推送；无需手动重排合并检查",
            }
          : {
              instructions: `远程检查机 ${p.executor} 不可达，合并检查正在排队等待。请检查机器、网络和 SSH 连接；系统会继续重试，恢复后自动继续检查，此事项自动失效，无需手动重排。`,
              why_human: "远程检查机已连续不可达超过 30 分钟",
              expected_return: "恢复远程检查机连接；无需手动重排合并检查",
            }),
      };
      d.put("human_actions", action);
      d.emit("human_action_requested", undefined, {
        human_action_id: id,
        blocked_work_items: [],
      });
      outage = { ...outage, human_action_id: id };
    }
    if (p.status === "unreachable" || outage !== previous) {
      const pushLabel = PUSH_FAILED[outage.failure?.stage ?? "not_sent"];
      d.emit(
        p.status !== "unreachable"
          ? "merge_executor_attention_required"
          : pushLabel
            ? "merge_executor_push_failed"
            : "merge_executor_unreachable",
        undefined,
        {
          ...outage,
          description: pushLabel
            ? `${pushLabel}，合并检查排队等待并按退避重试`
            : "远程检查机不可达，合并检查排队等待并按退避重试",
        },
      );
    }
    return outage;
  });
}
