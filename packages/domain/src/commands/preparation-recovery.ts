import { assignmentCardId } from "../card-hold.js";
import type {
  Actor,
  Assignment,
  Card,
  Event,
  Run,
  RuntimeRef,
  WorkItem,
} from "../entities.js";
import { eventsOfType, eventsOfTypes } from "../event-index.js";
import { automaticContextActionForRun, hostOpsPending } from "../host-ops.js";
import type { RunId } from "../ids.js";
import { preparationRetryWaiting } from "../preparation-retry.js";
import { runById } from "../run-index.js";
import { recoveryPolicy, recoveryTargetCurrent } from "../run-recovery.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { unreadableCommentTrigger } from "./dispatch-recovery.js";
import { checkEmployeeSeparation } from "./employee-assignment.js";
import { launchSettings } from "./launch.js";
import { stoppedByHuman } from "./stop-state.js";
import { readyDeployment } from "./work-waits.js";

/** Short-lived contention: the first retry may use the short host backoff. */
const TRANSIENT_CATEGORIES: readonly string[] = [
  "preparation_queue_timeout",
  "repository_lock_timeout",
  "git_lock_conflict",
  "git_network",
  "git_timeout",
];
/** C-738: other failures retry on the long schedule, then go to PM. */
const SLOW_CATEGORIES: readonly string[] = [
  "prepare_failed",
  "git_failed",
  "runtime_failed",
];
/** C-738: explicit permission or configuration errors are never retried. */
export const PREPARATION_NO_RETRY_CATEGORIES: readonly string[] = [
  "permission_denied",
  "config_error",
];
/** C-738: 5, 15 and 60 minutes; the host may configure its own schedule. */
export const DEFAULT_PREPARATION_RETRY_SCHEDULE_MS: readonly number[] = [
  300_000, 900_000, 3_600_000,
];
const MAX_SCHEDULE_LENGTH = 10;
const MAX_DELAY_MS = 2_147_483_647;
const validDelay = (ms: unknown) =>
  Number.isSafeInteger(ms) && Number(ms) > 0 && Number(ms) <= MAX_DELAY_MS;

/** This Run and its preparation predecessors, newest first. */
function preparationChain(state: CommandState, run: Run): Run[] {
  const chain = [run];
  const seen = new Set<string>([run.id]);
  let current = run;
  while (current.preparation_retry) {
    const source = runById(state.runs, current.preparation_retry.source_run_id);
    if (
      !source ||
      seen.has(source.id) ||
      source.assignment_id !== run.assignment_id
    )
      break;
    seen.add(source.id);
    chain.push(source);
    current = source;
  }
  return chain;
}

const field = (e: Event, key: string) =>
  (e.payload as Record<string, unknown> | null)?.[key];

/** A version-six chain that already used its dispatch recovery stays with the existing escalation. */
function dispatchRecoveryUsed(state: CommandState, run: Run): boolean {
  const policy = recoveryPolicy(state, run);
  return (
    !!policy &&
    eventsOfType(state.events, "run_dispatch_recovered").some(
      (e) =>
        e.actor.kind === "system" &&
        field(e, "assignment_id") === run.assignment_id &&
        field(e, "reason") !== "provider_unavailable" &&
        field(e, "recovery_root_run_id") === policy.root_run_id,
    )
  );
}

interface Target {
  readonly a: Assignment;
  readonly card: Card | undefined;
  readonly item: WorkItem | undefined;
}

/** The cancelled preparation failure is still the Assignment's latest, idle Run. */
function settleTarget(d: CommandDraft, run: Run): Target | undefined {
  const state = d.state;
  const a = d.get("assignments", run.assignment_id);
  if (
    automaticContextActionForRun(state.events, run) ||
    unreadableCommentTrigger(state, run)
  )
    return;
  const sourceCard = assignmentCardId(a, state, run.trigger_event_id);
  const card = sourceCard ? d.get("cards", sourceCard) : undefined;
  const item =
    a.scope === "work_item" ? d.get("work_items", a.work_item_id) : undefined;
  if (
    card?.hold ||
    a.external ||
    a.status !== "active" ||
    run.status !== "cancelled" ||
    run.started_at ||
    run.dispatch_stop ||
    run.inactivity_stop ||
    hostOpsPending(state.events, a.id) ||
    stoppedByHuman(state.events, a.id) ||
    (card && ["done", "cancelled"].includes(card.status)) ||
    a.role_version !== run.role_version ||
    (item && (item.assignment_id !== a.id || item.role_id !== a.role_id)) ||
    !eventsOfType(state.events, "run_dispatch_aborted").some(
      (e) =>
        field(e, "run_id") === run.id &&
        field(e, "reason") === "directory preparation failed",
    ) ||
    state.runs.some(
      (r) =>
        r.assignment_id === a.id &&
        r.id !== run.id &&
        (Number(r.id.slice(2)) > Number(run.id.slice(2)) ||
          !["completed", "failed", "cancelled"].includes(r.status) ||
          r.dispatch_stop ||
          r.inactivity_stop),
    )
  )
    return;
  const policy = recoveryPolicy(state, run);
  if (policy && !recoveryTargetCurrent(state, run)) return;
  return { a, card, item };
}

/** Queue the durable successor; the cancelled source is never revived. */
function queueSuccessor(
  d: CommandDraft,
  run: Run,
  { a, card }: Target,
  p: {
    readonly ready_at: string;
    readonly category: string;
    readonly body: (id: RunId) => string;
    readonly diagnosis: Record<string, string | number>;
  },
): Run {
  const state = d.state;
  const policy = recoveryPolicy(state, run);
  if (policy && a.scope === "work_item")
    checkEmployeeSeparation(d, d.work(a.work_item_id), a.employee_id);
  const id = d.ids.next(state.project_id, "run");
  const body = p.body(id);
  const event = d.emit(
    "run_preparation_recovered",
    card?.id,
    {
      run_id: run.id,
      assignment_id: a.id,
      replacement_run_id: id,
      original_trigger_event_id: run.trigger_event_id,
      category: p.category,
      ready_at: p.ready_at,
      ...p.diagnosis,
      ...(policy
        ? {
            recovery_root_run_id: policy.root_run_id,
            recovery_policy: policy.version,
          }
        : {}),
      body,
    },
    { type: "system", body, run_id: run.id },
  );
  const next: Run = {
    id,
    assignment_id: a.id,
    trigger_event_id: event.id,
    kind: run.kind,
    status: "queued",
    ...(policy ? { recovery_policy: policy } : {}),
    role_version: run.role_version,
    model: run.model,
    agent_cli_version: run.agent_cli_version,
    ...launchSettings(run),
    ...(run.employee_id ? { employee_id: run.employee_id } : {}),
    ...(run.launch_profile_ref
      ? { launch_profile_ref: run.launch_profile_ref }
      : {}),
    preparation_retry: { source_run_id: run.id, ready_at: p.ready_at },
    outcome: null,
    summary: "",
  };
  d.put("runs", next);
  return next;
}

const minutes = (ms: number) =>
  ms < 60_000
    ? `${Math.ceil(ms / 1000)} 秒`
    : `${Math.round(ms / 60_000)} 分钟`;
const reasonText = (category: string, message?: string) =>
  message ? `${category}：${message}` : category;

/** Host-only settlement after preparation failed, before any token/provision. */
export function recoverPreparation(
  state: CommandState,
  actor: Actor,
  p: {
    run_id: RunId;
    category: string;
    /** Redacted first line of the failure, for the diagnosis. */
    message?: string;
    execution_exited: boolean;
    cleanup_complete: boolean;
    expected_runtime_ref: RuntimeRef | null;
    backoff_ms: number;
    /** C-738: delay before each automatic retry; its length is the retry limit. */
    retry_schedule_ms?: readonly number[];
  },
  ports: CommandPorts,
) {
  return command(state, actor, "recover_dispatch", ports, (d) => {
    const schedule =
      p.retry_schedule_ms ?? DEFAULT_PREPARATION_RETRY_SCHEDULE_MS;
    ensure(
      validDelay(p.backoff_ms) &&
        Array.isArray(schedule) &&
        schedule.length >= 1 &&
        schedule.length <= MAX_SCHEDULE_LENGTH &&
        schedule.every(validDelay),
      "validation_failed",
      "Invalid preparation backoff",
    );
    // Host-redacted first line; bounded here so a long line never loses the settlement.
    const message =
      typeof p.message === "string" && p.message.trim()
        ? p.message.trim().slice(0, 300)
        : undefined;
    const run = d.get("runs", p.run_id);
    const recorded = eventsOfTypes(state.events, [
      "run_preparation_recovered",
      "run_preparation_stalled",
    ]).find((e) => field(e, "run_id") === run.id);
    if (recorded) return;
    const target = settleTarget(d, run);
    if (
      !target ||
      JSON.stringify(target.a.runtime_ref) !==
        JSON.stringify(p.expected_runtime_ref)
    )
      return;
    const { a, card } = target;
    const policy = recoveryPolicy(state, run);
    const chain = preparationChain(state, run);
    // Retries already spent by this chain (an after-deployment retry counts too).
    const used = chain.length - 1;
    const safe = p.execution_exited && p.cleanup_complete;
    const transient = TRANSIENT_CATEGORIES.includes(p.category);
    const retryable =
      safe &&
      !PREPARATION_NO_RETRY_CATEGORIES.includes(p.category) &&
      (transient ||
        SLOW_CATEGORIES.includes(p.category) ||
        // The version-six runtime_unavailable recovery stays a single retry.
        !!(
          policy &&
          used === 0 &&
          p.category === "runtime_unavailable" &&
          p.expected_runtime_ref === null
        )) &&
      !dispatchRecoveryUsed(state, run);
    const reason = reasonText(p.category, message);
    const diagnosis = {
      ...(message ? { message } : {}),
      attempt: used + 1,
      max_retries: schedule.length,
    };
    if (retryable && used < schedule.length) {
      const delay =
        used === 0 && transient ? p.backoff_ms : (schedule[used] as number);
      return queueSuccessor(d, run, target, {
        ready_at: new Date(Date.parse(d.now) + delay).toISOString(),
        category: p.category,
        diagnosis,
        body: (id) =>
          `工作目录准备失败（${reason}），第 ${used + 1}/${schedule.length} 次自动重试已排队为 ${id}，${minutes(delay)}后再试。`,
      });
    }
    const chainIds = new Set(chain.map((r) => r.id));
    if (retryable) {
      // C-738: the retry budget is used up — PM decides, not host ops.
      const body = `工作目录准备连续失败 ${used + 1} 次（已自动重试 ${used} 次），最近一次原因：${reason}。建议：先核对这个错误是否已修复，修复后重新启动该指派；无法在本机修复时改派机器或暂停卡片。每次部署完成后系统还会自动再试一次。`;
      d.emit(
        "run_preparation_stalled",
        card?.id,
        {
          run_id: run.id,
          assignment_id: a.id,
          category: p.category,
          ...diagnosis,
          exhausted: true,
          body,
          ...(policy ? { recovery_root_run_id: policy.root_run_id } : {}),
        },
        { type: "system", body, run_id: run.id },
      );
      // One open PM handoff per chain; repeated after-deployment failures only add the event.
      const open = new Set(
        state.human_actions.filter((h) => h.status === "open").map((h) => h.id),
      );
      if (
        eventsOfType(state.events, "human_action_requested").some(
          (e) =>
            open.has(field(e, "human_action_id") as never) &&
            chainIds.has(field(e, "preparation_run_id") as never),
        )
      )
        return;
      const id = d.ids.next(state.project_id, "human_action");
      d.put("human_actions", {
        id,
        key: id,
        requested_by: "system",
        status: "open",
        triage: "pm_ops",
        ...(card ? { card_id: card.id } : {}),
        blocked_work_items: [],
        instructions: body,
        why_human: "工作目录准备自动重试已用尽，需要 PM 判断后续处理。",
        expected_return:
          "说明处理结果（已修复并重新启动、改派或暂停）后标记完成",
      });
      d.emit(
        "human_action_requested",
        card?.id,
        {
          human_action_id: id,
          blocked_work_items: [],
          preparation_run_id: run.id,
        },
        { type: "human_action", body, human_action_id: id },
      );
      return;
    }
    // Do not silently retry permission/path failures or an uncertain remote process.
    const why = PREPARATION_NO_RETRY_CATEGORIES.includes(p.category)
      ? "属于权限或配置错误，不自动重试"
      : run.preparation_retry
        ? "未满足安全重试条件，自动重试停止"
        : "未满足安全重试条件";
    const body = `工作目录准备失败（${reason}），${why}；请主机运维核查。`;
    d.emit(
      "run_preparation_stalled",
      card?.id,
      {
        run_id: run.id,
        assignment_id: a.id,
        category: p.category,
        ...diagnosis,
        body,
        ...(policy ? { recovery_root_run_id: policy.root_run_id } : {}),
      },
      { type: "system", body, run_id: run.id },
    );
    const id = d.ids.next(state.project_id, "human_action");
    d.put("human_actions", {
      id,
      key: id,
      requested_by: "system",
      status: "open",
      triage: "human",
      ...(card ? { card_id: card.id } : {}),
      blocked_work_items: [],
      instructions: body,
      why_human: "准备失败未能自动恢复，需要核查主机执行状态。",
      expected_return: "核实旧执行退出，说明恢复结果并标记完成",
    });
    d.emit(
      "human_action_requested",
      card?.id,
      {
        human_action_id: id,
        blocked_work_items: [],
        preparation_run_id: run.id,
      },
      { type: "human_action", body, human_action_id: id },
    );
  });
}

/** Cheap gate for host maintenance: is any preparation failure waiting that a deployment could retry? */
export function preparationAwaitsDeployment(
  state: CommandState,
  now: string,
): boolean {
  if (
    state.runs.some(
      (r) =>
        r.status === "queued" &&
        !r.preparation_retry?.expedited &&
        preparationRetryWaiting(r, now),
    )
  )
    return true;
  const stalls = eventsOfType(state.events, "run_preparation_stalled").filter(
    (e) => field(e, "exhausted") === true,
  );
  if (!stalls.length) return false;
  const retried = new Set(
    eventsOfType(state.events, "run_preparation_recovered").map((e) =>
      field(e, "run_id"),
    ),
  );
  return stalls.some((e) => {
    const run = runById(state.runs, field(e, "run_id"));
    return (
      run?.status === "cancelled" &&
      !retried.has(run.id) &&
      !state.runs.some(
        (r) =>
          r.assignment_id === run.assignment_id &&
          Number(r.id.slice(2)) > Number(run.id.slice(2)),
      )
    );
  });
}

/**
 * C-738: after a ready deployment, retry each preparation failure recorded
 * before it once — end a pending backoff early, or queue one more retry for a
 * chain whose budget is used up. Permission/config stalls are never retried.
 */
export function retryPreparationAfterDeployment(
  state: CommandState,
  actor: Actor,
  p: { sha: string },
  ports: CommandPorts,
) {
  return command(state, actor, "recover_dispatch", ports, (d) => {
    ensure(
      typeof p.sha === "string" && /^[a-f0-9]{40}$/u.test(p.sha),
      "validation_failed",
      "部署记录需要完整提交 SHA",
    );
    const deployment = readyDeployment(d, p.sha);
    if (!deployment) return { expedited: [], queued: [] };
    const deployedAt = Date.parse(deployment.at);
    const before = (e: Event | undefined) =>
      !!e && Date.parse(e.created_at) < deployedAt;
    const expedited: RunId[] = [];
    const queued: RunId[] = [];
    const recoveredFor = new Map<string, Event>();
    for (const e of eventsOfType(state.events, "run_preparation_recovered")) {
      const id = field(e, "replacement_run_id");
      if (typeof id === "string") recoveredFor.set(id, e);
    }
    for (const run of state.runs) {
      if (
        run.status !== "queued" ||
        run.started_at ||
        run.bell_delivery ||
        run.launch_publication ||
        !run.preparation_retry ||
        run.preparation_retry.expedited ||
        !preparationRetryWaiting(run, d.now)
      )
        continue;
      const recovered = recoveredFor.get(run.id);
      if (
        recovered?.id !== run.trigger_event_id ||
        recovered.actor.kind !== "system" ||
        !before(recovered)
      )
        continue;
      const a = state.assignments.find((x) => x.id === run.assignment_id);
      if (a?.status !== "active" || a.external) continue;
      d.put("runs", {
        ...run,
        preparation_retry: {
          ...run.preparation_retry,
          expedited: { at: d.now, deployment: deployment.key },
        },
      });
      const body = `部署 ${p.sha.slice(0, 7)} 已完成，${run.id} 提前重试工作目录准备。`;
      d.emit(
        "run_preparation_expedited",
        recovered.card_id,
        {
          run_id: run.id,
          assignment_id: run.assignment_id,
          deployment: deployment.key,
          sha: p.sha,
          body,
        },
        { type: "system", body, run_id: run.id },
      );
      expedited.push(run.id);
    }
    const handled = new Set<string>();
    for (const stalled of eventsOfType(
      state.events,
      "run_preparation_stalled",
    )) {
      const run = runById(state.runs, field(stalled, "run_id"));
      if (
        !run ||
        handled.has(run.id) ||
        field(stalled, "exhausted") !== true ||
        stalled.actor.kind !== "system" ||
        !before(stalled) ||
        PREPARATION_NO_RETRY_CATEGORIES.includes(
          String(field(stalled, "category")),
        ) ||
        eventsOfType(state.events, "run_preparation_recovered").some(
          (e) => field(e, "run_id") === run.id,
        )
      )
        continue;
      handled.add(run.id);
      const target = settleTarget(d, run);
      if (!target || dispatchRecoveryUsed(state, run)) continue;
      const category = String(field(stalled, "category"));
      const attempts = preparationChain(state, run).length;
      const next = queueSuccessor(d, run, target, {
        ready_at: d.now,
        category,
        diagnosis: {
          attempt: attempts,
          after_deployment: deployment.key,
          sha: p.sha,
        },
        body: (id) =>
          `部署 ${p.sha.slice(0, 7)} 已完成，工作目录准备（此前连续失败 ${attempts} 次，最近一次原因：${category}）自动再试一次，已排队为 ${id}。`,
      });
      queued.push(next.id);
    }
    return { expedited, queued };
  });
}
