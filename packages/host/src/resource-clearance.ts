import { randomUUID } from "node:crypto";
import { runOccupiesSlot } from "@cardigan/domain";
import {
  type ReadRepositories,
  type Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { bindingIdentity, type ResourceBinding } from "./resource-policy.js";
import type { ResourceProbe } from "./resource-probe.js";

// Old Runs lack an endpoint and target generation. Do not synthesize a
// release on their behalf: drain possible users, then challenge the actual
// configured target for a clean-slate proof for this binding.
export class BindingClearances {
  constructor(
    private store: Store,
    private probe: ResourceProbe,
  ) {}
  private legacyBusy(tx: ReadRepositories, machine: string, key: string) {
    for (const p of this.store.listProjects()) {
      const pending = new Set(
        unfinishedBellAttempts(this.store.database, p.id).map((a) => a.run_id),
      );
      for (const r of tx.runs.list(p.id)) {
        if (!runOccupiesSlot(r) && !pending.has(r.id)) continue;
        if (r.resource_keys && !r.resource_keys.includes(key)) continue;
        if (tx.assignments.get(p.id, r.assignment_id)?.machine_id !== machine)
          continue;
        if (
          !this.store.database
            .prepare(
              "SELECT 1 FROM machine_resource_leases WHERE project=? AND run_id=? AND resource=? AND verified_at IS NULL",
            )
            .get(p.id, r.id, key)
        )
          return true;
      }
    }
    return false;
  }
  private row(
    machine: string,
    key: string,
    project: string,
    b: ResourceBinding,
    target: string,
  ) {
    return this.store.database
      .prepare(
        "SELECT generation,verified_at FROM machine_binding_clearances WHERE machine=? AND resource=? AND project=? AND binding=? AND target=?",
      )
      .get(machine, key, project, bindingIdentity(b), target);
  }
  verified(
    machine: string,
    key: string,
    project: string,
    b: ResourceBinding,
    target?: string,
  ) {
    return (
      !!target && !!this.row(machine, key, project, b, target)?.verified_at
    );
  }
  async prepare(
    machine: string,
    key: string,
    project: string,
    b: ResourceBinding,
    target: string,
  ) {
    if (this.verified(machine, key, project, b, target)) return true;
    const gen = this.store.uow.run((tx) => {
      if (this.legacyBusy(tx, machine, key)) return;
      this.store.database
        .prepare(
          "INSERT OR IGNORE INTO machine_binding_clearances(machine,resource,project,binding,target,generation) VALUES(?,?,?,?,?,?)",
        )
        .run(machine, key, project, bindingIdentity(b), target, randomUUID());
      return this.row(machine, key, project, b, target)?.generation as string;
    });
    if (!gen || !b.release) return false;
    const result = await this.probe(
      b.release,
      {
        action: "release",
        purpose: "activation",
        machine,
        key,
        project,
        generation: gen,
        ...(b.port ? { port: b.port } : {}),
        ...(b.device ? { device: b.device } : {}),
      },
      target,
    );
    if (result !== target) return false;
    return this.store.uow.run((tx) => {
      if (this.legacyBusy(tx, machine, key)) return false;
      const now = new Date().toISOString();
      if (
        this.store.database
          .prepare(
            "UPDATE machine_binding_clearances SET verified_at=? WHERE generation=? AND verified_at IS NULL",
          )
          .run(now, gen).changes
      ) {
        tx.events.append(project, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project),
          actor: { kind: "system", project_id: project },
          type: "machine_binding_clearance_verified",
          created_at: now,
          payload: {
            machine,
            resource: key,
            generation: gen,
            proof: "target_probe",
          },
        });
      }
      return this.verified(machine, key, project, b, target);
    });
  }
}
