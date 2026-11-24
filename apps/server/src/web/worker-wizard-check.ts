import { join } from "node:path";
import { type Clock, saveMachine } from "@cardigan/domain";
import {
  type MachineCheckJournal,
  matchesWorkerPlatform,
  onboardWorker,
  parseWorkerOnboarding,
  readOnboardingYaml,
  refreshWorkerObservations,
  WORKER_STEPS,
  WorkerOnboardingError,
  workerOnboardingStatus,
  type workerWizardForm,
} from "@cardigan/host";
import { persistEffect } from "@cardigan/mcp-server";
import type {
  ReadRepositories,
  Store,
  StoreTransactionContext,
} from "@cardigan/store";
import { machineAudit } from "./machine-checks.js";
import type { WizardHost } from "./machine-host.js";
import { emptyState } from "./sql-state.js";

type Step = (typeof WORKER_STEPS)[number] | "configuration" | "capabilities";
export type StepRecord = {
  step: Step;
  state: "pending" | "running" | "passed" | "blocked";
  elapsed_ms: number;
  reason?: string;
  next?: string;
  command_key?: keyof ReturnType<typeof workerWizardForm>["commands"];
};
export const initialSteps = (): StepRecord[] =>
  ["configuration" as const, ...WORKER_STEPS, "capabilities" as const].map(
    (step) => ({
      step,
      state: "pending",
      elapsed_ms: 0,
    }),
  );
export type Draft = ReturnType<typeof workerWizardForm>;
function registry(store: Store, tx: ReadRepositories, draft: Draft) {
  const w = draft.config.worker,
    id = w.machine_id;
  const peers = store
    .listProjects()
    .flatMap((p) => tx.machines.get(p.id, id) ?? []);
  return {
    compatible: peers.every(
      (m) => m.herdr_machine === id && matchesWorkerPlatform(m, w),
    ),
    label: peers[0]?.label ?? draft.label,
    registered: !!tx.machines.get(w.project_id, id),
    /** No project has registered this machine yet. */
    unknown: peers.length === 0,
  };
}
/**
 * C-707: called in the registration's own transaction when the check
 * registers the machine for the draft's project; `first` when no project had
 * it before (a new machine on this host).
 */
export type OnRegistered = (
  tx: StoreTransactionContext,
  first: boolean,
) => void;
export function checkRegistryCompatibility(
  store: Store,
  tx: ReadRepositories,
  draft: Draft,
) {
  if (!registry(store, tx, draft).compatible)
    throw new WorkerOnboardingError("worker_identity_conflict");
}
export function isRegistered(store: Store, tx: ReadRepositories, draft: Draft) {
  const r = registry(store, tx, draft);
  return r.compatible && r.registered;
}
function registration(
  store: Store,
  tx: StoreTransactionContext,
  clock: Clock,
  draft: Draft,
  create: boolean,
  limit: number,
  onRegistered: OnRegistered | undefined,
) {
  const w = draft.config.worker,
    id = w.machine_id,
    project = w.project_id;
  const r = registry(store, tx, draft);
  if (!r.compatible || r.registered || !create)
    return r.compatible && r.registered;
  const result = saveMachine(
    emptyState(tx, project),
    { kind: "human", project_id: project },
    {
      operation: "register",
      machine: {
        id,
        label: r.label,
        os: w.os,
        arch: w.arch,
        herdr_machine: id,
        tags: [],
        status: "offline",
        last_seen: clock.now(),
        max_assignments: limit,
      },
    },
    { clock, ids: tx.ids },
  );
  if (!result.ok) return false;
  persistEffect(tx, project, result.value);
  onRegistered?.(tx, r.unknown);
  return true;
}
export function checkWizard(options: {
  store: Store;
  checks: MachineCheckJournal;
  clock: Clock;
  host: WizardHost;
  signal: AbortSignal;
  draft: Draft;
  steps: StepRecord[];
  priorDigest: string | undefined;
  authorize: (tx?: ReadRepositories) => string;
  limit: number;
  id: string;
  onRegistered?: OnRegistered;
}) {
  const {
    store,
    checks,
    clock,
    host,
    signal,
    draft,
    steps,
    authorize,
    limit,
    id,
    onRegistered,
  } = options;
  const config = draft.config,
    { project_id: project, machine_id: machine } = config.worker;
  const member = authorize();
  const { job } = checks.claim(
    project,
    machine,
    "worker",
    "web",
    (tx, job, joined) => {
      authorize(tx);
      if (joined) throw new WorkerOnboardingError("worker_busy");
      machineAudit(tx, clock, "worker_wizard_check_requested", {
        project_id: project,
        machine_id: machine,
        member_id: member,
        wizard_id: id,
        check_id: job.id,
      });
    },
  );
  let failed: Step = "configuration";
  let failure:
    | { step: Step; elapsed_ms: number; reason: string; next: string }
    | undefined;
  const done = checks.execute(
    job,
    async (progress) => {
      const validate = () => {
        signal.throwIfAborted();
        if (authorize() !== member) throw new Error("authorization changed");
      };
      const record = (step: Step) => {
        const found = steps.find((s) => s.step === step);
        if (!found) throw new Error("missing wizard step");
        return found;
      };
      let start = 0;
      const end = (
        step: Step,
        passed: boolean,
        reason: string,
        next?: string,
      ) => {
        const elapsed_ms = Math.round(performance.now() - start);
        Object.assign(record(step), {
          state: passed ? "passed" : "blocked",
          elapsed_ms,
          reason,
          next,
          command_key: !passed && step === "helpers" ? "helpers" : undefined,
        });
        if (!passed)
          failure = {
            step,
            elapsed_ms,
            reason,
            next:
              step === "configuration"
                ? "核对当前配置与绑定，重新预览并确认。"
                : step === "helpers"
                  ? "使用向导的 helper 命令；已有文件不一致时停下核对。"
                  : "核对向导中的失败步骤和修复建议。",
          };
      };
      const begin = (step: Step) => {
        if (
          step !== "configuration" &&
          record("configuration").state === "running"
        )
          end("configuration", true, "ok");
        failed = step;
        start = performance.now();
        Object.assign(record(step), {
          state: "running",
          elapsed_ms: 0,
          reason: undefined,
          next: undefined,
          command_key: undefined,
        });
        progress(step);
        validate();
      };
      try {
        begin("configuration");
        const current = parseWorkerOnboarding(
          readOnboardingYaml(
            join(host.root, `worker-${machine}-${project}.yaml`),
          ),
          host.dataDir,
        );
        if (current.digest !== config.digest)
          throw new WorkerOnboardingError("worker_config_changed");
        const old = workerOnboardingStatus(host.root, project, machine);
        const passed = await onboardWorker({
          config,
          configRoot: host.root,
          dataDir: host.dataDir,
          mode: old ? "resume" : "add",
          ...(old &&
          old.digest === options.priorDigest &&
          old.digest !== config.digest
            ? { confirmConfig: config.digest }
            : {}),
          completed: WORKER_STEPS.filter((key) =>
            steps.some((s) => s.step === key && s.state === "passed"),
          ),
          registration: async (create) =>
            store.uow.run((tx) => {
              authorize(tx);
              return registration(
                store,
                tx,
                clock,
                draft,
                create,
                limit,
                onRegistered,
              );
            }),
          ...(host.probe ? { probe: host.probe } : {}),
          beforeStep: begin,
          report: (step, state, reason, next) =>
            end(
              step,
              state === "passed",
              reason,
              step === "helpers" && state === "blocked"
                ? "请使用向导的 helper 安装命令；若已有文件不同，请停下核对版本，不要覆盖。"
                : next,
            ),
        });
        if (passed) begin("capabilities");
        validate();
        await (host.refresh ?? refreshWorkerObservations)(
          store,
          config.worker,
          passed,
          host.env,
          { signal },
        );
        if (passed) end("capabilities", true, "ok");
        return passed;
      } catch (error) {
        // Never leave the active phase pending/running or publish raw backend exceptions.
        if (!failure) {
          const reason =
            error instanceof WorkerOnboardingError
              ? error.code
              : failed === "capabilities"
                ? "worker_capability_check_failed"
                : "worker_operation_failed";
          end(
            failed,
            false,
            reason,
            failed === "configuration"
              ? "核对当前接入配置和机器绑定，重新预览并确认后再检查。"
              : failed === "capabilities"
                ? "核对已登记的平台与能力采样后重试。"
                : "核对会话权限与主机状态后重试。",
          );
        }
        throw error;
      }
    },
    (ok) => ({
      status: ok ? "passed" : "failed",
      failed_steps: ok ? [] : [failed],
    }),
    (tx, j) =>
      machineAudit(
        tx,
        clock,
        "worker_wizard_check_finished",
        {
          ...j,
          wizard_id: id,
          member_id: member,
          ...(failure ? { failure } : {}),
        },
        "system",
      ),
  );
  return { id: job.id, done };
}
