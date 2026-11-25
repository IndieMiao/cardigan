import { dirname, join } from "node:path";
import { occupiedRunSlots } from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import {
  agentToolsConfirmed,
  agentToolsStale,
} from "./agent-tools-maintenance.js";
import { holdLongOperation, keepUntilSettled } from "./long-operations.js";
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
  type InstallEvidence,
  upgradeKey,
  upgradeState,
} from "./worker-upgrade-gate.js";
import {
  installedAgentTools,
  installRelease,
  promotionPending,
  WORKER_UPGRADE_NOT_SENT,
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
  const unverified = !!previous && previous.state !== "verified";
  const root = dirname(runtimeWorkersPath(options.env));
  const key = upgradeKey(execution.target?.fingerprint);
  const helpersStale = hasHelperMismatch(initial);
  // C-609: an install of this release on this binding that a restart cut off
  // resumes once. What is already there is re-verified, and only what the
  // check shows missing is installed again; a second interruption fails.
  const resuming =
    previous?.release_key === key &&
    previous.state === "installing" &&
    Number(previous.resumes ?? 0) < 1;
  // C-599: an enrolled, otherwise healthy binding that has not tried this key
  // yet also installs for missing/stale tools, including while it recovers.
  let toolsStale = false;
  if (
    !helpersStale &&
    !initial.blockers.length &&
    (previous?.release_key !== key || resuming) &&
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
  const toolsOnly = !unverified && !helpersStale && toolsStale;
  if (!unverified && !helpersStale && !toolsStale) return initial;
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
  const fail = (releaseKey = key) =>
    store.uow.run((tx) =>
      finishUpgrade(
        store,
        tx,
        project,
        machine,
        releaseKey,
        stage,
        evidence(),
        false,
      ),
    );
  if (previous?.state === "installing" && !resuming) {
    // The journal owner is this patrol: an installing row it may not resume is an interrupted attempt.
    stage = "interrupted";
    fail(String(previous.release_key));
    if (previous.release_key === key) return initial;
  }
  if (previous?.release_key === key && !resuming) {
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
  if (!identity && resuming) {
    stage = "interrupted";
    fail();
    return initial;
  }
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
  const needsInstall = toolsStale || helpersStale;
  if (!needsInstall && initial.blockers.length) {
    if (resuming) {
      stage = "interrupted";
      fail();
    }
    return initial;
  }
  try {
    // Retry after promotion; nothing holds dispatch before it writes.
    if (adapters.promotionPending(execution.dataDir)) return initial;
  } catch {
    if (toolsOnly) return initial;
    /* Missing/invalid deployment proof is recorded as an installation failure. */
  }
  // C-609: registered before the claim. While a deployment's stop fence
  // stands this waits, so no install starts on a server about to stop.
  const release = await holdLongOperation(
    store,
    {
      kind: "worker_upgrade",
      project_id: project,
      label: `worker 升级（${machine}）`,
    },
    { signal },
  );
  let claimed = false;
  try {
    claimed = store.uow.run((tx) => {
      if (
        occupiedRunSlots(
          tx.assignments.list(project),
          tx.runs.list(project),
          machine,
        ) > 0
      )
        return false;
      if (resuming)
        return (
          store.database
            .prepare(
              "UPDATE worker_helper_upgrades SET resumes=resumes+1,pending_final=NULL WHERE project_id=? AND machine_id=? AND release_key=? AND state='installing' AND resumes=?",
            )
            .run(project, machine, key, Number(previous?.resumes ?? 0))
            .changes === 1
        );
      store.database
        .prepare(
          "INSERT INTO worker_helper_upgrades(project_id,machine_id,release_key,state) VALUES (?,?,?,'installing') ON CONFLICT(project_id,machine_id) DO UPDATE SET release_key=excluded.release_key,state='installing',pending_final=NULL,resumes=0",
        )
        .run(project, machine, key);
      return true;
    });
  } finally {
    if (!claimed) release();
  }
  // Busy machines keep running on the compatible helper; the next idle patrol installs.
  if (!claimed) return initial;
  // Kept until the journal records the final result (C-609).
  let settling = false;
  // C-609: the server stopping (e.g. an automatic deployment) cancels the
  // patrol. That is no verdict on the release: the install stays resumable,
  // without spending its one resume, and the next patrol re-verifies it on
  // this binding, installing only what its check shows missing.
  const keepResumable = () => {
    try {
      store.uow.run(() =>
        store.database
          .prepare(
            "UPDATE worker_helper_upgrades SET resumes=0,pending_final=NULL WHERE project_id=? AND machine_id=? AND release_key=? AND state='installing'",
          )
          .run(project, machine, key),
      );
    } catch {
      /* A store closing with the server leaves the row installing anyway. */
    }
  };
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
    // Cancelled before the journal settles: the pending result is dropped
    // rather than recorded as a failure.
    const cancelled = () => keepResumable();
    signal?.addEventListener("abort", cancelled, { once: true });
    keepUntilSettled(options.job, () => {
      signal?.removeEventListener("abort", cancelled);
      release();
    });
    settling = true;
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
    if (signal?.aborted) {
      keepResumable();
      return initial;
    }
    fail();
    // Launches still run their own live check before anything is published.
    return initial;
  } finally {
    if (!settling) release();
  }
}
