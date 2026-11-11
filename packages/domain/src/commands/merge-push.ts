import type { Actor, Event, HumanAction } from "../entities.js";
import type { CardId, DeliveryId, EventId, HumanActionId } from "../ids.js";
import { completeActionDraft } from "./coordination.js";
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
  /** First-parent boundary already published (or the pre-push baseline). */
  readonly base_sha?: string;
}
/** One first-parent commit of central main; names are display-only. */
export interface MergePushCommit {
  readonly sha: string;
  readonly parent?: string;
  readonly author: string;
  readonly committer: string;
  readonly subject: string;
}
/** Most first-parent commits the host reads for one pre-push check. */
export const MERGE_PUSH_RANGE_LIMIT = 200;
interface Held extends MergePushAttempt {
  readonly foreign: readonly MergePushCommit[];
  readonly broken: boolean;
  readonly human_action_id: HumanActionId;
}
interface Resolved {
  readonly mode: "accept" | "reverted";
  readonly held_event_id: EventId;
  readonly accepted: readonly string[];
  readonly dropped_queue_ids: readonly EventId[];
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

const fullSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const control = (records: readonly Event[]) =>
  records.filter((e) => e.type !== "merge_push_queued").at(-1);

/** Last published SHA, else the baseline the first queued merge was built on. */
function pushBase(state: CommandState, events: readonly Event[]) {
  const pushed = events.filter((e) => e.type === "merge_pushed").at(-1);
  if (pushed) return (pushed.payload as unknown as Finished).sha;
  const first = events.find((e) => e.type === "merge_push_queued");
  const id = (first?.payload as unknown as Queued | undefined)?.merge_event_id;
  const merge = state.events.find((e) => e.id === id);
  return (merge?.payload as { result?: { previous_sha?: string } } | null)
    ?.result?.previous_sha;
}

/**
 * Foreign = a first-parent commit outside every merge-loop segment
 * (`previous_sha`, `merge_sha`] recorded by card_merged, and not accepted by
 * the human. Identity is the SHA only; author and committer never matter.
 */
export function foreignMergePushCommits(
  state: CommandState,
  target: string,
  base: string,
  chain: readonly MergePushCommit[],
): { readonly foreign: readonly MergePushCommit[]; readonly broken: boolean } {
  const segments = new Map<string, string>();
  for (const e of state.events) {
    if (e.type !== "card_merged") continue;
    const r = (e.payload as { result?: Record<string, unknown> } | null)
      ?.result;
    if (
      r?.kind === "merged" &&
      typeof r.merge_sha === "string" &&
      typeof r.previous_sha === "string" &&
      r.merge_sha !== r.previous_sha
    )
      segments.set(r.merge_sha, r.previous_sha);
  }
  const accepted = new Set(
    records(state, target)
      .filter((e) => e.type === "merge_push_hold_resolved")
      .flatMap((e) => (e.payload as unknown as Resolved).accepted),
  );
  const broken =
    chain.length > MERGE_PUSH_RANGE_LIMIT ||
    chain.some(
      (c, i) => c.parent !== (i + 1 < chain.length ? chain[i + 1]?.sha : base),
    );
  const foreign: MergePushCommit[] = [];
  let stop: string | undefined;
  for (const c of chain) {
    // Inside a recorded segment every first parent was written by the loop.
    if (stop !== undefined && c.sha !== stop) continue;
    stop = undefined;
    if (accepted.has(c.sha)) continue;
    const previous = segments.get(c.sha);
    if (previous !== undefined) stop = previous;
    else foreign.push(c);
  }
  return { foreign, broken };
}

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
      last = control(events),
      base = pushBase(state, events);
    if (last?.type === "merge_push_started") {
      const started = last.payload as unknown as MergePushAttempt;
      return started.base_sha || !base
        ? started
        : { ...started, base_sha: base };
    }
    const done = new Set(
      events.flatMap((e) =>
        e.type === "merge_pushed"
          ? (e.payload as unknown as Finished).queue_ids
          : e.type === "merge_push_hold_resolved"
            ? (e.payload as unknown as Resolved).dropped_queue_ids
            : [],
      ),
    );
    let pending = events.filter(
      (e) => e.type === "merge_push_queued" && !done.has(e.id),
    );
    // A foreign-commit hold pauses the target until its Needs You closes.
    // Closing it without `accept` (Workbench / human-action done / triage)
    // means "reverted": no commit becomes trusted and every merge queued up
    // to the hold is dropped, so a later merge is checked afresh.
    let resumed = last?.type === "merge_push_hold_resolved";
    if (last?.type === "merge_push_held") {
      const held = last.payload as unknown as Held;
      const action = state.human_actions.find(
        (h) => h.id === held.human_action_id,
      );
      if (!action || action.status === "open") return undefined;
      const dropped = pending.filter((e) => e.seq <= last.seq).map((e) => e.id);
      d.emit("merge_push_hold_resolved", undefined, {
        target: p.target,
        branch: p.branch,
        held_event_id: last.id,
        human_action_id: held.human_action_id,
        mode: "reverted",
        accepted: [],
        dropped_queue_ids: dropped,
        description: `外来提交未被接受，已丢弃 ${dropped.length} 个待推送合并；之后的合并重新核对后再推送`,
      });
      pending = pending.filter((e) => !dropped.includes(e.id));
      resumed = true;
    }
    if (!pending.length) return undefined;
    ensure(base, "invariant_violation", "Push has no first-parent boundary");
    const failed =
      last?.type === "merge_push_failed"
        ? (last.payload as unknown as Finished)
        : undefined;
    const action = failed?.human_action_id
      ? state.human_actions.find((h) => h.id === failed.human_action_id)
      : undefined;
    const blocked = resumed || (failed && failed.reason !== "network");
    if (failed && blocked && action?.status !== "done") return undefined;
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
      base_sha: base,
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
const short = (sha: string) => sha.slice(0, 12);
function holdInstructions(
  action: HumanActionId,
  branch: string,
  base: string,
  foreign: readonly MergePushCommit[],
  broken: boolean,
) {
  const shown = foreign
    .slice(0, 20)
    .map(
      (c) =>
        `- ${short(c.sha)}  作者 ${c.author}，提交者 ${c.committer}：${c.subject}`,
    );
  if (foreign.length > shown.length)
    shown.push(
      `- 另有 ${foreign.length - shown.length} 个，完整列表见事件 merge_push_held`,
    );
  return [
    `自动推送到远程 ${branch} 已暂停：中心仓库的 ${branch} 上出现了不是合并流程产生的提交，系统没有推送。`,
    `从上次推送点 ${short(base)} 起的外来提交（共 ${foreign.length} 个，新的在前）：`,
    ...shown,
    ...(broken
      ? [
          `另外，中心 ${branch} 已接不上上次推送点（历史被改写或提交超过 ${MERGE_PUSH_RANGE_LIMIT} 个），只能按下面第 2 种方式处理。`,
        ]
      : [
          `处理方式一：确认接受这些提交，运行 cardigan merge push-accept ${action} --text <说明>；系统随后把它们和排队的合并一起推送。`,
        ]),
    `处理方式${broken ? "" : "二"}：不接受。先在主机上把中心仓库 ${branch} 恢复到不含这些提交的状态（例如回到 ${short(base)}，再重新合并需要的卡片），然后在 Workbench 或用 cardigan human-action done ${action} 标记此事项完成；系统会丢弃已排队的这批推送，之后的合并重新核对后再推送。`,
  ].join("\n");
}

/**
 * Pre-push check of the active attempt: `chain` is central main's first-parent
 * path from attempt.sha down to (excluding) base_sha, as read by the host.
 * Any commit outside the merge loop's recorded segments holds the target.
 */
export function checkMergePushRange(
  state: CommandState,
  actor: Actor,
  p: {
    target: string;
    attempt_id: string;
    chain: readonly MergePushCommit[];
  },
  ports: CommandPorts,
) {
  return command(state, actor, "check_merge_push_range", ports, (d) => {
    ensure(
      Array.isArray(p.chain) &&
        p.chain.length <= MERGE_PUSH_RANGE_LIMIT + 1 &&
        p.chain.every(
          (c) =>
            fullSha.test(c.sha) &&
            (c.parent === undefined || fullSha.test(c.parent)) &&
            [c.author, c.committer, c.subject].every(
              (v) => typeof v === "string" && v.length <= 200,
            ),
        ),
      "validation_failed",
      "Invalid first-parent range",
    );
    const events = records(state, p.target),
      last = control(events);
    if (
      last?.type === "merge_push_held" &&
      (last.payload as unknown as Held).attempt_id === p.attempt_id
    )
      return { status: "held" as const, held: last.payload as unknown as Held };
    ensure(
      last?.type === "merge_push_started" &&
        (last.payload as unknown as MergePushAttempt).attempt_id ===
          p.attempt_id,
      "stale_target",
      "Range check does not belong to the active attempt",
    );
    const attempt = last.payload as unknown as MergePushAttempt,
      base = attempt.base_sha ?? pushBase(state, events);
    ensure(base, "invariant_violation", "Push has no first-parent boundary");
    ensure(
      p.chain.length === 0 || p.chain[0]?.sha === attempt.sha,
      "validation_failed",
      "Range must start at the pushed SHA",
    );
    const { foreign, broken } = foreignMergePushCommits(
      state,
      p.target,
      base,
      p.chain,
    );
    if (!foreign.length && !broken) return { status: "clear" as const };
    const id = d.ids.next(d.state.project_id, "human_action");
    const action: HumanAction = {
      id,
      key: id,
      requested_by: "system",
      status: "open",
      blocked_work_items: [],
      instructions: holdInstructions(id, attempt.branch, base, foreign, broken),
      why_human: "中心仓库被绕过合并流程写入，只有人能决定接受还是回退",
      expected_return: "说明接受或回退的结果并完成此事项",
    };
    d.put("human_actions", action);
    d.emit("human_action_requested", undefined, {
      human_action_id: id,
      blocked_work_items: [],
    });
    const held: Held = {
      ...attempt,
      base_sha: base,
      foreign: foreign.map((c) => ({ ...c })),
      broken,
      human_action_id: id,
    };
    d.emit("merge_push_held", undefined, {
      ...held,
      queue_ids: [...held.queue_ids],
      foreign: held.foreign.map((c) => ({ ...c })),
      description: `中心 ${attempt.branch} 出现 ${foreign.length} 个非合并流程提交，自动推送已暂停`,
    });
    return { status: "held" as const, held };
  });
}

/** Human-only: trust exactly the held foreign SHAs and resume pushing. */
export function acceptMergePushHold(
  state: CommandState,
  actor: Actor,
  p: { human_action_id: HumanActionId; text: string },
  ports: CommandPorts,
) {
  return command(state, actor, "accept_merge_push_hold", ports, (d) => {
    ensure(
      actor.kind === "human",
      "unauthorized",
      "Only the human can accept foreign commits",
    );
    const event = state.events
      .filter(
        (e) =>
          !e.card_id &&
          e.type === "merge_push_held" &&
          (e.payload as unknown as Held).human_action_id === p.human_action_id,
      )
      .at(-1);
    ensure(event, "not_found", "No push hold for this human action");
    const held = event.payload as unknown as Held;
    ensure(
      control(records(state, held.target))?.id === event.id,
      "stale_target",
      "This push hold was already resolved",
    );
    ensure(
      !held.broken,
      "illegal_transition",
      "A broken range cannot be accepted; restore central main instead",
    );
    const action = completeActionDraft(d, {
      human_action_id: p.human_action_id,
      text: p.text,
    });
    d.emit("merge_push_hold_resolved", undefined, {
      target: held.target,
      branch: held.branch,
      held_event_id: event.id,
      human_action_id: p.human_action_id,
      mode: "accept",
      accepted: held.foreign.map((c) => c.sha),
      dropped_queue_ids: [],
      description: `已确认接受 ${held.foreign.length} 个外来提交，恢复自动推送`,
    });
    return action;
  });
}
