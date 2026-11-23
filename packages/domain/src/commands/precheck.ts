import type { Actor, Assignment } from "../entities.js";
import { flowAtLeast } from "../flow.js";
import type { WorkItemId } from "../ids.js";
import {
  type Precheck,
  prechecks,
  precheckView,
  validPrecheckSummary,
} from "../precheck.js";
import {
  attempt,
  CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

export interface RequestCheckParams {
  readonly work_item_id: WorkItemId;
}
export interface CheckHeadReader {
  /** Rejects with a {@link CheckHeadFailure} when the host knows why. */
  head(assignment: Assignment): Promise<string>;
}
/**
 * Why the host could not read the recorded branch HEAD. Retryable reasons are
 * transient host conditions; the rest are real branch or setup errors.
 */
export const checkHeadFailureReasons = [
  "repository_busy",
  "fetch_failed",
  "repository_failed",
  "environment_unavailable",
  "branch_missing",
  "object_mismatch",
  "ownership_mismatch",
] as const;
export type CheckHeadFailureReason = (typeof checkHeadFailureReasons)[number];
/** Host-side classification; carries no Git output, paths or credentials. */
export class CheckHeadFailure extends Error {
  constructor(
    readonly reason: CheckHeadFailureReason,
    options?: { readonly cause?: unknown },
  ) {
    super(`Check HEAD failed: ${reason}`, options);
    this.name = "CheckHeadFailure";
  }
}
const checkHeadMessages: Readonly<
  Record<CheckHeadFailureReason | "unknown", string>
> = {
  repository_busy:
    "主机仓库忙，已自动重试到总时限仍未取得仓库锁；请稍后用新的幂等键重新 request_check，持续出现再报告阻塞",
  fetch_failed:
    "主机从工作机拉取登记分支失败；请稍后用新的幂等键重试，持续失败再报告阻塞请主机运维排查工作机连接",
  repository_failed: "主机读写中央仓库失败；请报告阻塞请主机运维排查中央仓库",
  environment_unavailable:
    "主机未配置或无法使用本项目的Git检查环境；请报告阻塞请主机运维排查",
  branch_missing:
    "登记分支在工作机上不存在或没有提交；请在登记分支上提交后再 request_check",
  object_mismatch: "登记分支HEAD不是提交对象；请核对登记分支后再 request_check",
  ownership_mismatch:
    "登记分支、工作目录或工作机与当前负责人不符；请用 whoami 核对，仍不符时报告阻塞",
  unknown:
    "无法读取当前产出分支HEAD（未分类原因）；请稍后用新的幂等键重试，持续失败再报告阻塞请主机运维查看服务端日志",
};
const retryableReasons: ReadonlySet<CheckHeadFailureReason> = new Set([
  "repository_busy",
  "fetch_failed",
]);
function checkHeadReason(error: unknown): CheckHeadFailureReason | undefined {
  if (error instanceof CheckHeadFailure) return error.reason;
  // Tolerates duplicated module instances; only known reasons are trusted.
  const reason =
    error instanceof Error && error.name === "CheckHeadFailure"
      ? (error as { reason?: unknown }).reason
      : undefined;
  return checkHeadFailureReasons.find((r) => r === reason);
}
const sha = (s: unknown): s is string =>
  typeof s === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(s);
function inspect(d: CommandDraft, p: RequestCheckParams) {
  const a = d.assignment;
  ensure(
    d.actor.kind === "assignment" &&
      a?.scope === "work_item" &&
      a.status === "active",
    "unauthorized",
    "只有当前产出负责人可以请求预检查",
  );
  const item = d.ownWork(p.work_item_id);
  ensure(
    item.kind === "produce" &&
      item.assignment_id === a.id &&
      a.work_item_id === item.id &&
      !!a.branch &&
      !!a.worktree_path,
    "unauthorized",
    "只能检查本产出项的登记分支",
  );
  const card = d.card(item.card_id);
  ensure(!card.hold, "illegal_transition", "卡片已暂停，请先解除暂停");
  ensure(
    flowAtLeast(card, 3),
    "illegal_transition",
    "本卡流程版本尚不支持 request_check",
  );
  ensure(
    !["done", "cancelled"].includes(card.status) && item.status !== "cancelled",
    "illegal_transition",
    "已关闭事项不能请求预检查",
  );
  ensure(
    !prechecks(d.state.events).some(
      (c) =>
        c.assignment_id === a.id && ["queued", "running"].includes(c.status),
    ),
    "illegal_transition",
    "本负责人已有排队或运行中的预检查",
  );
  return { a, item, card };
}
const proof = Symbol("host-verified-check-head");
interface VerifiedCheck {
  readonly [proof]: true;
  readonly source: string;
  readonly head: string;
}
const source = (a: Assignment) =>
  JSON.stringify([
    a.id,
    a.role_id,
    a.role_version,
    a.machine_id,
    a.branch,
    a.worktree_path,
  ]);
export async function prepareCheck(
  state: CommandState,
  actor: Actor,
  p: RequestCheckParams,
  reader: CheckHeadReader,
) {
  const checked = attempt(() =>
    inspect(new CommandDraft(state, actor, "request_check"), p),
  );
  if (!checked.ok) return checked;
  try {
    const head = await reader.head(checked.value.a);
    return attempt((): VerifiedCheck => {
      ensure(sha(head), "validation_failed", "主机未取得有效分支HEAD");
      return { [proof]: true, source: source(checked.value.a), head };
    });
  } catch (error) {
    const reason = checkHeadReason(error);
    return attempt((): never => {
      // Only the fixed reason and message leave the host, never the raw error.
      ensure(
        false,
        "validation_failed",
        checkHeadMessages[reason ?? "unknown"],
        {
          reason: reason ?? "unknown",
          retryable: reason === undefined || retryableReasons.has(reason),
        },
      );
    });
  }
}
export function requestCheck(
  state: CommandState,
  actor: Actor,
  p: RequestCheckParams,
  receipt: VerifiedCheck,
  ports: CommandPorts,
) {
  return command(state, actor, "request_check", ports, (d) => {
    const { a, item, card } = inspect(d, p);
    ensure(
      receipt?.[proof] && receipt.source === source(a) && sha(receipt.head),
      "stale_target",
      "预检查负责人或登记分支已变化",
    );
    ensure(a.branch, "stale_target", "登记分支已变化");
    const check: Precheck = {
      attempt_id: d.ids.nextEventId(),
      assignment_id: a.id,
      work_item_id: item.id,
      card_id: card.id,
      head_sha: receipt.head,
      branch: a.branch,
      machine_id: a.machine_id,
      status: "queued",
    };
    const e = d.emit(
      "precheck_queued",
      card.id,
      JSON.parse(JSON.stringify(check)),
      {
        type: "system",
        work_item_id: item.id,
        body: `作者预检查已排队（${receipt.head}）`,
      },
    );
    // A validated command creates this system fact; no caller-supplied actor or evidence.
    d.events[d.events.length - 1] = {
      ...e,
      actor: { kind: "system", project_id: state.project_id },
    };
    return precheckView(check);
  });
}
export function recordPrecheck(
  state: CommandState,
  actor: Actor,
  p: Precheck,
  ports: CommandPorts,
) {
  return command(state, actor, "record_precheck", ports, (d) => {
    const old = prechecks(state.events).find(
      (c) => c.attempt_id === p.attempt_id,
    );
    ensure(
      old && ["queued", "running"].includes(old.status),
      "stale_target",
      "预检查已结束或不存在",
    );
    for (const key of [
      "assignment_id",
      "work_item_id",
      "card_id",
      "head_sha",
      "branch",
      "machine_id",
    ] as const)
      ensure(p[key] === old[key], "stale_target", "预检查身份不匹配");
    ensure(
      (p.status !== "queued" ||
        (old.status === "queued" && sha(p.candidate_sha))) &&
        (old.status !== "running" || p.status !== "running"),
      "illegal_transition",
      "预检查状态迁移无效",
    );
    if (["running", "passed", "failed", "timed_out"].includes(p.status))
      ensure(
        sha(p.candidate_sha) && sha(p.tree_sha) && sha(p.base_sha),
        "validation_failed",
        "检查结果缺少候选身份",
      );
    for (const key of [
      "candidate_sha",
      "tree_sha",
      "base_sha",
      "executor",
      "external_run",
    ] as const)
      if (old[key] !== undefined)
        ensure(
          JSON.stringify(old[key]) === JSON.stringify(p[key]),
          "stale_target",
          "检查候选或远程身份已变化",
        );
    if (
      p.executor?.type === "github" &&
      ["running", "passed", "failed", "timed_out"].includes(p.status)
    )
      ensure(
        p.external_run?.provider === "github" &&
          p.external_run.run_attempt === 1 &&
          Number.isSafeInteger(p.external_run.run_id) &&
          p.external_run.run_id > 0 &&
          sha(p.external_run.workflow_sha) &&
          /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/actions\/runs\/\d+$/u.test(
            p.external_run.html_url,
          ),
        "validation_failed",
        "GitHub检查缺少受信run绑定",
      );
    if (p.status === "passed")
      ensure(
        old.status === "running" &&
          p.checks?.length &&
          p.checks.every((c) => c.status === "passed" && c.exit_code === 0),
        "validation_failed",
        "预检查通过须有完整成功步骤",
      );
    if (p.failure_kind !== undefined)
      ensure(
        p.failure_kind === "candidate_conflict" &&
          ["environment_failed", "interrupted"].includes(p.status) &&
          old.status === "queued" &&
          !p.candidate_sha &&
          !p.external_run &&
          sha(p.base_sha),
        "validation_failed",
        "候选冲突必须来自执行前的候选准备阶段",
      );
    const a = d.list("assignments").find((a) => a.id === old.assignment_id);
    const item = d.work(old.work_item_id),
      card = d.card(old.card_id);
    const current =
      a?.status === "active" &&
      a.scope === "work_item" &&
      item.assignment_id === a.id &&
      a.work_item_id === item.id &&
      a.machine_id === old.machine_id &&
      a.branch === old.branch &&
      !["done", "cancelled"].includes(card.status);
    ensure(
      current || p.status === "interrupted",
      "stale_target",
      "预检查负责人已失效",
    );
    ensure(
      p.log_ref === undefined || p.log_ref === `${p.attempt_id}.log`,
      "validation_failed",
      "日志引用无效",
    );
    ensure(
      !p.summary ||
        validPrecheckSummary(
          p.summary,
          old.executor?.type === "github" ? old.external_run : undefined,
        ),
      "validation_failed",
      "预检查摘要含不安全路径",
    );
    d.emit(
      p.status === "queued"
        ? "precheck_queued"
        : p.status === "running"
          ? "precheck_started"
          : "precheck_finished",
      old.card_id,
      JSON.parse(JSON.stringify(p)),
      {
        type: "system",
        work_item_id: old.work_item_id,
        body:
          p.status === "running"
            ? "作者预检查运行中"
            : `作者预检查结束：${p.status}${p.summary ? `；${p.summary}` : ""}。提交：${old.head_sha}；日志：get_check_log(card_id=${old.card_id}, attempt_id=${p.attempt_id})`,
      },
    );
    return precheckView(p);
  });
}
