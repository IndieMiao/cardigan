import { dirname, join } from "node:path";
import { occupiedRunSlots } from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import {
  agentToolsConfirmed,
  agentToolsStale,
} from "./agent-tools-maintenance.js";
import { holdLongOperation } from "./long-operations.js";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  matchesWorkerPlatform,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";
import { helperMismatch } from "./worker-helper-release.js";
import { notifyWorkerMaintenance } from "./worker-maintenance.js";
import { onboardWorker, workerCheckConfig } from "./worker-onboarding.js";
import {
  parseWorkerOnboarding,
  readOnboardingYaml,
} from "./worker-onboarding-config.js";
import { enrolledUpgradeIdentity } from "./worker-upgrade-enrollment.js";
import {
  finishUpgrade,
  type InstallEvidence,
  upgradeHold,
  upgradeKey,
  upgradeState,
} from "./worker-upgrade-gate.js";
import {
  installedAgentTools,
  installRelease,
  promotionPending,
  WORKER_UPGRADE_NOT_SENT,
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
  adapters: {
    install: typeof installRelease;
    workerCheck: typeof onboardWorker;
    promotionPending: typeof promotionPending;
    /** C-599: current helpers with missing/stale attachment tools also install, once per release key. */
    toolsStale?: typeof agentToolsStale;
  } = {
    install: installRelease,
    workerCheck: onboardWorker,
    promotionPending,
    toolsStale: agentToolsStale,
  },
): Promise<Check> {
  const { store, project, machine, execution, signal } = options;
  if (machine === "local" || execution.mode !== "agent-ssh") return initial;
  const previous = upgradeState(store, project, machine);
  const wasHeld = !!previous && previous.state !== "verified";
  const root = dirname(runtimeWorkersPath(options.env));
  const key = upgradeKey(execution.target?.fingerprint);
  const helpersStale = initial.blockers.some(helperMismatch);
  // C-599: an enrolled, otherwise healthy binding that has not tried this key
  // yet also installs for missing/stale tools, including while it recovers.
  let toolsStale = false;
  if (
    !helpersStale &&
    !initial.blockers.length &&
    previous?.release_key !== key &&
    !agentToolsConfirmed.has(store, project, machine, key) &&
    adapters.toolsStale
  ) {
    let enrolled = false;
    try {
      enrolled = !!enrolledUpgradeIdentity(root, project, machine);
    } catch {
      /* An unreadable enrollment never authorizes an install. */
    }
    const os = store.uow.read((tx) => tx.machines.get(project, machine))?.os;
    if (enrolled && os) {
      const state = await adapters.toolsStale(execution, machine, os, signal);
      toolsStale = state === "stale";
      // Current tools need no further remote probe for this key in this process;
      // an unknown result is probed again by the next patrol.
      if (state === "current")
        agentToolsConfirmed.set(store, project, machine, key);
    }
  }
  // A tools-only refresh of a released machine never holds dispatch before it writes.
  const toolsOnly = !wasHeld && !helpersStale && toolsStale;
  if (!wasHeld && !helpersStale && !toolsStale) return initial;
  if (initial.blockers.includes("machine_not_ready")) return initial;

  let stage = "configuration";
  const start = Date.now();
  let before: Record<string, string> = {};
  let tools: InstallEvidence["tools"];
  const evidence = (): InstallEvidence => ({
    before,
    start,
    job: options.job,
    ...(tools ? { tools } : {}),
  });
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
  const needsInstall = toolsStale || helpersStale;
  if (!needsInstall && initial.blockers.length)
    return { ...held, blockers: [...initial.blockers, upgradeHold] };
  try {
    // A tools-only refresh never holds dispatch before it writes: retry next patrol.
    if (adapters.promotionPending(execution.dataDir))
      return toolsOnly ? initial : held;
  } catch {
    if (toolsOnly) return initial;
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
  if (!claimed) return toolsOnly ? initial : held;
  // C-609: an interrupted install needs manual recovery; deployments wait.
  const release = holdLongOperation(store, {
    kind: "worker_upgrade",
    project_id: project,
    label: `worker 升级（${machine}）`,
  });
  try {
    if (previous?.release_key === key) {
      stage = "unexpected_drift";
      throw new Error();
    }
    const draft = parseWorkerOnboarding(
      readOnboardingYaml(join(root, `worker-${machine}-${project}.yaml`)),
      execution.dataDir,
    );
    const workerCheck = workerCheckConfig(
      draft,
      root,
      execution.dataDir,
      "bound",
    );
    if (
      !execution.target ||
      runtimeTargetBinding(workerCheck.config.worker).fingerprint !==
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
      // A v1 entry upgraded only the helpers: never record that as tools installed.
      tools = installedAgentTools(before) ? "installed" : "entry_v1";
    }
    stage = "worker_check";
    if (
      !options.bindingCurrent() ||
      !(await adapters.workerCheck({
        ...workerCheck,
        configRoot: root,
        dataDir: execution.dataDir,
        mode: "check",
        registration: async () =>
          store.uow.read((tx) => {
            const m = tx.machines.get(project, machine);
            return (
              !!m &&
              m.herdr_machine === machine &&
              matchesWorkerPlatform(m, workerCheck.config.worker)
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
  } catch (error) {
    const notSent =
      stage === "configuration" ||
      (stage === "install" &&
        error instanceof Error &&
        error.message === WORKER_UPGRADE_NOT_SENT);
    if (toolsOnly && notSent) {
      // Nothing was sent yet: undo the claim instead of holding a healthy machine.
      store.uow.run(() =>
        previous
          ? store.database
              .prepare(
                "UPDATE worker_helper_upgrades SET release_key=?,state=?,pending_final=? WHERE project_id=? AND machine_id=? AND release_key=? AND state='installing'",
              )
              .run(
                String(previous.release_key),
                String(previous.state),
                previous.pending_final ?? null,
                project,
                machine,
                key,
              )
          : store.database
              .prepare(
                "DELETE FROM worker_helper_upgrades WHERE project_id=? AND machine_id=? AND release_key=? AND state='installing'",
              )
              .run(project, machine, key),
      );
      return initial;
    }
    fail();
    return held;
  } finally {
    release();
  }
}
