import type { Actor, Event, HumanAction } from "../entities.js";
import { eventById, eventsOfType } from "../event-index.js";
import type { CardId, DeliveryId, EventId, HumanActionId } from "../ids.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { completeActionDraft } from "./human-action-completion.js";

export type MergePushFailure = "rejected" | "network" | "auth" | "other";
export interface MergePushDestination {
  readonly target: string;
  readonly branch: string;
  /**
   * Central baseline branch this route publishes. Records of one target are
   * kept per base branch: rebinding a remote branch to another baseline never
   * inherits the old queue, attempt or trusted boundary.
   */
  readonly base_branch?: string;
}
export interface MergePushAttempt extends MergePushDestination {
  readonly attempt_id: string;
  readonly queue_ids: readonly EventId[];
  readonly sha: string;
  readonly failure_count: number;
  /** Persisted across automatic and human retries; cleared by a successful range. */
  readonly auth_retry_used?: true;
  readonly first_failed_at?: string;
  readonly human_action_id?: HumanActionId;
  /** First-parent boundary of the pre-push check. */
  readonly base_sha?: string;
  /** Only a pushed SHA or a human-accepted boundary is trusted. */
  readonly base_trusted?: boolean;
}
/** One first-parent commit of central main; names are display-only. */
export interface MergePushCommit {
  readonly sha: string;
  readonly parent?: string;
  readonly author: string;
  readonly committer: string;
  readonly subject: string;
}
/** Most first-parent commits one pre-push check reads (host pages them). */
export const MERGE_PUSH_RANGE_LIMIT = 20_000;
/** Most foreign commits a single accept may trust. */
const ACCEPT_LIMIT = 1_000;
/** Commits shown in an event or Needs You item. */
const SHOWN = 200;
export type MergePushHoldReason =
  | "boundary"
  | "foreign"
  | "stale"
  | "broken"
  | "too_long"
  | "too_many";
interface Held extends MergePushAttempt {
  readonly head: string;
  readonly reasons: readonly MergePushHoldReason[];
  readonly acceptable: boolean;
  readonly foreign: readonly MergePushCommit[];
  readonly foreign_count: number;
  readonly foreign_shas: readonly string[];
  readonly human_action_id: HumanActionId;
}
interface Resolved {
  readonly mode: "accept" | "reverted";
  readonly held_event_id: EventId;
  readonly accepted: readonly string[];
  readonly boundary?: string;
  readonly dropped_queue_ids: readonly EventId[];
}
interface Queued extends MergePushDestination {
  readonly sha: string;
  readonly merge_event_id: EventId;
}
interface Finished extends MergePushAttempt {
  readonly status: "pushed" | "failed";
  readonly reason?: MergePushFailure;
  readonly exit_code?: number;
  readonly next_retry_at?: string;
}
const targetRecords = (state: CommandState, target: string) =>
  state.events
    .filter(
      (e) =>
        !e.card_id &&
        e.type.startsWith("merge_push") &&
        (e.payload as { target?: string } | null)?.target === target,
    )
    .sort((a, b) => a.seq - b.seq);
/**
 * The baseline branch a push record belongs to. New records carry it; older
 * ones derive it from the card whose merge was queued, so an unchanged single
 * route keeps its history.
 */
function recordBranches(state: CommandState, events: readonly Event[]) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const branches = new Map<EventId, string | undefined>();
  const of = (e: Event | undefined, depth = 0): string | undefined => {
    if (!e || depth > 2) return undefined;
    if (branches.has(e.id)) return branches.get(e.id);
    const payload = e.payload as {
      base_branch?: unknown;
      card_id?: unknown;
      queue_ids?: unknown;
      held_event_id?: unknown;
    } | null;
    let branch: string | undefined;
    if (typeof payload?.base_branch === "string") branch = payload.base_branch;
    else if (e.type === "merge_push_queued")
      branch = state.cards.find((c) => c.id === payload?.card_id)?.base_branch;
    else if (Array.isArray(payload?.queue_ids) && payload.queue_ids.length)
      branch = of(byId.get(payload.queue_ids[0] as EventId), depth + 1);
    else if (typeof payload?.held_event_id === "string")
      branch = of(byId.get(payload.held_event_id as EventId), depth + 1);
    branches.set(e.id, branch);
    return branch;
  };
  return of;
}
/**
 * Records of one route: a target and the central branch it publishes.
 * Records whose branch cannot be derived belong only to the registered route.
 */
const records = (
  state: CommandState,
  target: string,
  base_branch: string | undefined,
  registered = registeredRoute(state, target, base_branch),
) => {
  const events = targetRecords(state, target);
  if (base_branch === undefined) return events;
  const branch = recordBranches(state, events);
  return events.filter((e) => {
    const own = branch(e);
    return own === base_branch || (own === undefined && registered);
  });
};
const registeredRoute = (
  state: CommandState,
  target: string,
  base_branch: string | undefined,
) =>
  (state.project_settings?.merge_push ?? []).some(
    (r) => r.target === target && r.base_branch === base_branch && r.registered,
  );
/** The baseline branch of one record of `target` (an attempt or a hold). */
const branchOf = (state: CommandState, target: string, event: Event) =>
  recordBranches(state, targetRecords(state, target))(event);
const validDestination = (p: MergePushDestination) =>
  /^[a-f0-9]{64}$/u.test(p.target) &&
  p.branch.trim() === p.branch &&
  p.branch.length > 0 &&
  !/\s/u.test(p.branch);

const fullSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const control = (records: readonly Event[]) =>
  records.filter((e) => e.type !== "merge_push_queued").at(-1);

/**
 * The pre-push boundary. Only evidence counts as trusted: the last SHA this
 * target pushed, or a boundary the human accepted. Without either, the first
 * pending merge's previous_sha is merely a candidate and the check holds.
 */
function pushBase(
  state: CommandState,
  events: readonly Event[],
  pending: readonly Event[],
): { readonly sha: string; readonly trusted: boolean } | undefined {
  for (const e of [...events].reverse()) {
    if (e.type === "merge_pushed")
      return { sha: (e.payload as unknown as Finished).sha, trusted: true };
    const boundary =
      e.type === "merge_push_hold_resolved"
        ? (e.payload as unknown as Resolved).boundary
        : undefined;
    if (boundary) return { sha: boundary, trusted: true };
  }
  const id = (pending[0]?.payload as unknown as Queued | undefined)
    ?.merge_event_id;
  // C-671: by id from the index; the merged card is closed by now.
  const merge = eventById(state.events, id);
  const previous = (
    merge?.payload as { result?: { previous_sha?: string } } | null
  )?.result?.previous_sha;
  return previous ? { sha: previous, trusted: false } : undefined;
}

/**
 * Foreign = a first-parent commit outside every merge-loop segment
 * (`previous_sha`, `merge_sha`] recorded by card_merged, and not accepted by
 * the human. A segment is trusted only if its previous_sha actually closes on
 * the chain (or is the boundary itself). Identity is the SHA only.
 */
export function foreignMergePushCommits(
  state: CommandState,
  target: string,
  base: string,
  chain: readonly MergePushCommit[],
  /** Only merges into this central branch count as the loop's own commits. */
  base_branch?: string,
): { readonly foreign: readonly MergePushCommit[]; readonly broken: boolean } {
  const segments = new Map<string, string>();
  const registered = registeredRoute(state, target, base_branch);
  for (const e of eventsOfType(state.events, "card_merged")) {
    // Only merges into this route's branch are evidence for its chain.
    const merged = state.cards.find((c) => c.id === e.card_id)?.base_branch;
    if (
      base_branch !== undefined &&
      merged !== base_branch &&
      !(merged === undefined && registered)
    )
      continue;
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
    records(state, target, base_branch)
      .filter((e) => e.type === "merge_push_hold_resolved")
      .flatMap((e) => (e.payload as unknown as Resolved).accepted),
  );
  const broken = chain.some(
    (c, i) => c.parent !== (i + 1 < chain.length ? chain[i + 1]?.sha : base),
  );
  const foreign: MergePushCommit[] = [];
  let stop: string | undefined,
    inside: MergePushCommit[] = [];
  for (const c of chain) {
    if (stop !== undefined) {
      if (c.sha !== stop) {
        inside.push(c);
        continue;
      }
      // The recorded segment closed on the real chain: its interior is the loop's.
      stop = undefined;
      inside = [];
    }
    if (accepted.has(c.sha)) continue;
    const previous = segments.get(c.sha);
    if (previous !== undefined) stop = previous;
    else foreign.push(c);
  }
  // An unclosed segment proves nothing about the commits it would have covered.
  if (stop !== undefined && stop !== base) foreign.push(...inside);
  return { foreign, broken };
}

/** The push route of one central baseline branch, if that branch is pushed at all. */
export function mergePushRoute(
  state: CommandState,
  base_branch: string | undefined,
): MergePushDestination | undefined {
  const routes = state.project_settings?.merge_push ?? [];
  const route = routes.find((r) => r.base_branch === base_branch);
  return route && { target: route.target, branch: route.branch };
}

/**
 * Called only inside a successful merge transaction. Only the route of the
 * card's own baseline branch is queued; an unrouted branch stays central-only.
 */
export function queueMergedPush(
  d: CommandDraft,
  p: {
    merge_event_id: EventId;
    card_id: CardId;
    completion_id: DeliveryId;
    sha: string;
    base_branch: string | undefined;
  },
) {
  const { base_branch, ...queued } = p;
  const destination = mergePushRoute(d.state, base_branch);
  if (!destination) return;
  ensure(
    validDestination(destination),
    "validation_failed",
    "Invalid trusted push destination",
  );
  d.emit("merge_push_queued", undefined, {
    ...queued,
    ...destination,
    ...(base_branch === undefined ? {} : { base_branch }),
  });
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
    const route = (state.project_settings?.merge_push ?? []).find(
      (r) =>
        r.target === p.target &&
        r.branch === p.branch &&
        (p.base_branch === undefined || r.base_branch === p.base_branch),
    );
    ensure(route, "illegal_transition", "Push destination is not enabled");
    const base_branch = route.base_branch;
    const events = records(state, p.target, base_branch),
      last = control(events);
    if (last?.type === "merge_push_started") {
      const started = last.payload as unknown as MergePushAttempt;
      if (started.base_sha) return started;
      const base = pushBase(
        state,
        events,
        events.filter((e) => started.queue_ids.includes(e.id)),
      );
      return base
        ? { ...started, base_sha: base.sha, base_trusted: base.trusted }
        : started;
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
        base_branch,
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
    const base = pushBase(state, events, pending);
    ensure(base, "invariant_violation", "Push has no first-parent boundary");
    const failed =
      last?.type === "merge_push_failed"
        ? (last.payload as unknown as Finished)
        : undefined;
    const resolution =
      last?.type === "merge_push_hold_resolved"
        ? (last.payload as unknown as Resolved)
        : undefined;
    const acceptedHold =
      resolution?.mode === "accept"
        ? (events.find(
            (e) =>
              e.id === resolution.held_event_id && e.type === "merge_push_held",
          )?.payload as unknown as Held | undefined)
        : undefined;
    ensure(
      resolution?.mode !== "accept" || acceptedHold,
      "invariant_violation",
      "Accepted push hold is missing",
    );
    const action = failed?.human_action_id
      ? state.human_actions.find((h) => h.id === failed.human_action_id)
      : undefined;
    const authRetry =
      failed?.reason === "auth" &&
      failed.failure_count === 1 &&
      failed.next_retry_at !== undefined &&
      !failed.human_action_id;
    const blocked =
      resumed || (failed && failed.reason !== "network" && !authRetry);
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
    // automatic retry keeps the original attempt's range, never skips ahead.
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
      !targetRecords(state, p.target).some(
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
      base_branch,
      attempt_id: p.attempt_id,
      queue_ids: selected.map((e) => e.id),
      sha: target.sha,
      failure_count: blocked ? 0 : (failed?.failure_count ?? 0),
      // Accepting foreign commits resumes the pending range, not its auth
      // budget. Keep the linked hold's evidence across repeated/coalesced holds.
      // Reverts drop that range; a hold before any failure consumes no budget.
      ...((failed && (blocked || failed.auth_retry_used)) ||
      acceptedHold?.auth_retry_used ||
      (acceptedHold?.failure_count ?? 0) > 0
        ? { auth_retry_used: true as const }
        : {}),
      ...(!blocked && failed?.first_failed_at
        ? { first_failed_at: failed.first_failed_at }
        : {}),
      ...(!blocked && failed?.human_action_id
        ? { human_action_id: failed.human_action_id }
        : {}),
      base_sha: base.sha,
      base_trusted: base.trusted,
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
    | { status: "failed"; reason: MergePushFailure; exit_code?: number }
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
    ensure(
      p.status !== "failed" ||
        p.exit_code === undefined ||
        (Number.isSafeInteger(p.exit_code) && p.exit_code >= 0),
      "validation_failed",
      "Invalid push exit code",
    );
    // The attempt's own baseline branch selects its records, even if the
    // route was rebound while it ran.
    const own = targetRecords(state, p.target).find(
      (e) =>
        e.type === "merge_push_started" &&
        (e.payload as unknown as MergePushAttempt).attempt_id === p.attempt_id,
    );
    const events = records(
      state,
      p.target,
      own ? branchOf(state, p.target, own) : undefined,
    );
    const existing = events.find(
      (e) =>
        ["merge_pushed", "merge_push_failed"].includes(e.type) &&
        (e.payload as unknown as Finished).attempt_id === p.attempt_id,
    );
    if (existing) {
      const old = existing.payload as unknown as Finished;
      ensure(
        old.status === p.status &&
          old.reason === (p.status === "failed" ? p.reason : undefined) &&
          old.exit_code === (p.status === "failed" ? p.exit_code : undefined),
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
        authRetry =
          p.reason === "auth" && count === 1 && !attempt.auth_retry_used,
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
      if (
        !authRetry &&
        (p.reason !== "network" || now - Date.parse(first) > 2 * 60 * 60_000)
      ) {
        if (action?.status !== "open")
          action = humanAction(d, attempt, p.reason);
      }
      result = {
        ...attempt,
        status: "failed",
        reason: p.reason,
        ...(p.exit_code !== undefined ? { exit_code: p.exit_code } : {}),
        ...(authRetry ? { auth_retry_used: true as const } : {}),
        failure_count: count,
        first_failed_at: first,
        ...(p.reason === "network" || authRetry
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
            : p.reason === "auth" && result.next_retry_at
              ? `推送到 ${attempt.branch} 的身份或主机校验失败，将在一分钟后自动重试一次`
              : mergePushMessage(p.reason, attempt.branch),
      },
    );
    return result;
  });
}
const short = (sha: string) => sha.slice(0, 12);
function holdInstructions(
  action: HumanActionId,
  held: Omit<Held, "human_action_id">,
) {
  const { branch, base_sha = "", sha, foreign, foreign_count, reasons } = held;
  const lines = [`自动推送到远程 ${branch} 已暂停，系统没有推送。原因：`];
  if (reasons.includes("boundary"))
    lines.push(
      `- 这是该远程第一次自动推送（或之前没有成功推送记录），系统无法证明中心 ${branch} 在 ${short(base_sha)} 及以前的历史都可以发布。请先在主机上核对远程 ${branch} 已包含 ${short(base_sha)}（例如 git ls-remote 对比），或确认这段历史可以公开。`,
    );
  if (reasons.includes("foreign")) {
    lines.push(
      `- 中心 ${branch} 上有 ${foreign_count} 个提交不是合并流程产生的（新的在前）：`,
    );
    for (const c of foreign.slice(0, 20))
      lines.push(
        `  ${short(c.sha)}  作者 ${c.author}，提交者 ${c.committer}：${c.subject}`,
      );
    if (foreign_count > 20)
      lines.push(
        `  另有 ${foreign_count - 20} 个，完整列表见事件 merge_push_held`,
      );
  }
  if (reasons.includes("stale"))
    lines.push(
      `- 中心 ${branch} 已不再包含排队待推的合并 ${short(sha)}（可能被 reset 或强制改写）。`,
    );
  if (reasons.includes("broken"))
    lines.push(
      `- 中心 ${branch} 已接不上上次推送点 ${short(base_sha)}（历史被改写），远程也不会接受这样的推送。`,
    );
  if (reasons.includes("too_long") || reasons.includes("too_many"))
    lines.push(
      `- 待核对的提交超过 ${MERGE_PUSH_RANGE_LIMIT} 个或外来提交超过 ${ACCEPT_LIMIT} 个，无法逐个核对。`,
    );
  lines.push("处理方式：");
  if (held.acceptable)
    lines.push(
      `1）确认接受：运行 cardigan merge push-accept ${action} --text <说明>（只能由你本人在主机上执行），上面列出的提交${reasons.includes("boundary") ? `和 ${short(base_sha)} 以前的历史` : ""}从此视为可以发布，系统随后重新核对并推送。`,
    );
  lines.push(
    `${held.acceptable ? "2）" : ""}不接受：先在主机上把中心仓库 ${branch} 恢复到不含这些提交、且包含上次推送点的状态（例如回到 ${short(base_sha)}，再重新合并需要的卡片），然后在 Workbench 或用 cardigan human-action done ${action} 标记此事项完成。系统会丢弃这批已排队的推送，不信任任何提交；之后的合并推送前仍会重新核对中心 ${branch} 当前的最新提交。`,
  );
  return lines.join("\n");
}

/**
 * Pre-push check of the active attempt. The host reads, under the publication
 * lock, central main's current `head` and its whole first-parent chain down
 * to (excluding) base_sha. Everything on it must be loop-recorded or accepted,
 * the pushed SHA must still be on it, and the boundary must be evidenced.
 */
export function checkMergePushRange(
  state: CommandState,
  actor: Actor,
  p: {
    target: string;
    attempt_id: string;
    head: string;
    chain: readonly MergePushCommit[];
    truncated?: boolean;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "check_merge_push_range", ports, (d) => {
    ensure(
      fullSha.test(p.head) &&
        Array.isArray(p.chain) &&
        p.chain.length <= MERGE_PUSH_RANGE_LIMIT &&
        (p.truncated === undefined || typeof p.truncated === "boolean") &&
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
    const own = targetRecords(state, p.target).find(
      (e) =>
        e.type === "merge_push_started" &&
        (e.payload as unknown as MergePushAttempt).attempt_id === p.attempt_id,
    );
    const branch = own ? branchOf(state, p.target, own) : undefined;
    const events = records(state, p.target, branch),
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
      base = attempt.base_sha;
    ensure(base, "invariant_violation", "Push has no first-parent boundary");
    ensure(
      p.chain.length === 0 ? p.head === base : p.chain[0]?.sha === p.head,
      "validation_failed",
      "Range must start at the current head",
    );
    const { foreign, broken } = foreignMergePushCommits(
      state,
      p.target,
      base,
      p.chain,
      branch,
    );
    const reasons: MergePushHoldReason[] = [];
    if (attempt.base_trusted !== true) reasons.push("boundary");
    if (foreign.length) reasons.push("foreign");
    if (attempt.sha !== base && !p.chain.some((c) => c.sha === attempt.sha))
      reasons.push("stale");
    if (p.truncated) reasons.push("too_long");
    else if (broken) reasons.push("broken");
    if (foreign.length > ACCEPT_LIMIT) reasons.push("too_many");
    if (!reasons.length) return { status: "clear" as const };
    const acceptable = !reasons.some((r) =>
      ["stale", "broken", "too_long", "too_many"].includes(r),
    );
    const id = d.ids.next(d.state.project_id, "human_action");
    const body: Omit<Held, "human_action_id"> = {
      ...attempt,
      base_sha: base,
      head: p.head,
      reasons,
      acceptable,
      foreign: foreign.slice(0, SHOWN).map((c) => ({ ...c })),
      foreign_count: foreign.length,
      foreign_shas: acceptable ? foreign.map((c) => c.sha) : [],
    };
    const action: HumanAction = {
      id,
      key: id,
      requested_by: "system",
      status: "open",
      blocked_work_items: [],
      instructions: holdInstructions(id, body),
      why_human: "中心仓库可能被绕过合并流程写入，只有人能决定接受还是回退",
      expected_return: "说明接受或回退的结果并完成此事项",
    };
    d.put("human_actions", action);
    d.emit("human_action_requested", undefined, {
      human_action_id: id,
      blocked_work_items: [],
    });
    const held: Held = { ...body, human_action_id: id };
    d.emit("merge_push_held", undefined, {
      ...held,
      queue_ids: [...held.queue_ids],
      reasons: [...held.reasons],
      foreign: held.foreign.map((c) => ({ ...c })),
      foreign_shas: [...held.foreign_shas],
      description: `中心 ${attempt.branch} 未通过推送前核对（${reasons.join("、")}），自动推送已暂停`,
    });
    return { status: "held" as const, held };
  });
}

/** Human-only: trust exactly the held foreign SHAs (and an unevidenced boundary). */
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
      control(records(state, held.target, branchOf(state, held.target, event)))
        ?.id === event.id,
      "stale_target",
      "This push hold was already resolved",
    );
    ensure(
      held.acceptable === true,
      "illegal_transition",
      "This hold cannot be accepted; restore central main instead",
    );
    const action = completeActionDraft(d, {
      human_action_id: p.human_action_id,
      text: p.text,
    });
    const heldBranch = branchOf(state, held.target, event);
    d.emit("merge_push_hold_resolved", undefined, {
      target: held.target,
      branch: held.branch,
      ...(heldBranch === undefined ? {} : { base_branch: heldBranch }),
      held_event_id: event.id,
      human_action_id: p.human_action_id,
      mode: "accept",
      accepted: [...held.foreign_shas],
      ...(held.reasons.includes("boundary") && held.base_sha
        ? { boundary: held.base_sha }
        : {}),
      dropped_queue_ids: [],
      description: `已确认接受 ${held.foreign_count} 个外来提交${held.reasons.includes("boundary") ? "和首次推送起点" : ""}，恢复自动推送`,
    });
    return action;
  });
}
