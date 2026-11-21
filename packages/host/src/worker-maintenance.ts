import { type Clock, requestDeploymentAction } from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { workerHelperDigests } from "./worker-helper-release.js";

function notify(
  tx: StoreTransactionContext,
  project: string,
  clock: Clock,
  key: string,
  instructions: string,
) {
  persistEffect(
    tx,
    project,
    unwrap(
      requestDeploymentAction(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        { key, reason: "worker_maintenance", instructions },
        { ids: tx.ids, clock },
      ),
    ),
  );
}
export function notifyHelperMismatch(
  tx: StoreTransactionContext,
  project: string,
  machine: string,
  clock: Clock,
  reason: string,
) {
  const digests = workerHelperDigests();
  notify(
    tx,
    project,
    clock,
    `worker-helper:${machine}:${Object.values(digests).join(":")}`,
    `机器 ${machine}：${reason}。请主机运维协调管理员从当前控制主机 release 的 deploy 取以下文件，逐一核验 SHA-256，按对应平台 worker 安装文档以 root 替换私有配置指定的 helper，保持属主和权限，然后重新运行 machine check。\n${Object.entries(
      digests,
    )
      .map(([name, sha]) => `${sha}  ${name}`)
      .join("\n")}`,
  );
}
// Called in the publication transition transaction, once per generation outcome.
export function workerPreparationOutcome(
  store: Store,
  tx: StoreTransactionContext,
  project: string,
  machine: string,
  target: string,
  clock: Clock,
  failure: string | null,
  policy = { failures: 3, duration_ms: 30 * 60 * 1000 },
) {
  if (failure === null) {
    store.database
      .prepare(
        "DELETE FROM worker_preparation_health WHERE project_id=? AND machine_id=? AND target=?",
      )
      .run(project, machine, target);
    return;
  }
  const now = clock.now();
  const previous = store.database
    .prepare(
      "SELECT failures,cooldown_until FROM worker_preparation_health WHERE project_id=? AND machine_id=? AND target=?",
    )
    .get(project, machine, target);
  const expired =
    typeof previous?.cooldown_until === "string" &&
    previous.cooldown_until <= now;
  const count = previous && !expired ? Number(previous.failures) + 1 : 1;
  const until =
    count >= policy.failures
      ? new Date(Date.parse(now) + policy.duration_ms).toISOString()
      : null;
  store.database
    .prepare(`INSERT INTO worker_preparation_health VALUES (?,?,?,?,?)
    ON CONFLICT(project_id,machine_id,target) DO UPDATE SET failures=excluded.failures, cooldown_until=excluded.cooldown_until`)
    .run(project, machine, target, count, until);
  if (count === policy.failures)
    notify(
      tx,
      project,
      clock,
      `worker-cooldown:${machine}:${target}`,
      `机器 ${machine} 连续 ${count} 次启动准备失败，自动选机冷却至 ${until}。最近原因：${failure}。请主机运维检查远程环境，修复后核对启动。`,
    );
}
export function workerCooldown(
  store: Store,
  project: string,
  machine: string,
  target: string,
  now: string,
) {
  const row = store.database
    .prepare(
      "SELECT cooldown_until FROM worker_preparation_health WHERE project_id=? AND machine_id=? AND target=? AND cooldown_until>?",
    )
    .get(project, machine, target, now);
  return row ? { preparation_cooldown_until: String(row.cooldown_until) } : {};
}
