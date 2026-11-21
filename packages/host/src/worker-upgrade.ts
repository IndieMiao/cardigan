import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { occupiedRunSlots } from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  matchesWorkerPlatform,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";
import {
  helperMismatch,
  workerHelperDigests,
} from "./worker-helper-release.js";
import { notifyWorkerMaintenance } from "./worker-maintenance.js";
import { onboardWorker } from "./worker-onboarding.js";
import {
  parseWorkerOnboarding,
  readOnboardingYaml,
} from "./worker-onboarding-config.js";
import {
  upgradeHold,
  upgradeKey,
  upgradeState,
} from "./worker-upgrade-gate.js";
import {
  installRelease,
  promotionPending,
  upgradeIdentity,
} from "./worker-upgrade-transport.js";

type Check = { blockers: readonly string[]; launch_enabled: boolean };
const held: Check = { blockers: [upgradeHold], launch_enabled: false };

/** Called only while the patrol owns the machine check journal. No launch path installs. */
export async function patrolHelperUpgrade(
  options: {
    store: Store;
    project: string;
    machine: string;
    execution: ExecutionConfig;
    env?: NodeJS.ProcessEnv | undefined;
    signal?: AbortSignal | undefined;
    bindingCurrent: () => boolean;
    check: () => Promise<Check>;
  },
  initial: Check,
  adapters = {
    install: installRelease,
    workerCheck: onboardWorker,
    promotionPending,
  },
): Promise<Check> {
  const { store, project, machine, execution, signal } = options;
  if (machine === "local" || execution.mode !== "agent-ssh") return initial;
  const previous = upgradeState(store, project, machine);
  const wasHeld = !!previous && previous.state !== "verified";
  if (!wasHeld && !initial.blockers.some(helperMismatch)) return initial;
  if (initial.blockers.includes("machine_not_ready")) return initial;
  const root = dirname(runtimeWorkersPath(options.env));
  const key = upgradeKey(execution.target?.fingerprint);
  const now = () => new Date().toISOString();
  let stage = "configuration";
  const start = Date.now();
  let before: Record<string, string> = {};
  const finish = (passed: boolean) =>
    store.uow.run((tx) => {
      const changed = store.database
        .prepare(
          "UPDATE worker_helper_upgrades SET state=? WHERE project_id=? AND machine_id=? AND release_key=? AND state='installing'",
        )
        .run(passed ? "verified" : "failed", project, machine, key);
      if (changed.changes !== 1) throw new Error("worker_upgrade_stale");
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
          duration_ms: Date.now() - start,
          before,
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
    });
  if (previous?.release_key === key) {
    if (previous.state === "installing") {
      stage = "interrupted";
      finish(false);
    }
    if (previous.state !== "verified") return held;
    // Drift after a verified install needs investigation, not another root write.
    if (!initial.blockers.some(helperMismatch)) return initial;
  }
  const identity = upgradeIdentity(root, project, machine);
  // Missing enrollment never enables SSH. Malformed/private-file failures may not authorize it either.
  if (!lstatSync(identity, { throwIfNoEntry: false }))
    return wasHeld ? held : initial;
  try {
    if (adapters.promotionPending(execution.dataDir)) return held;
  } catch {
    /* Missing/invalid deployment proof is recorded as an installation failure. */
  }
  const claimed = store.uow.run((tx) => {
    if (
      occupiedRunSlots(
        tx.assignments.list(project),
        tx.runs.list(project),
        machine,
      ) > 0
    )
      return false;
    store.database
      .prepare(
        "INSERT INTO worker_helper_upgrades VALUES (?,?,?,'installing') ON CONFLICT(project_id,machine_id) DO UPDATE SET release_key=excluded.release_key,state='installing'",
      )
      .run(project, machine, key);
    return true;
  });
  if (!claimed) return held;
  try {
    if (previous?.release_key === key) {
      stage = "unexpected_drift";
      throw new Error();
    }
    const cfg = parseWorkerOnboarding(
      readOnboardingYaml(join(root, `worker-${machine}-${project}.yaml`)),
      execution.dataDir,
    );
    if (
      !execution.target ||
      runtimeTargetBinding(cfg.worker).fingerprint !==
        execution.target.fingerprint ||
      !options.bindingCurrent() ||
      execution.fileHelper?.path !==
        join(execution.agentRoot, "libexec", "worker-files.py") ||
      execution.gitHelper?.path !==
        join(execution.agentRoot, "libexec", "worker-git.py")
    )
      throw new Error();
    signal?.throwIfAborted();
    stage = "install";
    before = await adapters.install(execution, project, identity, signal);
    stage = "worker_check";
    if (
      !options.bindingCurrent() ||
      !(await adapters.workerCheck({
        config: cfg,
        configRoot: root,
        dataDir: execution.dataDir,
        mode: "check",
        registration: async () =>
          store.uow.read((tx) => {
            const m = tx.machines.get(project, machine);
            return (
              !!m &&
              m.herdr_machine === machine &&
              matchesWorkerPlatform(m, cfg.worker)
            );
          }),
        beforeStep: () => signal?.throwIfAborted(),
        report: () => {},
      }))
    )
      throw new Error();
    stage = "machine_check";
    const result = await options.check();
    if (result.blockers.length || !options.bindingCurrent()) throw new Error();
    signal?.throwIfAborted();
    finish(true);
    return result;
  } catch {
    finish(false);
    return held;
  }
}
