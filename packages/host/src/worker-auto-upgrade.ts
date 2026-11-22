import { dirname, join } from "node:path";
import { occupiedRunSlots } from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  matchesWorkerPlatform,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";
import { helperMismatch } from "./worker-helper-release.js";
import { notifyWorkerMaintenance } from "./worker-maintenance.js";
import { onboardWorker } from "./worker-onboarding.js";
import {
  parseWorkerOnboarding,
  readOnboardingYaml,
} from "./worker-onboarding-config.js";
import { enrolledUpgradeIdentity } from "./worker-upgrade-enrollment.js";
import {
  finishUpgrade,
  upgradeHold,
  upgradeKey,
  upgradeState,
} from "./worker-upgrade-gate.js";
import {
  installRelease,
  promotionPending,
} from "./worker-upgrade-transport.js";

type Check = { blockers: readonly string[]; launch_enabled: boolean };
const held: Check = { blockers: [upgradeHold], launch_enabled: false };

/** Called only while the patrol owns the machine check journal. No launch path installs. */
export async function patrolHelperUpgrade(
  options: {
    store: Store;
    job: string;
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

  let stage = "configuration";
  const start = Date.now();
  let before: Record<string, string> = {};
  const evidence = () => ({ before, start, job: options.job });
  const fail = () =>
    store.uow.run((tx) =>
      finishUpgrade(store, tx, project, machine, key, stage, evidence(), false),
    );
  if (previous?.release_key === key) {
    if (previous.state === "installing") {
      stage = "interrupted";
      fail();
    }
    if (previous.state === "worker_checked") return initial;
    if (previous.state !== "verified") return held;
    // Drift after a verified install needs investigation, not another root write.
    if (!initial.blockers.some(helperMismatch)) return initial;
  }
  const identity = enrolledUpgradeIdentity(root, project, machine);
  // Missing enrollment never enables SSH. Malformed/private-file failures may not authorize it either.
  if (!identity) {
    if (
      wasHeld &&
      previous.release_key !== key &&
      execution.target &&
      options.bindingCurrent()
    ) {
      // The patrol holds the machine job. Do not carry any worker proof across keys.
      store.uow.run((tx) => {
        store.database
          .prepare(
            "UPDATE worker_helper_upgrades SET release_key=?,state='failed',pending_final=NULL WHERE project_id=? AND machine_id=? AND release_key=? AND state!='verified'",
          )
          .run(key, project, machine, String(previous.release_key));
        if (previous.state === "installing")
          notifyWorkerMaintenance(
            tx,
            project,
            { now: () => new Date().toISOString() },
            `worker-upgrade:${machine}:${key}`,
            `项目 ${project} 的机器 ${machine} 的升级中断且已退出自动更新。请按当前版本人工恢复并顺序运行 worker check、machine check。`,
          );
      });
    }
    return wasHeld
      ? { ...held, blockers: [...initial.blockers, upgradeHold] }
      : initial;
  }
  const needsInstall = initial.blockers.some(helperMismatch);
  if (!needsInstall && initial.blockers.length)
    return { ...held, blockers: [...initial.blockers, upgradeHold] };
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
        "INSERT INTO worker_helper_upgrades(project_id,machine_id,release_key,state) VALUES (?,?,?,'installing') ON CONFLICT(project_id,machine_id) DO UPDATE SET release_key=excluded.release_key,state='installing',pending_final=NULL",
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
    if (needsInstall) {
      stage = "install";
      before = await adapters.install(execution, project, identity, signal);
    }
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
    // Outer capability probes, the final binding fence and journal completion still have to pass.
    store.uow.run(() =>
      store.database
        .prepare(
          "UPDATE worker_helper_upgrades SET pending_final=? WHERE project_id=? AND machine_id=? AND release_key=? AND state='installing'",
        )
        .run(JSON.stringify(evidence()), project, machine, key),
    );
    return result;
  } catch {
    fail();
    return held;
  }
}
