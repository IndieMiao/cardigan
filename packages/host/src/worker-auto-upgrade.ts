import { dirname, join } from "node:path";
import { occupiedRunSlots } from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  matchesWorkerPlatform,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";
import { hasHelperMismatch } from "./worker-helper-release.js";
import { onboardWorker, workerCheckConfig } from "./worker-onboarding.js";
import {
  parseWorkerOnboarding,
  readOnboardingYaml,
} from "./worker-onboarding-config.js";
import { enrolledUpgradeIdentity } from "./worker-upgrade-enrollment.js";
import {
  finishUpgrade,
  upgradeKey,
  upgradeState,
} from "./worker-upgrade-gate.js";
import {
  installRelease,
  promotionPending,
} from "./worker-upgrade-transport.js";

type Check = {
  blockers: readonly string[];
  warnings?: readonly string[];
  launch_enabled: boolean;
};
/** C-608: a failed attempt of the same release is retried after this, never left to a human. */
export const UPGRADE_RETRY_MS = 6 * 60 * 60 * 1000;

/** Latest failed attempt for this machine; drift after a verified install is never retried. */
function retryDue(store: Store, project: string, machine: string, now: number) {
  const row = store.database
    .prepare(
      "SELECT doc FROM events WHERE project_id=? AND type='worker_helper_upgrade_failed' AND json_extract(doc,'$.payload.machine_id')=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(project, machine);
  if (!row) return true;
  const event = JSON.parse(String(row.doc)) as {
    created_at?: string;
    payload?: { stage?: string };
  };
  if (event.payload?.stage === "unexpected_drift") return false;
  const at = Date.parse(event.created_at ?? "");
  return !Number.isFinite(at) || now - at >= UPGRADE_RETRY_MS;
}

/**
 * Called only while the patrol owns the machine check journal. Launches use the
 * same entry through RuntimeTargets.refreshMachine. Only an install in progress
 * holds dispatch; any other outcome returns the live check (C-608).
 */
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
    now?: () => number;
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
  const unverified = !!previous && previous.state !== "verified";
  if (!unverified && !hasHelperMismatch(initial)) return initial;
  if (initial.blockers.includes("machine_not_ready")) return initial;
  const root = dirname(runtimeWorkersPath(options.env));
  const key = upgradeKey(execution.target?.fingerprint);

  let stage = "configuration";
  const start = Date.now();
  let before: Record<string, string> = {};
  const evidence = () => ({ before, start, job: options.job });
  const fail = (release = key) =>
    store.uow.run((tx) =>
      finishUpgrade(
        store,
        tx,
        project,
        machine,
        release,
        stage,
        evidence(),
        false,
      ),
    );
  if (previous?.state === "installing") {
    // The journal owner is this patrol: an installing row is an interrupted attempt.
    stage = "interrupted";
    fail(String(previous.release_key));
    if (previous.release_key === key) return initial;
  }
  if (previous?.release_key === key) {
    if (previous.state === "worker_checked") return initial;
    if (
      previous.state !== "verified" &&
      !retryDue(store, project, machine, options.now?.() ?? Date.now())
    )
      return initial;
    // Drift after a verified install needs investigation, not another root write.
    if (previous.state === "verified" && !hasHelperMismatch(initial))
      return initial;
  }
  const identity = enrolledUpgradeIdentity(root, project, machine);
  // Missing enrollment never enables SSH. Malformed/private-file failures may not authorize it either.
  if (!identity) {
    if (
      unverified &&
      previous.release_key !== key &&
      execution.target &&
      options.bindingCurrent()
    )
      // The patrol holds the machine job. Do not carry any worker proof across keys.
      store.uow.run(() => {
        store.database
          .prepare(
            "UPDATE worker_helper_upgrades SET release_key=?,state='failed',pending_final=NULL WHERE project_id=? AND machine_id=? AND release_key=? AND state!='verified'",
          )
          .run(key, project, machine, String(previous.release_key));
      });
    return initial;
  }
  const needsInstall = hasHelperMismatch(initial);
  if (!needsInstall && initial.blockers.length) return initial;
  try {
    if (adapters.promotionPending(execution.dataDir)) return initial;
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
  // Busy machines keep running on the compatible helper; the next idle patrol installs.
  if (!claimed) return initial;
  try {
    if (previous?.release_key === key && previous.state === "verified") {
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
    if (
      result.blockers.length ||
      hasHelperMismatch(result) ||
      !options.bindingCurrent()
    )
      throw new Error();
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
    // Launches still run their own live check before anything is published.
    return initial;
  }
}
