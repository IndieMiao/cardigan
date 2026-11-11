import type { Actor, HumanAction } from "../entities.js";
import type { HumanActionId } from "../ids.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

interface Outage {
  readonly executor: string;
  readonly attempt_id: string;
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
        [
          "merge_executor_unreachable",
          "merge_executor_attention_required",
          "merge_executor_recovered",
        ].includes(e.type) &&
        (e.payload as { executor?: string } | null)?.executor === executor,
    )
    .sort((a, b) => a.seq - b.seq)
    .at(-1);
  return latest && latest.type !== "merge_executor_recovered"
    ? (latest.payload as unknown as Outage)
    : undefined;
}

/** Host-only connectivity evidence and timer polling, independent of card state. */
export function recordMergeExecutor(
  state: CommandState,
  actor: Actor,
  p: { executor: string } & (
    | { status: "unreachable"; attempt_id: string }
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
    if (p.status === "reachable") {
      if (!previous) return undefined;
      const action = state.human_actions.find(
        (h) => h.id === previous.human_action_id,
      );
      if (action?.status === "open") {
        d.put("human_actions", { ...action, status: "cancelled" });
        d.emit("human_action_cancelled", undefined, {
          human_action_id: action.id,
          reason: "远程检查机已恢复连接，合并检查自动继续，无需处理",
        });
      }
      d.emit("merge_executor_recovered", undefined, {
        executor: p.executor,
        first_failed_at: previous.first_failed_at,
        description: "远程检查机已恢复连接，合并检查自动继续",
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
      // Replaying a finished attempt must not consume another retry or reopen
      // an outage already recovered by a later connection.
      if (
        state.events.some(
          (e) =>
            !e.card_id &&
            e.type === "merge_executor_unreachable" &&
            (e.payload as unknown as Outage).executor === p.executor &&
            (e.payload as unknown as Outage).attempt_id === p.attempt_id,
        )
      )
        return previous;
      const count = (previous?.failure_count ?? 0) + 1;
      outage = {
        ...previous,
        executor: p.executor,
        attempt_id: p.attempt_id,
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
      const action: HumanAction = {
        id,
        key: id,
        requested_by: "system",
        status: "open",
        blocked_work_items: [],
        instructions: `远程检查机 ${p.executor} 不可达，合并检查正在排队等待。请检查机器、网络和 SSH 连接；系统会继续重试，恢复后自动继续检查，此事项自动失效，无需手动重排。`,
        why_human: "远程检查机已连续不可达超过 30 分钟",
        expected_return: "恢复远程检查机连接；无需手动重排合并检查",
      };
      d.put("human_actions", action);
      d.emit("human_action_requested", undefined, {
        human_action_id: id,
        blocked_work_items: [],
      });
      outage = { ...outage, human_action_id: id };
    }
    if (p.status === "unreachable" || outage !== previous)
      d.emit(
        p.status === "unreachable"
          ? "merge_executor_unreachable"
          : "merge_executor_attention_required",
        undefined,
        {
          ...outage,
          description: "远程检查机不可达，合并检查排队等待并按退避重试",
        },
      );
    return outage;
  });
}
