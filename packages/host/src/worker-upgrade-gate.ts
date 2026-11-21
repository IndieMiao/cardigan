import {
  readMachineObservationsInTransaction,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import type { MachineCheckJob } from "./machine-check-types.js";
import {
  observationFingerprint,
  workerHelperDigests,
} from "./worker-helper-release.js";
import { notifyWorkerMaintenance } from "./worker-maintenance.js";

export const upgradeHold = "worker_helper_upgrade_unverified";
export const upgradeKey = (fingerprint: string | undefined) =>
  `${fingerprint}:${Object.values(workerHelperDigests()).join(":")}`;
export function upgradeState(store: Store, project: string, machine: string) {
  return store.database
    .prepare(
      "SELECT release_key,state,pending_final FROM worker_helper_upgrades WHERE project_id=? AND machine_id=?",
    )
    .get(project, machine);
}
export function upgradeHeld(store: Store, project: string, machine: string) {
  const row = upgradeState(store, project, machine);
  return !!row && row.state !== "verified";
}
export interface InstallEvidence {
  job: string;
  before: Record<string, string>;
  start: number;
}
export function finishUpgrade(
  store: Store,
  tx: StoreTransactionContext,
  project: string,
  machine: string,
  key: string,
  stage: string,
  evidence: InstallEvidence,
  passed: boolean,
) {
  const updated = store.database
    .prepare(
      "UPDATE worker_helper_upgrades SET state=?,pending_final=NULL WHERE project_id=? AND machine_id=? AND release_key=? AND state='installing'",
    )
    .run(passed ? "verified" : "failed", project, machine, key);
  if (updated.changes !== 1) throw new Error("worker_upgrade_stale");
  const now = () => new Date().toISOString();
  tx.events.append(project, {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project),
    type: passed
      ? "worker_helper_upgrade_verified"
      : "worker_helper_upgrade_failed",
    actor: { kind: "system", project_id: project },
    created_at: now(),
    payload: {
      machine_id: machine,
      stage,
      duration_ms: Date.now() - evidence.start,
      before: evidence.before,
      expected: { ...workerHelperDigests() },
    },
  });
  if (!passed)
    notifyWorkerMaintenance(
      tx,
      project,
      { now },
      `worker-upgrade:${machine}:${key}`,
      `机器 ${machine} 的 helper 自动升级未获验证（${stage}），已保持停派，本版本不会再次自动安装。请主机运维检查发行签名、受限入口及 worker / machine check，再按接入文档恢复。`,
    );
}
// This runs in the terminal journal transaction, never in a runtime/SSH probe.
export function settleUpgradeCheck(
  store: Store,
  tx: StoreTransactionContext,
  job: MachineCheckJob,
) {
  const { project_id: project, machine_id: machine } = job;
  const row = upgradeState(store, project, machine);
  if (!row || row.state === "verified") return;
  const registered = tx.machines.get(project, machine);
  const key = String(row.release_key),
    binding = key.split(":")[0];
  const fingerprint = registered && observationFingerprint(binding, registered);
  const obs = fingerprint
    ? readMachineObservationsInTransaction(
        store,
        project,
        machine,
        job.checked_at,
        fingerprint,
      )
    : undefined;
  const passed = !!(
    job.status === "passed" &&
    binding &&
    upgradeKey(binding) === key &&
    obs?.observation_target_matches &&
    obs.health?.available &&
    obs.health.evidence_ref === `machine-observation:${job.id}`
  );
  if (
    row.state === "installing" &&
    row.pending_final &&
    job.kind === "machine"
  ) {
    const evidence: InstallEvidence = JSON.parse(String(row.pending_final));
    if (evidence.job === job.id)
      finishUpgrade(
        store,
        tx,
        project,
        machine,
        key,
        "machine_check",
        evidence,
        passed,
      );
    return;
  }
  if (!passed) return;
  if (job.kind === "worker" && row.state === "failed") {
    store.database
      .prepare(
        "UPDATE worker_helper_upgrades SET state='worker_checked' WHERE project_id=? AND machine_id=?",
      )
      .run(project, machine);
  } else if (job.kind === "machine" && row.state === "worker_checked") {
    store.database
      .prepare(
        "UPDATE worker_helper_upgrades SET state='verified' WHERE project_id=? AND machine_id=?",
      )
      .run(project, machine);
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: "worker_helper_upgrade_recovered",
      actor: { kind: "system", project_id: project },
      created_at: job.checked_at,
      payload: { machine_id: machine, expected: { ...workerHelperDigests() } },
    });
  }
}
