import type { Clock, JsonValue } from "@cardigan/domain";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { HttpRejection } from "./http.js";
import type { CheckKind, CheckResult, MachineHost } from "./machine-host.js";

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
export interface MachineCheckJob {
  id: string;
  machine_id: string;
  project_id: string;
  kind: CheckKind;
  status: "running" | "passed" | "failed";
  step: string;
  started_at: string;
  checked_at: string;
  failed_steps: readonly string[];
}
// One Workbench listener owns the asynchronous human checks. Only live work lives in
// memory: the immutable request and completion events survive a reload/restart.
export class MachineChecks {
  private readonly active = new Map<
    string,
    { job: MachineCheckJob; done: Promise<void> }
  >();
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly signal: AbortSignal,
    private readonly host?: MachineHost,
  ) {}
  start(
    project: string,
    machine: string,
    kind: CheckKind,
    authorize: (tx: StoreTransactionContext) => string,
  ) {
    if (this.signal.aborted || !this.host)
      throw new HttpRejection(503, "unavailable", "检查服务不可用");
    const host = this.host;
    const pending = this.active.get(machine);
    const id = this.store.uow.run((tx) => {
      const member = authorize(tx);
      if (!tx.machines.get(project, machine))
        throw new HttpRejection(404, "not_found", "项目未登记此机器");
      return machineAudit(
        tx,
        this.clock,
        pending ? "machine_check_joined" : "machine_check_requested",
        {
          machine_id: machine,
          project_id: project,
          kind,
          member_id: member,
          ...(pending ? { check_id: pending.job.id } : {}),
        },
      );
    });
    if (pending) return pending.job;
    const now = this.clock.now();
    const job: MachineCheckJob = {
      id,
      machine_id: machine,
      project_id: project,
      kind,
      started_at: now,
      checked_at: now,
      status: "running",
      step: "queued",
      failed_steps: [],
    };
    const done = Promise.resolve()
      .then(async () => {
        let result: CheckResult;
        try {
          result = await host.check(
            project,
            machine,
            kind,
            (step) => {
              job.step = step;
            },
            this.signal,
          );
        } catch {
          result = { status: "failed", failed_steps: [job.step] };
        }
        Object.assign(job, result, {
          step: "finished",
          checked_at: this.clock.now(),
        });
        this.store.uow.run((tx) =>
          machineAudit(
            tx,
            this.clock,
            "machine_check_finished",
            { ...job },
            "system",
          ),
        );
      })
      .finally(() => this.active.delete(machine));
    // If completion cannot be committed, the durable request reads as interrupted.
    void done.catch(() => {});
    this.active.set(machine, { job, done });
    return job;
  }
  read(machine: string, id: string): MachineCheckJob | undefined {
    const active = this.active.get(machine)?.job;
    if (active?.id === id) return active;
    const db = this.store.database;
    const request = db
      .prepare(
        "SELECT doc FROM global_events WHERE id=? AND type='machine_check_requested' AND json_extract(doc,'$.payload.machine_id')=?",
      )
      .get(id, machine);
    if (!request) return undefined;
    const result = db
      .prepare(
        "SELECT doc FROM global_events WHERE type='machine_check_finished' AND json_extract(doc,'$.payload.id')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(id);
    if (result)
      return JSON.parse(String(result.doc)).payload as MachineCheckJob;
    const { payload, created_at } = JSON.parse(String(request.doc));
    return {
      id,
      machine_id: machine,
      project_id: payload.project_id,
      kind: payload.kind,
      started_at: created_at,
      checked_at: created_at,
      status: "failed",
      step: "interrupted",
      failed_steps: ["interrupted"],
    };
  }
  latest(machine: string, project: string) {
    const row = this.store.database
      .prepare(
        "SELECT id FROM global_events WHERE type='machine_check_requested' AND json_extract(doc,'$.payload.machine_id')=? AND json_extract(doc,'$.payload.project_id')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(machine, project);
    return row ? this.read(machine, String(row.id)) : null;
  }
  async settled() {
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }
}
