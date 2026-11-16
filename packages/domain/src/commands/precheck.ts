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
  head(assignment: Assignment): Promise<string>;
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
  } catch {
    return attempt((): never => {
      ensure(
        false,
        "validation_failed",
        "无法读取当前产出分支HEAD，请核对Git检查环境",
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
      !p.summary || validPrecheckSummary(p.summary),
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
            : `作者预检查结束：${p.status}${p.summary ? `；${p.summary}` : ""}`,
      },
    );
    return precheckView(p);
  });
}
