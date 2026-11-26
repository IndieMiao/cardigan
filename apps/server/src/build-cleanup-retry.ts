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

/** Host-configurable (`CARDIGAN_BUILD_RETRY_BASE_MS` / `_MAX_MS`). */
export interface BuildRetryPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
}

interface Retry {
  readonly failures: number;
  readonly next_at: number;
}

/**
 * Per Assignment backoff. The in-memory schedule is rebuilt after a restart
 * from the open finding (`restore`): the next try waits the cap after its
 * last failure, so a restart neither forgets it nor skips it for good.
 */
export class BuildCleanupRetries {
  private readonly entries = new Map<string, Retry>();
  readonly policy: BuildRetryPolicy;
  constructor(policy: Partial<BuildRetryPolicy> = {}) {
    const maxMs = policy.maxMs ?? BUILD_RETRY_MAX_MS;
    this.policy = {
      baseMs: Math.min(policy.baseMs ?? BUILD_RETRY_BASE_MS, maxMs),
      maxMs,
    };
  }
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
    const { baseMs, maxMs } = this.policy;
    const wait = human
      ? maxMs
      : Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 52));
    const entry = { failures, next_at: now + wait };
    this.entries.set(key, entry);
    return entry;
  }
  /** After a restart: an open finding last confirmed at `last_failure`. */
  restore(project_id: ProjectId, assignment_id: string, last_failure: number) {
    const key = this.key(project_id, assignment_id);
    if (this.entries.has(key) || !Number.isFinite(last_failure)) return;
    this.entries.set(key, {
      failures: BUILD_FINDING_AFTER,
      next_at: last_failure + this.policy.maxMs,
    });
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
