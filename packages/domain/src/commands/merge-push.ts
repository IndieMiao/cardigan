import type { Actor, Event, HumanAction } from "../entities.js";
import type { CardId, DeliveryId, EventId, HumanActionId } from "../ids.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

export type MergePushFailure = "rejected" | "network" | "auth" | "other";
export interface MergePushDestination {
  readonly target: string;
  readonly branch: string;
}
export interface MergePushAttempt extends MergePushDestination {
  readonly attempt_id: string;
  readonly queue_ids: readonly EventId[];
  readonly sha: string;
  readonly failure_count: number;
  readonly first_failed_at?: string;
  readonly human_action_id?: HumanActionId;
}
interface Queued extends MergePushDestination {
  readonly sha: string;
  readonly merge_event_id: EventId;
}
interface Finished extends MergePushAttempt {
  readonly status: "pushed" | "failed";
  readonly reason?: MergePushFailure;
  readonly next_retry_at?: string;
}
const records = (state: CommandState, target: string) =>
  state.events
    .filter(
      (e) =>
        !e.card_id &&
        e.type.startsWith("merge_push") &&
        (e.payload as { target?: string } | null)?.target === target,
    )
    .sort((a, b) => a.seq - b.seq);
const validDestination = (p: MergePushDestination) =>
  /^[a-f0-9]{64}$/u.test(p.target) &&
  p.branch.trim() === p.branch &&
  p.branch.length > 0 &&
  !/\s/u.test(p.branch);

/** Called only inside recordMergeResult's successful transaction. */
export function queueMergedPush(
  d: CommandDraft,
  p: {
    merge_event_id: EventId;
    card_id: CardId;
    completion_id: DeliveryId;
    sha: string;
  },
) {
  const destination = d.state.project_settings?.merge_push;
  if (!destination) return;
  ensure(
    validDestination(destination),
    "validation_failed",
    "Invalid trusted push destination",
  );
  d.emit("merge_push_queued", undefined, { ...p, ...destination });
}

/** Select once before IO; recovering a started attempt retries that same SHA. */
export function beginMergePush(
  state: CommandState,
  actor: Actor,
  p: MergePushDestination & { attempt_id: string },
  ports: CommandPorts,
) {
  return command(state, actor, "begin_merge_push", ports, (d) => {
    ensure(
      validDestination(p) &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(p.attempt_id),
      "validation_failed",
      "Invalid push identity",
    );
    ensure(
      state.project_settings?.merge_push?.target === p.target &&
        state.project_settings.merge_push.branch === p.branch,
      "illegal_transition",
      "Push destination is not enabled",
    );
    const events = records(state, p.target),
      last = events.filter((e) => e.type !== "merge_push_queued").at(-1);
    if (last?.type === "merge_push_started")
      return last.payload as unknown as MergePushAttempt;
    const done = new Set(
      events
        .filter((e) => e.type === "merge_pushed")
        .flatMap((e) => (e.payload as unknown as Finished).queue_ids),
    );
    const pending = events.filter(
      (e) => e.type === "merge_push_queued" && !done.has(e.id),
    );
    if (!pending.length) return undefined;
    const failed =
      last?.type === "merge_push_failed"
        ? (last.payload as unknown as Finished)
        : undefined;
    const action = failed?.human_action_id
      ? state.human_actions.find((h) => h.id === failed.human_action_id)
      : undefined;
    const blocked = failed && failed.reason !== "network";
    if (blocked && action?.status !== "done") return undefined;
    const now = Date.parse(d.now);
    ensure(Number.isFinite(now), "validation_failed", "Invalid push clock");
    if (
      !blocked &&
      failed?.next_retry_at &&
      now < Date.parse(failed.next_retry_at)
    )
      return undefined;
    // A completed intervention authorizes one coalesced retry; an ordinary
    // network retry keeps the original attempt's range, never skips ahead.
    const selected = blocked
      ? pending
      : failed
        ? pending.filter((e) => failed.queue_ids.includes(e.id))
        : pending.slice(0, 1);
    ensure(
      selected.length > 0 && selected[0]?.id === pending[0]?.id,
      "invariant_violation",
      "Push must start at the first pending merge",
    );
    ensure(
      !events.some(
        (e) =>
          (e.payload as { attempt_id?: string } | null)?.attempt_id ===
          p.attempt_id,
      ),
      "validation_failed",
      "Push attempt id was already used",
    );
    const latest = selected.at(-1) as Event,
      target = latest.payload as unknown as Queued;
    const attempt: MergePushAttempt = {
      target: p.target,
      branch: p.branch,
      attempt_id: p.attempt_id,
      queue_ids: selected.map((e) => e.id),
      sha: target.sha,
      failure_count: blocked ? 0 : (failed?.failure_count ?? 0),
      ...(!blocked && failed?.first_failed_at
        ? { first_failed_at: failed.first_failed_at }
        : {}),
      ...(!blocked && failed?.human_action_id
        ? { human_action_id: failed.human_action_id }
        : {}),
    };
    d.emit("merge_push_started", undefined, {
      ...attempt,
      queue_ids: [...attempt.queue_ids],
    });
    return attempt;
  });
}
export function mergePushMessage(
  reason: MergePushFailure,
  branch: string,
): string {
  switch (reason) {
    case "rejected":
      return `远程 ${branch} 拒绝快进推送，请处理远程分叉或保护规则`;
    case "auth":
      return `推送到 ${branch} 的身份或主机校验失败，请检查专用密钥与 known_hosts`;
    case "network":
      return `推送到 ${branch} 网络连接失败，将按退避重试`;
    case "other":
      return `推送到 ${branch} 出现未识别错误，请检查主机推送配置与仓库`;
  }
}
function humanAction(
  d: CommandDraft,
  attempt: MergePushAttempt,
  reason: MergePushFailure,
): HumanAction {
  const id = d.ids.next(d.state.project_id, "human_action");
  const action: HumanAction = {
    id,
    key: id,
    requested_by: "system",
    status: "open",
    blocked_work_items: [],
    instructions: `${mergePushMessage(reason, attempt.branch)}。处理完成后标记此事项完成${reason === "network" ? "；系统继续按退避重试" : "，系统将重试一次"}。`,
    why_human:
      reason === "network"
        ? "推送已连续失败超过两小时"
        : "只有主机管理员可以处理远程仓库和推送权限",
    expected_return: "说明处理结果并标记完成",
  };
  d.put("human_actions", action);
  d.emit("human_action_requested", undefined, {
    human_action_id: id,
    blocked_work_items: [],
  });
  return action;
}
export function recordMergePushResult(
  state: CommandState,
  actor: Actor,
  p: { target: string; attempt_id: string } & (
    | { status: "pushed" }
    | { status: "failed"; reason: MergePushFailure }
  ),
  ports: CommandPorts,
) {
  return command(state, actor, "record_merge_push_result", ports, (d) => {
    ensure(
      p.status === "pushed" ||
        (p.status === "failed" &&
          ["rejected", "network", "auth", "other"].includes(p.reason)),
      "validation_failed",
      "Invalid push result",
    );
    const events = records(state, p.target);
    const existing = events.find(
      (e) =>
        ["merge_pushed", "merge_push_failed"].includes(e.type) &&
        (e.payload as unknown as Finished).attempt_id === p.attempt_id,
    );
    if (existing) {
      const old = existing.payload as unknown as Finished;
      ensure(
        old.status === p.status &&
          old.reason === (p.status === "failed" ? p.reason : undefined),
        "stale_target",
        "Push result cannot be overwritten",
      );
      return old;
    }
    const started = events.filter((e) => e.type !== "merge_push_queued").at(-1);
    ensure(
      started?.type === "merge_push_started" &&
        (started.payload as unknown as MergePushAttempt).attempt_id ===
          p.attempt_id,
      "stale_target",
      "Push result does not belong to the active attempt",
    );
    const attempt = started.payload as unknown as MergePushAttempt;
    let result: Finished;
    if (p.status === "pushed") {
      result = { ...attempt, status: "pushed" };
      const action = state.human_actions.find(
        (h) => h.id === attempt.human_action_id,
      );
      if (action?.status === "open") {
        d.put("human_actions", { ...action, status: "cancelled" });
        d.emit("human_action_cancelled", undefined, {
          human_action_id: action.id,
          reason: "推送已恢复成功，无需继续处理",
        });
      }
    } else {
      const count = attempt.failure_count + 1,
        first = attempt.first_failed_at ?? d.now,
        now = Date.parse(d.now);
      ensure(
        Number.isFinite(now) && Number.isFinite(Date.parse(first)),
        "validation_failed",
        "Invalid push clock",
      );
      let action = state.human_actions.find(
        (h) => h.id === attempt.human_action_id,
      );
      if (p.reason !== "network" || now - Date.parse(first) > 2 * 60 * 60_000) {
        if (action?.status !== "open")
          action = humanAction(d, attempt, p.reason);
      }
      result = {
        ...attempt,
        status: "failed",
        reason: p.reason,
        failure_count: count,
        first_failed_at: first,
        ...(p.reason === "network"
          ? {
              next_retry_at: new Date(
                now + Math.min(2 ** Math.min(count - 1, 5), 30) * 60_000,
              ).toISOString(),
            }
          : {}),
        ...(action ? { human_action_id: action.id } : {}),
      };
    }
    d.emit(
      p.status === "pushed" ? "merge_pushed" : "merge_push_failed",
      undefined,
      {
        ...result,
        queue_ids: [...result.queue_ids],
        description:
          p.status === "pushed"
            ? `已推送到远程 ${attempt.branch}`
            : mergePushMessage(p.reason, attempt.branch),
      },
    );
    return result;
  });
}
