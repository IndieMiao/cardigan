import { createHash } from "node:crypto";
import type { Actor, CardId, Clock, Event, ProjectId } from "@cardigan/domain";
import {
  canRecheckRecovery,
  DEFAULT_CHECK_RECOVERY_INSPECTION_MS,
  sameCheckRecoveryOutcome,
} from "@cardigan/domain";
import {
  type CheckRecoveryBinding,
  type CheckRecoveryResult,
  type ExecutionConfig,
  recoverCheckDirectory,
  validCheckRecoveryBinding,
} from "@cardigan/runtime-herdr";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import {
  assertCheckAdmission,
  CheckRecoveryJournal,
  type RecoveryRegistration,
} from "@cardigan/store";
import {
  executorExecution,
  type MergeGateExecutor,
} from "./merge-gate-executors.js";

const targetKey = (executor: MergeGateExecutor) =>
  createHash("sha256").update(JSON.stringify(executor)).digest("hex");
interface Registration {
  attempt_id: string;
  candidate_sha: string;
  executor_key: string;
  binding: CheckRecoveryBinding;
}
const terminal = new Set([
  "passed",
  "failed",
  "timed_out",
  "interrupted",
  "executor_unreachable",
]);

/** Durable host journal, never a candidate-owned recovery marker or an Agent claim. */
export class CheckRecovery {
  constructor(
    private readonly options: {
      store: Store;
      clock: Clock;
      execution: ExecutionConfig;
      executor: (project: ProjectId) => MergeGateExecutor | undefined;
      recover?: typeof recoverCheckDirectory;
      /** Q-618: five minutes by default; trusted host configuration can override. */
      inspectionIntervalMs?: number;
    },
  ) {}

  private get journal() {
    return new CheckRecoveryJournal(this.options.store);
  }
  private audit(
    tx: StoreTransactionContext,
    project: ProjectId,
    card: CardId,
    type: string,
    payload: object,
  ): Event {
    const event: Event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project, card),
      card_id: card,
      type,
      actor: { kind: "system", project_id: project },
      payload: JSON.parse(JSON.stringify(payload)),
      created_at: this.options.clock.now(),
    };
    tx.events.append(project, event);
    return event;
  }
  register(
    project: ProjectId,
    card: CardId,
    attempt: string,
    sha: string,
    binding: CheckRecoveryBinding,
    executedOn: MergeGateExecutor,
  ): void {
    this.options.store.uow.run((tx) => {
      const executor = this.options.executor(project),
        check = this.journal.check(project, card, attempt);
      if (
        !executor ||
        targetKey(executor) !== targetKey(executedOn) ||
        !validCheckRecoveryBinding(binding) ||
        check?.status !== "running" ||
        check.candidate_sha !== sha ||
        this.journal.registered(project, card, attempt)
      )
        throw new Error("Unverified check recovery registration");
      this.audit(tx, project, card, "merge_check_checkout_registered", {
        attempt_id: attempt,
        candidate_sha: sha,
        executor_key: targetKey(executor),
        binding,
      } satisfies Registration);
    });
  }

  /** Explicit private host/human operation. It does not grant an Agent new tools. */
  recheck(actor: Actor, project: ProjectId, registration: string): void {
    recheckCheckRecovery(
      this.options.store,
      this.options.clock,
      actor,
      project,
      registration,
    );
  }

  async sweep(project: ProjectId): Promise<void> {
    const configured = this.options.executor(project);
    if (!configured || configured.type === "github") return;
    const executor = { ...configured },
      executorKey = targetKey(executor);
    const now = new Date(this.options.clock.now()).toISOString();
    const rows = this.options.store.uow.read(() =>
      this.journal.due(project, executorKey, now),
    );
    for (const row of rows) {
      const { attempt_id, candidate_sha, binding } = row;
      if (!validCheckRecoveryBinding(binding)) continue;
      const patrol = row.state !== "pending";
      const delay =
        this.options.inspectionIntervalMs ??
        DEFAULT_CHECK_RECOVERY_INSPECTION_MS;
      if (!Number.isSafeInteger(delay) || delay <= 0)
        throw new Error("Invalid recovery inspection interval");
      const next = new Date(Date.parse(now) + delay).toISOString();
      const eligible = (revision?: number) => {
        const current = this.options.executor(project),
          check = this.journal.check(project, row.card_id, attempt_id);
        return (
          !!current &&
          targetKey(current) === executorKey &&
          executorKey === row.executor_key &&
          !!check &&
          terminal.has(check.status) &&
          check.candidate_sha === candidate_sha &&
          (revision === undefined ||
            this.journal.get(project, row.registration_id)?.revision ===
              revision)
        );
      };
      const revision = this.options.store.uow.run(() => {
        assertCheckAdmission(this.options.store, project, executor.name);
        return eligible() ? this.journal.claim(project, row, next) : undefined;
      });
      if (revision === undefined) continue;
      let absent = false;
      const inspect = async (
        observeOnly: boolean,
      ): Promise<CheckRecoveryResult> => {
        try {
          this.options.store.uow.read(() => {
            assertCheckAdmission(this.options.store, project, executor.name);
            if (!eligible(revision))
              throw new Error("Recovery ownership changed");
          });
          return await (this.options.recover ?? recoverCheckDirectory)(
            executorExecution(executor, this.options.execution),
            {
              project,
              attempt: attempt_id,
              sha: candidate_sha,
              binding,
              slots: executor.maxConcurrent,
              ...(observeOnly ? { observeOnly: true } : {}),
              confirmAbsence: () =>
                this.options.store.uow.run(() => {
                  assertCheckAdmission(
                    this.options.store,
                    project,
                    executor.name,
                  );
                  if (!eligible(revision))
                    throw new Error("Recovery ownership changed");
                  absent = true;
                }),
            },
          );
        } catch {
          return {
            status: "manual_attention",
            reason: "transport",
            stage: "transport",
            processes: [],
          };
        }
      };
      let result = await inspect(patrol);
      const evidence = (value: CheckRecoveryResult) =>
        value.evidence ??
        JSON.stringify([value.status, value.reason, value.stage]);
      const observed = evidence(result);
      const unchanged = patrol && observed === row.evidence_key;
      if (unchanged) result = row.result ?? result;
      // A cheap presence observation cannot authorize cleaning or a diagnostic.
      // Changed authenticated evidence reactivates the full exact-identity check.
      if (!unchanged && patrol && result.stage === "presence") {
        absent = false;
        result = await inspect(false);
      }
      this.options.store.uow.run((tx) => {
        if (!eligible(revision)) {
          // A superseding recheck owns its revision. Never publish stale work.
          if (
            this.journal.get(project, row.registration_id)?.revision !==
            revision
          )
            return;
          result = {
            status: "manual_attention",
            reason: "unverified",
            stage: "ownership",
            processes: [],
          };
        }
        try {
          assertCheckAdmission(this.options.store, project, executor.name);
        } catch {
          return;
        }
        if (!unchanged && result.status === "cleaned" && !absent)
          result = {
            status: "manual_attention",
            reason: "unverified",
            stage: "absence",
            processes: [],
          };
        const changed = !sameCheckRecoveryOutcome(row.result, result);
        if (
          !this.journal.settle(project, row, revision, result, evidence(result))
        )
          return;
        if (!changed) return;
        const identity = { attempt_id, registration_id: row.registration_id };
        this.audit(
          tx,
          project,
          row.card_id,
          "merge_check_recovery_requested",
          identity,
        );
        if (result.status === "cleaned")
          this.audit(
            tx,
            project,
            row.card_id,
            "merge_check_recovery_absence_confirmed",
            identity,
          );
        const finished = this.audit(
          tx,
          project,
          row.card_id,
          "merge_check_recovery_finished",
          { ...identity, ...result },
        );
        if (result.status === "busy") return;
        this.notice(tx, project, row, result, finished);
      });
    }
  }

  private notice(
    tx: StoreTransactionContext,
    project: ProjectId,
    row: RecoveryRegistration,
    result: CheckRecoveryResult,
    finished: Event,
  ): void {
    const entry = tx.ids.nextTimelineEntryId(project, row.card_id);
    tx.timeline.put(project, {
      id: entry,
      short_id: entry,
      card_id: row.card_id,
      event_seq: finished.seq,
      type: "system",
      author: "system",
      refs: [],
      mentions: [],
      retracted: false,
      created_at: finished.created_at,
      body:
        result.status === "cleaned"
          ? `检查 ${row.attempt_id} 的目录及 Git 登记已不存在，记录已核销。`
          : (result.reason === "exclusion_unproven"
              ? `检查 ${row.attempt_id} 的残留目录待人工处理；现有账号和锁不能阻止扫描后的新占用或改名，已保留现场。`
              : `检查 ${row.attempt_id} 的残留目录待人工处理；占用或身份尚未确认，已保留现场。`) +
            result.processes
              .map(
                (p) => ` PID ${p.pid}，状态 ${p.state}，等待位置 ${p.wchan}。`,
              )
              .join(""),
    });
  }
}

/** Human CLI and private host entry share one transaction and authorization check. */
export function recheckCheckRecovery(
  store: Store,
  clock: Clock,
  actor: Actor,
  project: ProjectId,
  registration: string,
): void {
  if (!canRecheckRecovery(actor, project))
    throw new Error("Unauthorized recovery recheck");
  store.uow.run((tx) => {
    const journal = new CheckRecoveryJournal(store),
      row = journal.get(project, registration);
    if (!row) throw new Error("Unknown recovery registration");
    journal.recheck(actor, project, registration);
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project, row.card_id),
      card_id: row.card_id,
      type: "merge_check_recovery_recheck_requested",
      actor,
      payload: { attempt_id: row.attempt_id, registration_id: registration },
      created_at: clock.now(),
    });
  });
}
