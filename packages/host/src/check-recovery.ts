import { createHash } from "node:crypto";
import type {
  CardId,
  Clock,
  Event,
  MergeCheckView,
  ProjectId,
} from "@cardigan/domain";
import {
  type CheckRecoveryBinding,
  type CheckRecoveryResult,
  type ExecutionConfig,
  recoverCheckDirectory,
  validCheckRecoveryBinding,
} from "@cardigan/runtime-herdr";
import type {
  ReadRepositories,
  Store,
  StoreTransactionContext,
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
    },
  ) {}

  private events(
    tx: ReadRepositories,
    project: ProjectId,
    card: CardId,
  ): Event[] {
    return tx.events
      .listAfter(project, card, 0)
      .filter(
        (e) => e.actor.kind === "system" && e.actor.project_id === project,
      );
  }
  private check(
    tx: ReadRepositories,
    project: ProjectId,
    card: CardId,
    attempt: string,
  ): MergeCheckView | undefined {
    return this.events(tx, project, card).findLast(
      (e) =>
        [
          "merge_check_queued",
          "merge_check_started",
          "merge_check_finished",
        ].includes(e.type) &&
        (e.payload as unknown as MergeCheckView).attempt_id === attempt,
    )?.payload as unknown as MergeCheckView | undefined;
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
        check = this.check(tx, project, card, attempt);
      if (
        !executor ||
        targetKey(executor) !== targetKey(executedOn) ||
        !validCheckRecoveryBinding(binding) ||
        check?.status !== "running" ||
        check.candidate_sha !== sha ||
        this.events(tx, project, card).some(
          (e) =>
            e.type === "merge_check_checkout_registered" &&
            (e.payload as unknown as Registration).attempt_id === attempt,
        )
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

  async sweep(project: ProjectId): Promise<void> {
    const executor = this.options.executor(project);
    if (!executor) return;
    const cards = this.options.store.uow.read((tx) => tx.cards.list(project));
    for (const card of cards) {
      const events = this.options.store.uow.read((tx) =>
        this.events(tx, project, card.id),
      );
      for (const event of events.filter(
        (e) => e.type === "merge_check_checkout_registered",
      )) {
        const registration = event.payload as unknown as Registration;
        const { attempt_id, candidate_sha, binding } = registration;
        const eligible = (tx: ReadRepositories) => {
          const current = this.options.executor(project),
            check = this.check(tx, project, card.id, attempt_id);
          return (
            current &&
            targetKey(current) === registration.executor_key &&
            check &&
            terminal.has(check.status) &&
            check.candidate_sha === candidate_sha
          );
        };
        if (
          !this.options.store.uow.read(eligible) ||
          !validCheckRecoveryBinding(binding)
        )
          continue;
        const previous = events.filter(
          (e) =>
            (e.payload as { registration_id?: string } | null)
              ?.registration_id === event.id,
        );
        if (
          previous.some(
            (e) =>
              e.type === "merge_check_recovery_finished" &&
              (e.payload as { status?: string }).status === "cleaned",
          )
        )
          continue;
        const identity = { attempt_id, registration_id: event.id };
        this.options.store.uow.run((tx) =>
          this.audit(
            tx,
            project,
            card.id,
            "merge_check_recovery_requested",
            identity,
          ),
        );
        let result: CheckRecoveryResult;
        try {
          result = await (this.options.recover ?? recoverCheckDirectory)(
            executorExecution(executor, this.options.execution),
            {
              project,
              attempt: attempt_id,
              sha: candidate_sha,
              binding,
              slots: executor.maxConcurrent,
              resume: previous.some(
                (e) => e.type === "merge_check_recovery_deleting",
              ),
              authorize: () =>
                this.options.store.uow.run((tx) => {
                  if (!eligible(tx))
                    throw new Error("Check recovery ownership changed");
                  this.audit(
                    tx,
                    project,
                    card.id,
                    "merge_check_recovery_deleting",
                    identity,
                  );
                }),
            },
          );
        } catch {
          result = {
            status: "manual_attention",
            reason: "transport",
            processes: [],
          };
        }
        this.options.store.uow.run((tx) => {
          const finished = this.audit(
            tx,
            project,
            card.id,
            "merge_check_recovery_finished",
            { ...identity, ...result },
          );
          const last = previous.findLast(
            (e) => e.type === "merge_check_recovery_finished",
          )?.payload;
          if (
            result.status === "busy" ||
            JSON.stringify(last) === JSON.stringify(finished.payload)
          )
            return;
          const entry = tx.ids.nextTimelineEntryId(project, card.id);
          tx.timeline.put(project, {
            id: entry,
            short_id: entry,
            card_id: card.id,
            event_seq: finished.seq,
            type: "system",
            author: "system",
            refs: [],
            mentions: [],
            retracted: false,
            created_at: finished.created_at,
            body:
              result.status === "cleaned"
                ? `检查 ${attempt_id} 的残留目录及 Git 登记已清理。`
                : `检查 ${attempt_id} 的残留目录待人工处理；占用或身份尚未确认，已保留现场。` +
                  result.processes
                    .map(
                      (p) =>
                        ` PID ${p.pid}，状态 ${p.state}，等待位置 ${p.wchan}。`,
                    )
                    .join(""),
          });
        });
      }
    }
  }
}
