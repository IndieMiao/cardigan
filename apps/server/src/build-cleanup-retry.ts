import type { ProjectId, TransactionContext } from "@cardigan/domain";
import type { WorkerGitRejection } from "@cardigan/runtime-herdr";
import type { ReconcileFindingRecord } from "@cardigan/store";

/**
 * C-791: a build checkout whose removal keeps failing is retried with an
 * exponential backoff instead of every cleanup round, and becomes one
 * reconcile finding for PM Ops instead of a log line per round.
 */
export const BUILD_CLEANUP_FINDING = "build_cleanup_rejected";
/** The first retry waits one default cleanup interval. */
export const BUILD_RETRY_BASE_MS = 60_000;
/** Later retries double up to this cap (also the wait after a human cause). */
export const BUILD_RETRY_MAX_MS = 6 * 60 * 60_000;
/** A cause that may pass by itself becomes a finding after this many in a row. */
export const BUILD_FINDING_AFTER = 3;

interface Retry {
  readonly failures: number;
  readonly next_at: number;
}

/** Process-local; a restart retries once and then backs off again. */
export class BuildCleanupRetries {
  private readonly entries = new Map<string, Retry>();
  private key(project_id: ProjectId, assignment_id: string) {
    return `${project_id}/${assignment_id}`;
  }
  due(project_id: ProjectId, assignment_id: string, now: number) {
    const entry = this.entries.get(this.key(project_id, assignment_id));
    return entry === undefined || now >= entry.next_at;
  }
  failed(
    project_id: ProjectId,
    assignment_id: string,
    now: number,
    human: boolean,
  ): Retry {
    const key = this.key(project_id, assignment_id);
    const failures = (this.entries.get(key)?.failures ?? 0) + 1;
    const wait = human
      ? BUILD_RETRY_MAX_MS
      : Math.min(BUILD_RETRY_MAX_MS, BUILD_RETRY_BASE_MS * 2 ** (failures - 1));
    const entry = { failures, next_at: now + wait };
    this.entries.set(key, entry);
    return entry;
  }
  forget(project_id: ProjectId, assignment_id: string) {
    this.entries.delete(this.key(project_id, assignment_id));
  }
  /** C-666: a low-space reclaim retries every build now. */
  reset(project_id: ProjectId) {
    for (const key of this.entries.keys())
      if (key.startsWith(`${project_id}/`)) this.entries.delete(key);
  }
}

const REASONS: Readonly<Record<WorkerGitRejection, string>> = {
  not_empty: "目录非空",
  permission: "没有删除权限",
  unsafe_directory: "目录的权限位或属主不符",
  busy: "仓库锁一直被占",
  remove_failed: "删除失败",
};
export function buildCleanupDetail(input: {
  readonly machine_id: string;
  readonly reason: WorkerGitRejection | undefined;
  readonly human: boolean;
  readonly failures: number;
}) {
  const reason = input.reason
    ? REASONS[input.reason]
    : "未给出原因（旧版 helper 或连接错误）";
  return `${input.machine_id} 上的构建目录连续 ${input.failures} 次清理失败：${reason}；${
    input.human ? "需要人处理，处理后自动消除" : "已退避重试"
  }`;
}

/** The project-level event that routes a new finding to PM Ops (6.4). */
export function appendFindingEvent(
  tx: TransactionContext,
  project_id: ProjectId,
  finding: ReconcileFindingRecord,
  at: string,
) {
  const seq = tx.ids.nextEventSequence(project_id, undefined);
  tx.events.append(project_id, {
    id: tx.ids.nextEventId(),
    seq,
    type: "reconcile_finding",
    actor: { kind: "system", project_id },
    payload: {
      kind: finding.kind,
      detail: finding.detail,
      first_seen_at: finding.first_seen_at,
      ...(finding.path === undefined ? {} : { path: finding.path }),
      ...(finding.assignment_id === undefined
        ? {}
        : { assignment_id: finding.assignment_id }),
      ...(finding.delivery_id === undefined
        ? {}
        : { delivery_id: finding.delivery_id }),
    },
    created_at: at,
  });
}
