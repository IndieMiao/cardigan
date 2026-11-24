import { randomUUID } from "node:crypto";
import type { Actor, Assignment, JsonValue, Run } from "@cardigan/domain";
import { awaitsStartPublication, runOccupiesSlot } from "@cardigan/domain";
import {
  type ReadRepositories,
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { type AdbSlotAccess, AdbSlots } from "./adb-slots.js";
import { BindingClearances } from "./resource-clearance.js";
import { bindingIdentity, endpoints, fingerprint } from "./resource-policy.js";
import type { ResourceProbe } from "./resource-probe.js";
import type { RunCapacityConfiguration } from "./run-capacity-config.js";
import { assignmentResourceKeys, legacyResourceKeys } from "./run-resources.js";

interface Lease {
  generation: string;
  machine: string;
  resource: string;
  project: string;
  assignment_id: string | null;
  run_id: Run["id"] | null;
  starts_at: string;
  ends_at: string | null;
  deadline_recorded: string | null;
  release_state: string | null;
  binding: string | null;
  target: string | null;
  endpoints: string;
  verified_at: string | null;
}
export type ResourceAdmission = {
  signature: string;
  target?: string;
  failure?: string;
};
export type ResourceAccess = {
  target?: string;
  bindings: {
    key: string;
    generation: string;
    port?: number;
    device?: string;
  }[];
  /** C-679: this Run's own adb server and emulator ports. */
  adb?: AdbSlotAccess;
};
function event(
  tx: StoreTransactionContext,
  actor: Actor,
  type: string,
  at: string,
  payload: JsonValue,
) {
  const project = actor.project_id;
  tx.events.append(project, {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project),
    actor,
    type,
    created_at: at,
    payload,
  });
}
const system = (project: string) => ({
  kind: "system" as const,
  project_id: project,
});
const canonicalTime = (s: string) => {
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/.test(
      s,
    ) ||
    !Number.isFinite(Date.parse(s))
  )
    throw new Error("预约需要带时区的绝对时间");
  // Date.parse normalizes e.g. February 30. Validate the local calendar
  // before applying the offset (which may legitimately change the UTC day).
  const date = s.slice(0, 10);
  if (
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
    Number(s.slice(11, 13)) > 23
  )
    throw new Error("无效预约日期或时间");
  return new Date(s).toISOString();
};
export class MachineLeases {
  private clearances: BindingClearances;
  readonly adb: AdbSlots;
  constructor(
    readonly store: Store,
    readonly config: RunCapacityConfiguration,
    private readonly probe: ResourceProbe,
    private readonly publicationProbe: ResourceProbe = probe,
  ) {
    this.clearances = new BindingClearances(store, probe);
    this.adb = new AdbSlots(store, config, probe.adb);
  }
  private rows(sql: string, ...args: string[]): Lease[] {
    return this.store.database
      .prepare(`SELECT * FROM machine_resource_leases WHERE ${sql}`)
      .all(...args) as unknown as Lease[];
  }
  private policy(machine: string, project: string, key: string) {
    return this.config.policies(machine)?.get(key)?.bindings.get(project);
  }
  private managed(machine: string) {
    return [...(this.config.policies(machine)?.values() ?? [])].some(
      (p) => p.bindings.size > 0,
    );
  }
  /** C-679: this Assignment's Runs each get their own adb slot. */
  adbNeeded(project: string, a: Assignment) {
    return (
      !!this.config.adbSlots(a.machine_id) &&
      !!this.adb.applies(
        a.machine_id,
        this.store.uow.read((tx) => assignmentResourceKeys(tx, project, a)),
      )
    );
  }
  freshSession(project: string, a: Assignment) {
    return (
      this.managed(a.machine_id) ||
      // A new Run must not inherit the previous Run's released adb ports.
      this.adbNeeded(project, a) ||
      !!this.store.database
        .prepare(
          "SELECT 1 FROM machine_resource_leases WHERE project=? AND assignment_id=? LIMIT 1",
        )
        .get(project, a.id)
    );
  }
  configured(project: string, machine: string) {
    return !!(
      this.config.policies(machine) ||
      this.config.projectQuota(machine, project) ||
      this.config.preferred(machine) ||
      this.store.database
        .prepare(
          "SELECT 1 FROM machine_resource_leases WHERE machine=? AND (deadline_recorded IS NULL AND ends_at IS NOT NULL OR binding IS NOT NULL AND verified_at IS NULL) LIMIT 1",
        )
        .get(machine)
    );
  }
  waitingElsewhere(
    project: string,
    owner: Assignment,
    now: string,
    tx: ReadRepositories,
    keys: readonly string[] = assignmentResourceKeys(tx, project, owner),
  ) {
    const queued = tx.runs
      .list(project)
      .find((r) => r.status === "queued" && r.assignment_id === owner.id);
    if (!queued) return false;
    const reason = this.store.database
      .prepare(
        "SELECT policy_wait FROM machine_resource_waits WHERE project=? AND run_id=?",
      )
      .get(project, queued.id)?.policy_wait;
    return reason === 1 || !!this.blocked(project, owner.machine_id, keys, now);
  }
  private active(machine: string, now: string) {
    return this.rows(
      "machine=? AND ((starts_at<=? AND ends_at>? AND deadline_recorded IS NULL) OR (binding IS NOT NULL AND verified_at IS NULL AND (run_id IS NOT NULL OR ends_at<=? OR deadline_recorded IS NOT NULL)))",
      machine,
      now,
      now,
      now,
    );
  }
  async reserve(
    actor: Actor,
    machine: string,
    key: string,
    start: string,
    end: string,
    now: () => string,
    request?: { key: string; revalidate: () => void },
  ) {
    const project = actor.project_id,
      starts = canonicalTime(start),
      ends = canonicalTime(end);
    if (
      actor.kind === "system" ||
      !this.config.resourcesForMachine(machine).has(key) ||
      starts >= ends
    )
      throw new Error("无效预约");
    const p = this.config.policies(machine)?.get(key),
      b = p?.bindings.get(project);
    const authorize = (tx: ReadRepositories) => {
      if (actor.kind === "human") return;
      if (
        actor.kind !== "assignment" ||
        !request ||
        !actor.allowed_tools.includes("reserve_machine_resource") ||
        !p?.reservableBy.has(project)
      )
        throw new Error("项目无预约授权");
      const owner = tx.assignments.get(project, actor.assignment_id);
      if (
        owner?.status !== "active" ||
        owner.scope !== "standing" ||
        owner.role_id !== "pm"
      )
        throw new Error("仅限常驻 PM");
    };
    const generation =
      actor.kind === "assignment" && request
        ? fingerprint([project, actor.assignment_id, request.key])
        : randomUUID();
    const receipt = (revalidate?: () => void) => {
      if (actor.kind !== "assignment") return;
      const prior = this.rows("generation=?", generation)[0];
      if (prior) {
        revalidate?.();
        if (
          prior.resource !== key ||
          prior.machine !== machine ||
          prior.starts_at !== starts ||
          prior.ends_at !== ends
        )
          throw new Error("幂等键冲突");
        return generation;
      }
    };
    const existing = this.store.uow.read((tx) => {
      authorize(tx);
      return receipt(request?.revalidate);
    });
    if (existing) return existing;
    if (ends <= now()) throw new Error("无效预约");
    if (p?.bindings.size && !b) throw new Error("资源不属于此项目");
    const target =
      b?.release &&
      (await this.probe(b.release, {
        action: "available",
        project,
        machine,
        key,
      }));
    return this.store.uow.run((tx) => {
      request?.revalidate();
      authorize(tx);
      if (receipt()) return generation;
      if (b && !target) throw new Error("实体资源缺少目标或释放核验");
      const at = now();
      if (
        !tx.machines.get(project, machine) ||
        ends <= at ||
        this.rows(
          "machine=? AND resource=? AND starts_at<? AND ends_at>?",
          machine,
          key,
          ends,
          starts,
        ).length
      )
        throw new Error("机器未登记或预约时段冲突");
      this.store.database
        .prepare(
          "INSERT INTO machine_resource_leases (generation,machine,resource,project,starts_at,ends_at,binding,target,endpoints) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          generation,
          machine,
          key,
          project,
          starts,
          ends,
          b ? bindingIdentity(b) : null,
          target ?? null,
          JSON.stringify(b ? endpoints(b) : []),
        );
      event(tx, actor, "machine_resource_reserved", at, {
        generation,
        machine,
        resource: key,
        holder: project,
        starts_at: starts,
        ends_at: ends,
      });
      return generation;
    });
  }
  // Only host-private policy can select a program. Recompute the key signature inside the later claim.
  // C-721: the dispatcher passes the Run's own keys; a submit/reply follow-up may claim none.
  async inspect(
    project: string,
    a: Assignment,
    keys: readonly string[] = this.store.uow.read((tx) =>
      assignmentResourceKeys(tx, project, a),
    ),
  ): Promise<ResourceAdmission> {
    return this.inspectKeys(project, a.machine_id, keys);
  }
  private async inspectKeys(
    project: string,
    machine: string,
    keys: readonly string[],
    publication?: { target: string | undefined },
  ) {
    const probe = publication ? this.publicationProbe : this.probe;
    const result: ResourceAdmission = {
      signature: fingerprint(keys),
      ...(publication?.target ? { target: publication.target } : {}),
    };
    for (const key of keys) {
      const policy = this.config.policies(machine)?.get(key);
      if (!policy) continue;
      const b = policy.bindings.get(project);
      if (policy.bindings.size && !b)
        return { ...result, failure: `${key}：未获分配` };
      const context = {
        action: "check" as const,
        project,
        machine,
        key,
        ...(b?.port ? { port: b.port } : {}),
        ...(b?.device ? { device: b.device } : {}),
      };
      for (const [name, cmd] of policy.checks) {
        const target = await probe(cmd, context, result.target);
        if (!target || (result.target && result.target !== target))
          return { ...result, failure: `${key}：前置检查 ${name} 未通过` };
        result.target = target;
      }
      if (b) {
        if (!b.release) return { ...result, failure: `${key}：缺少释放核验` };
        const target = await probe(
          b.release,
          { ...context, action: "available" },
          result.target,
        );
        if (!target || (result.target && result.target !== target))
          return { ...result, failure: `${key}：目标机不可核验` };
        if (
          !publication &&
          !(await this.clearances.prepare(machine, key, project, b, target))
        )
          return { ...result, failure: `${key}：等待目标机清场核验` };
        result.target = target;
      }
    }
    if (this.adb.applies(machine, keys)) {
      const target = await probe(
        undefined,
        { action: "available", project, machine, key: "adb" },
        result.target,
      );
      if (!target || (result.target && result.target !== target))
        return { ...result, failure: "adb：目标机不可用" };
      result.target = target;
    }
    return result;
  }
  blocked(
    project: string,
    machine: string,
    keys: readonly string[],
    now: string,
    inspection?: ResourceAdmission,
    own?: ResourceAccess,
  ) {
    if (
      inspection &&
      (inspection.signature !== fingerprint(keys) || inspection.failure)
    )
      return inspection.failure ?? "资源需求已变化";
    if (!keys.length) return;
    const leases = this.active(machine, now);
    for (const key of keys) {
      const policy = this.config.policies(machine)?.get(key),
        b = policy?.bindings.get(project);
      if (policy?.bindings.size && !b) return `${key}：未获分配`;
      if (
        b &&
        inspection &&
        !this.clearances.verified(machine, key, project, b, inspection.target)
      )
        return `${key}：等待目标机清场核验`;
      const ids = b ? endpoints(b) : [];
      for (const l of leases) {
        if (own?.bindings.some((b) => b.generation === l.generation)) continue;
        if (
          l.resource !== key &&
          !ids.some((id) => (JSON.parse(l.endpoints) as string[]).includes(id))
        )
          continue;
        if (l.ends_at && l.ends_at > now && !l.deadline_recorded) {
          if (l.project !== project) return `${key}：预约独占`;
        } else if (l.binding && !l.verified_at) return `${key}：等待释放核验`;
      }
    }
    if (!own?.adb) return this.adb.blocked(machine, keys);
  }
  private policySignature(
    machine: string,
    project: string,
    keys: readonly string[],
  ) {
    return fingerprint(
      keys
        .map((key) => {
          const policy = this.config.policies(machine)?.get(key);
          return [
            key,
            [...(policy?.checks ?? [])],
            policy?.bindings.get(project),
          ];
        })
        .concat(
          this.adb.applies(machine, keys)
            ? [
                [
                  "adb",
                  JSON.stringify(this.config.adbSlots(machine), (_, v) =>
                    v instanceof Set ? [...v] : v,
                  ),
                ],
              ]
            : [],
        ),
    );
  }
  private probeTarget(project: string, run: Run) {
    return this.store.database
      .prepare(
        "SELECT target,policy FROM machine_run_probe_targets WHERE project=? AND run_id=?",
      )
      .get(project, run.id);
  }
  hasProbeTarget(project: string, run: Run) {
    return !!this.probeTarget(project, run);
  }
  publicationWait(project: string, run: Run) {
    return !!this.store.database
      .prepare(
        "SELECT 1 FROM machine_resource_waits WHERE project=? AND run_id=? AND publication_wait=1",
      )
      .get(project, run.id);
  }
  private publicationKeys(
    project: string,
    a: Assignment,
    run: Run,
    tx?: ReadRepositories,
  ): readonly string[] {
    if (run.resource_keys) return run.resource_keys;
    // Pre-MC-4: use the same conservative claim interval as capacity. A later
    // edit removing a capability must never clear an old dispatch for retry.
    const historical = (read: ReadRepositories) => {
      const card =
        a.work_item_id && read.work_items.get(project, a.work_item_id)?.card_id;
      const keys = new Set(this.config.policies(a.machine_id)?.keys());
      for (const l of this.rows(
        "machine=? AND verified_at IS NULL",
        a.machine_id,
      ))
        keys.add(l.resource);
      if (!keys.size) return [];
      return [
        ...legacyResourceKeys(
          read,
          project,
          a,
          run,
          read.events.listAfter(project, card, 0),
          keys,
        ),
      ];
    };
    return tx ? historical(tx) : this.store.uow.read(historical);
  }
  private publicationGrant(
    project: string,
    a: Assignment,
    run: Run,
    tx?: ReadRepositories,
  ) {
    const keys = this.publicationKeys(project, a, run, tx);
    const pin = this.probeTarget(project, run);
    if (
      pin &&
      run.resource_keys &&
      pin.policy === this.policySignature(a.machine_id, project, keys)
    )
      return { keys, target: String(pin.target) };
    const policies = this.config.policies(a.machine_id);
    if (
      pin ||
      keys.some(
        (key) =>
          policies?.get(key)?.checks.size || policies?.get(key)?.bindings.size,
      ) ||
      this.adb.applies(a.machine_id, keys)
    )
      return {
        keys,
        readmit: "原资源领取记录不足或配置已变，等待确认退出后重新排队",
      };
    return { keys };
  }
  readmissionReason(
    project: string,
    a: Assignment,
    run: Run,
    tx?: ReadRepositories,
  ) {
    return this.publicationGrant(project, a, run, tx).readmit;
  }
  /** Only new starts call this. Probe the durable Run snapshot (not mutable
   * work-item requirements) and keep the reason visible while delivery waits. */
  async canPublish(
    project: string,
    a: Assignment,
    run: Run,
    now: () => string,
    access?: ResourceAccess,
  ) {
    const current = this.store.uow.read((tx) => tx.runs.get(project, run.id));
    if (!current || !awaitsStartPublication(current)) return false;
    const grant = this.publicationGrant(project, a, current);
    if (!grant.readmit && !grant.target)
      return !this.startBlocked(project, a, current, now(), access);
    const result =
      grant.target && (!access?.target || access.target === grant.target)
        ? await this.inspectKeys(project, a.machine_id, grant.keys, {
            target: grant.target,
          })
        : undefined;
    return this.store.uow.run((tx) => {
      const fresh = tx.runs.get(project, run.id);
      if (!fresh || !awaitsStartPublication(fresh)) return false;
      const at = now();
      const reason = !result
        ? (grant.readmit ?? "原执行目标或前置检查配置已变化")
        : (result.failure ??
          this.startBlocked(project, a, fresh, at, access, tx));
      if (reason) {
        this.wait(tx, project, a, fresh, reason, at, true, !!result);
        if (fresh.status === "queued")
          tx.runs.put(project, { ...fresh, queue_reason: "concurrency_limit" });
        return false;
      }
      this.store.database
        .prepare(
          "DELETE FROM machine_resource_waits WHERE project=? AND run_id=?",
        )
        .run(project, fresh.id);
      return true;
    });
  }
  /** Recheck the pinned grant immediately before publication, including a retry of a previously dispatched bell. */
  startBlocked(
    project: string,
    a: Assignment,
    run: Run,
    now: string,
    expected?: ResourceAccess,
    tx?: ReadRepositories,
  ) {
    const { keys, readmit } = this.publicationGrant(project, a, run, tx);
    if (readmit) return readmit;
    if (!keys.length) return;
    const held = this.rows(
      "project=? AND assignment_id=? AND run_id=? AND verified_at IS NULL",
      project,
      a.id,
      run.id,
    );
    const own: ResourceAccess = {
      bindings: held.map((l) => ({
        key: l.resource,
        generation: l.generation,
      })),
    };
    if (
      expected?.bindings.some(
        (b) => !held.some((l) => l.generation === b.generation),
      )
    )
      return "资源持有者已变化";
    for (const key of keys) {
      const binding = this.policy(a.machine_id, project, key);
      if (
        binding &&
        !held.some(
          (l) =>
            l.resource === key &&
            l.machine === a.machine_id &&
            l.binding === bindingIdentity(binding),
        )
      )
        return `${key}：尚未取得本代次归属`;
    }
    if (this.adb.applies(a.machine_id, keys)) {
      const slot = this.adb.launchSlot(project, a.machine_id, run.id);
      if (!slot) return "adb：尚未取得端口槽位";
      if (expected?.adb && expected.adb.generation !== slot.generation)
        return "资源持有者已变化";
      own.adb = slot;
    }
    return this.blocked(project, a.machine_id, keys, now, undefined, own);
  }
  // Called after all other admission gates, inside the BellAttempt transaction.
  acquire(
    tx: StoreTransactionContext,
    project: string,
    a: Assignment,
    run: Run,
    keys: readonly string[],
    i: ResourceAdmission,
    now: string,
  ): ResourceAccess | undefined {
    const machine = a.machine_id;
    if (this.blocked(project, machine, keys, now, i))
      throw new Error("资源状态已变化");
    this.store.database
      .prepare(
        "DELETE FROM machine_resource_waits WHERE project=? AND run_id=?",
      )
      .run(project, run.id);
    if (i.target)
      this.store.database
        .prepare(
          "INSERT INTO machine_run_probe_targets VALUES (?,?,?,?) ON CONFLICT(project,run_id) DO UPDATE SET target=excluded.target, policy=excluded.policy",
        )
        .run(
          project,
          run.id,
          i.target,
          this.policySignature(machine, project, keys),
        );
    const adb = this.adb.acquire(tx, project, a, run, keys, i.target, now);
    if (!this.managed(machine) && !i.target) return;
    const access: ResourceAccess = {
      ...(i.target ? { target: i.target } : {}),
      bindings: [],
      ...(adb ? { adb } : {}),
    };
    for (const key of keys) {
      const b = this.policy(machine, project, key);
      if (!b) continue;
      if (!i.target || !b.release) throw new Error("实体资源未核验");
      const generation = randomUUID();
      this.store.database
        .prepare(
          "INSERT INTO machine_resource_leases (generation,machine,resource,project,assignment_id,run_id,starts_at,binding,target,endpoints) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          generation,
          machine,
          key,
          project,
          a.id,
          run.id,
          now,
          bindingIdentity(b),
          i.target,
          JSON.stringify(endpoints(b)),
        );
      access.bindings.push({
        key,
        generation,
        ...(b.device ? { device: b.device } : {}),
        ...(b.port ? { port: b.port } : {}),
      });
      event(tx, system(project), "machine_resource_acquired", now, {
        generation,
        machine,
        resource: key,
        assignment_id: a.id,
        run_id: run.id,
      });
    }
    return access;
  }
  wait(
    tx: StoreTransactionContext,
    project: string,
    a: Assignment,
    run: Run,
    reason: string,
    now: string,
    policyWait = true,
    publicationWait = false,
  ) {
    const changed = this.store.database
      .prepare(
        `INSERT INTO machine_resource_waits VALUES(?,?,?,?,?,?) ON CONFLICT(project,run_id) DO UPDATE SET reason=excluded.reason,policy_wait=excluded.policy_wait,publication_wait=excluded.publication_wait WHERE reason<>excluded.reason OR policy_wait<>excluded.policy_wait OR publication_wait<>excluded.publication_wait`,
      )
      .run(
        project,
        run.id,
        a.machine_id,
        reason,
        Number(policyWait),
        Number(publicationWait),
      ).changes;
    if (changed)
      event(tx, system(project), "machine_resource_waiting", now, {
        machine: a.machine_id,
        run_id: run.id,
        reason,
      });
  }
  private eligible(tx: ReadRepositories, l: Lease, now: string) {
    if (l.ends_at) return l.ends_at <= now;
    if (!l.run_id) return false;
    const run = tx.runs.get(l.project, l.run_id);
    return (
      run &&
      ["completed", "failed", "cancelled", "queued"].includes(run.status) &&
      !runOccupiesSlot(run) &&
      !unfinishedBellAttempts(this.store.database, l.project).some(
        (b) => b.run_id === run.id,
      )
    );
  }
  async reconcile(project: string, clock: () => string) {
    this.adb.kick(project, clock);
    if (
      !this.store.database
        .prepare(
          "SELECT 1 FROM machine_resource_leases WHERE project=? AND ((deadline_recorded IS NULL AND ends_at<=?) OR (binding IS NOT NULL AND verified_at IS NULL AND (ends_at IS NULL OR ends_at<=?))) LIMIT 1",
        )
        .get(project, clock(), clock())
    )
      return;
    const pending = this.store.uow.run((tx) => {
      const at = clock();
      for (const l of this.rows(
        "project=? AND ends_at<=? AND deadline_recorded IS NULL",
        project,
        at,
      )) {
        this.store.database
          .prepare(
            "UPDATE machine_resource_leases SET deadline_recorded=? WHERE generation=?",
          )
          .run(at, l.generation);
        event(tx, system(project), "machine_resource_deadline", at, {
          generation: l.generation,
          machine: l.machine,
          resource: l.resource,
          ends_at: l.ends_at,
          observed_at: at,
          physical_release: l.binding ? "pending" : "not_applicable",
        });
      }
      return this.rows(
        "project=? AND binding IS NOT NULL AND verified_at IS NULL AND (ends_at IS NULL OR ends_at<=?)",
        project,
        at,
      ).filter((l) => this.eligible(tx, l, at));
    });
    for (const l of pending) {
      const b = this.policy(l.machine, project, l.resource);
      const failure = (reason: string) => {
        this.store.uow.run((tx) => {
          if (
            this.store.database
              .prepare(
                "UPDATE machine_resource_leases SET release_state=? WHERE generation=? AND verified_at IS NULL AND release_state IS NOT ?",
              )
              .run(reason, l.generation, reason).changes
          )
            event(
              tx,
              system(project),
              "machine_resource_release_pending",
              clock(),
              {
                generation: l.generation,
                resource: l.resource,
                machine: l.machine,
                reason,
              },
            );
        });
      };
      if (!b?.release || !l.target || bindingIdentity(b) !== l.binding) {
        failure("核验配置缺失或归属已变");
        continue;
      }
      const target = await this.probe(
        b.release,
        {
          action: "release",
          project,
          machine: l.machine,
          key: l.resource,
          generation: l.generation,
          ...(l.run_id ? { run_id: l.run_id } : {}),
          ...(b.port ? { port: b.port } : {}),
          ...(b.device ? { device: b.device } : {}),
        },
        l.target,
      );
      if (target !== l.target) {
        failure("目标不可达或未证明释放");
        continue;
      }
      this.store.uow.run((tx) => {
        const at = clock();
        if (!this.eligible(tx, l, at)) return;
        const changed = this.store.database
          .prepare(
            "UPDATE machine_resource_leases SET verified_at=? WHERE generation=? AND project=? AND target=? AND verified_at IS NULL",
          )
          .run(at, l.generation, project, target).changes;
        if (changed)
          event(tx, system(project), "machine_resource_release_verified", at, {
            generation: l.generation,
            machine: l.machine,
            resource: l.resource,
            proof: "target_probe",
            ...(l.ends_at
              ? {
                  after_deadline_ms: Math.max(
                    0,
                    Date.parse(at) - Date.parse(l.ends_at),
                  ),
                }
              : {}),
            probe_fingerprint: fingerprint(b.release),
          });
      });
    }
  }
}
