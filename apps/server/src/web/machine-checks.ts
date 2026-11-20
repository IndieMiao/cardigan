import type { Clock, JsonValue } from "@cardigan/domain";
import { type CheckKind, MachineCheckJournal } from "@cardigan/host";
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
          (value) => value,
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
  async settled() {
    await Promise.allSettled(this.pending);
  }
}
