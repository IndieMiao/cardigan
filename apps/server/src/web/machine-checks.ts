import { setTimeout as delay } from "node:timers/promises";
import type {
  Clock,
  HumanActionId,
  JsonValue,
  Machine,
} from "@cardigan/domain";
import {
  type CheckKind,
  type CheckResult,
  MachineCheckJournal,
  tryHelperConfirmationLock,
} from "@cardigan/host";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { HttpRejection } from "./http.js";
import type { MachineHost } from "./machine-host.js";

export function machineAudit(
  tx: StoreTransactionContext,
  clock: Clock,
  type: string,
  payload: JsonValue,
  actor: "human" | "system" = "human",
) {
  const id = tx.global_ids.nextEventId();
  tx.global_events.append({
    id,
    seq: tx.global_ids.nextEventSequence(),
    created_at: clock.now(),
    type,
    actor: { kind: actor },
    payload,
  });
  return id;
}
// Only locally-owned promises matter for graceful shutdown. Identity, progress and
// outcomes are shared with other listeners, CLI processes and the patrol.
export class MachineChecks extends MachineCheckJournal {
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    store: Store,
    clock: Clock,
    private readonly signal: AbortSignal,
    private readonly host?: MachineHost,
  ) {
    super(store, clock);
  }
  start(
    project: string,
    machine: string,
    kind: CheckKind,
    authorize: (tx: StoreTransactionContext) => string,
  ) {
    const host = this.host;
    if (this.signal.aborted || !host)
      throw new HttpRejection(503, "unavailable", "检查服务不可用");
    const { job, joined } = this.claim(
      project,
      machine,
      kind,
      "web",
      (tx, actual, joined) => {
        const member = authorize(tx);
        if (!tx.machines.get(project, machine))
          throw new HttpRejection(404, "not_found", "项目未登记此机器");
        machineAudit(
          tx,
          this.clock,
          joined ? "machine_check_joined" : "machine_check_requested",
          {
            machine_id: machine,
            project_id: project,
            kind,
            member_id: member,
            check_id: actual.id,
          },
        );
      },
    );
    if (!joined) {
      const done = Promise.resolve().then(() =>
        this.execute(
          job,
          (progress) =>
            host.check(project, machine, kind, progress, this.signal, job.id),
          ({ status, failed_steps }) => ({ status, failed_steps }),
          (tx, final) => {
            machineAudit(
              tx,
              this.clock,
              "machine_check_finished",
              { ...final },
              "system",
            );
          },
        ),
      );
      this.pending.add(done);
      void done.then(
        () => this.pending.delete(done),
        () => this.pending.delete(done),
      );
    }
    return job;
  }
  /** Serialize confirmations across listeners until the idempotent result commits. */
  async withHelperConfirmation<T>(
    project: string,
    id: HumanActionId,
    work: () => Promise<T>,
  ) {
    const wait = async () => {
      for (;;) {
        this.signal.throwIfAborted();
        const release = await tryHelperConfirmationLock(
          this.store,
          project,
          id,
        );
        if (release) {
          try {
            return await work();
          } finally {
            await release();
          }
        }
        await delay(100, undefined, { signal: this.signal });
      }
    };
    const promise = wait();
    this.pending.add(promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(promise);
    }
  }
  currentBinding(project: string, machine: Machine | undefined) {
    try {
      return (
        (machine &&
          machine.herdr_machine === machine.id &&
          this.host?.bindingFingerprint?.(project, machine)) ||
        null
      );
    } catch {
      return null;
    }
  }
  currentUpgradeCommand(project: string, machine: Machine, binding: string) {
    try {
      if (this.currentBinding(project, machine) === binding)
        return this.host?.upgradeCommand?.(project, machine);
    } catch {
      /* Invalid configuration or unreadable release: hide stale material. */
    }
    return undefined;
  }
  async verifyHelper(
    project: string,
    machine: string | null,
    binding: string | null,
    authorize: (tx: StoreTransactionContext) => string,
  ) {
    this.store.uow.run(authorize);
    const failed = (reason: string): CheckResult => ({
      status: "failed",
      failed_steps: [reason],
    });
    const run = async (kind: CheckKind): Promise<CheckResult> => {
      const host = this.host;
      if (!machine || !binding || !host || this.signal.aborted)
        return failed("检查服务不可用");
      try {
        if (
          this.store.uow.read((tx) =>
            this.currentBinding(project, tx.machines.get(project, machine)),
          ) !== binding
        )
          return failed("机器绑定已变化");
        // Never reuse an older check, including another project's running job.
        const { job, joined } = this.claim(
          project,
          machine,
          kind,
          "web",
          (tx, job, joined) => {
            const member = authorize(tx);
            if (!tx.machines.get(project, machine))
              throw new HttpRejection(404, "not_found", "项目未登记此机器");
            machineAudit(
              tx,
              this.clock,
              joined ? "machine_check_joined" : "machine_check_requested",
              {
                machine_id: machine,
                project_id: project,
                kind,
                member_id: member,
                check_id: job.id,
              },
            );
          },
        );
        if (joined) return failed("机器检查占用中，请稍后重试");
        try {
          const result = await this.execute(
            job,
            (progress) =>
              host.check(
                project,
                machine,
                kind,
                progress,
                this.signal,
                job.id,
                { binding },
              ),
            ({ status, failed_steps }) => ({ status, failed_steps }),
            (tx, job) =>
              machineAudit(
                tx,
                this.clock,
                "machine_check_finished",
                { ...job },
                "system",
              ),
          );
          if (kind === "machine" && result.maintenance)
            return result.maintenance;
          return { status: result.status, failed_steps: result.failed_steps };
        } catch {
          return {
            status: "failed",
            failed_steps: this.read(machine, job.id)?.failed_steps ?? [
              "检查中断",
            ],
          };
        }
      } catch {
        return failed("检查服务不可用");
      }
    };
    const verify = async () => {
      if (!binding || !machine)
        return {
          worker: failed("未确认机器绑定"),
          machine: failed("未确认机器绑定"),
        };
      const worker = await run("worker");
      const machineResult = await run("machine");
      try {
        if (
          this.store.uow.read((tx) =>
            this.currentBinding(project, tx.machines.get(project, machine)),
          ) === binding
        )
          return { worker, machine: machineResult };
      } catch {
        /* configuration unreadable */
      }
      return { worker, machine: failed("无法确认机器绑定") };
    };
    const promise = verify();
    this.pending.add(promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(promise);
    }
  }
  async settled() {
    await Promise.allSettled(this.pending);
  }
}
