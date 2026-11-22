import {
  type Clock,
  type HumanAction,
  requestDeploymentAction,
  retireVerifiedHelperAction,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { workerHelperDigests } from "./worker-helper-release.js";

export function notifyWorkerMaintenance(
  tx: StoreTransactionContext,
  project: string,
  clock: Clock,
  key: string,
  instructions: string,
  fields: Pick<HumanAction, "terminal" | "helper_upgrade"> = {},
) {
  persistEffect(
    tx,
    project,
    unwrap(
      requestDeploymentAction(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        { key, reason: "worker_maintenance", instructions, ...fields },
        { ids: tx.ids, clock },
      ),
    ),
  );
}
const manualUpgradeKey = (machine: string) =>
  `worker-helper:${machine}:${Object.values(workerHelperDigests()).join(":")}`;

export function retireManualUpgrade(
  tx: StoreTransactionContext,
  project: string,
  machine: string,
  binding: string,
  clock: Clock,
) {
  persistEffect(
    tx,
    project,
    unwrap(
      retireVerifiedHelperAction(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        { machine_id: machine, binding, key: manualUpgradeKey(machine) },
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
  fields: Pick<HumanAction, "terminal" | "helper_upgrade">,
) {
  const digests = workerHelperDigests();
  notifyWorkerMaintenance(
    tx,
    project,
    clock,
    manualUpgradeKey(machine),
    `项目 ${project} 的机器 ${machine}：${reason}。${fields.terminal ? "暂存已就绪。请先暂停派发、确认无活跃任务，再登录目标机执行下方命令。" : "发行材料暂存失败，没有可执行命令。请主机运维核对 worker 连接；下次巡检会重试。"}\n${Object.entries(
      digests,
    )
      .map(([name, sha]) => `${sha}  ${name}`)
      .join("\n")}`,
    fields,
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
    notifyWorkerMaintenance(
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
