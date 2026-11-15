import type { Store } from "./store.js";

export interface CheckHandoff {
  project_id: string;
  target: string;
  generation: number;
  phase: "draining" | "leased" | "held" | "open";
  controller: string;
  binding: string;
  holder: string | null;
}
export interface CheckGrant {
  generation: number;
  controller: string;
  binding: string;
  holder: string;
}
export class CheckAdmissionClosed extends Error {
  constructor() {
    super("检查目标已围栏，保留排队");
  }
}

/** Caller holds the SAME write transaction as its capacity reservation. */
export function assertCheckAdmission(
  store: Store,
  project: string,
  target: string,
  grant?: CheckGrant,
): void {
  const row = store.database
    .prepare(
      "SELECT * FROM check_handoff WHERE (target = ? OR project_id = ?) AND phase <> 'open'",
    )
    .get(target, project) as unknown as CheckHandoff | undefined;
  if (!grant && !row) return;
  if (
    !row ||
    !grant ||
    row.project_id !== project ||
    row.target !== target ||
    row.phase !== "leased" ||
    row.generation !== grant.generation ||
    row.controller !== grant.controller ||
    row.binding !== grant.binding ||
    row.holder !== grant.holder
  )
    throw new CheckAdmissionClosed();
}

/** Private host service; async probes run outside transactions and must be rechecked by CAS. */
export class CheckHandoffs {
  constructor(
    private readonly store: Store,
    readonly controller: string,
  ) {}
  read(project: string, target: string): CheckHandoff | undefined {
    return this.store.database
      .prepare(
        "SELECT * FROM check_handoff WHERE project_id = ? AND target = ?",
      )
      .get(project, target) as unknown as CheckHandoff | undefined;
  }
  blocked(target: string): boolean {
    return !!this.store.database
      .prepare(
        "SELECT 1 FROM check_handoff WHERE target = ? AND phase <> 'open'",
      )
      .get(target);
  }
  blockedProject(project: string): boolean {
    return !!this.store.database
      .prepare(
        "SELECT 1 FROM check_handoff WHERE project_id=? AND phase <> 'open'",
      )
      .get(project);
  }
  private audit(row: CheckHandoff, action: string, evidence = "") {
    this.store.database
      .prepare(
        "INSERT INTO check_handoff_audit (project_id,target,generation,action,evidence) VALUES (?,?,?,?,?)",
      )
      .run(row.project_id, row.target, row.generation, action, evidence);
  }
  /** Called only after the original controller's exclusive local endpoint is acquired. */
  recover(): void {
    this.store.uow.run(() => {
      const rows = this.store.database
        .prepare("SELECT * FROM check_handoff WHERE phase <> 'open'")
        .all() as unknown as CheckHandoff[];
      for (const row of rows) {
        this.store.database
          .prepare(
            "UPDATE check_handoff SET phase='held', generation=generation+1, controller=?, holder=NULL WHERE project_id=? AND target=?",
          )
          .run(this.controller, row.project_id, row.target);
        this.audit(
          { ...row, generation: row.generation + 1 },
          "controller_restart",
        );
      }
    });
  }
  begin(project: string, target: string, binding: string): CheckHandoff {
    return this.store.uow.run(() => {
      const old = this.read(project, target);
      if (old && old.phase !== "open") {
        if (old.binding !== binding || old.controller !== this.controller)
          throw new CheckAdmissionClosed();
        return old;
      }
      const row: CheckHandoff = {
        project_id: project,
        target,
        generation:
          Number(
            this.store.database
              .prepare(
                "SELECT COALESCE(MAX(generation),0) AS generation FROM check_handoff WHERE project_id=?",
              )
              .get(project)?.generation,
          ) + 1,
        phase: "draining",
        controller: this.controller,
        binding,
        holder: null,
      };
      this.store.database
        .prepare(
          "INSERT INTO check_handoff VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(project_id,target) DO UPDATE SET generation=excluded.generation,phase=excluded.phase,controller=excluded.controller,binding=excluded.binding,holder=NULL",
        )
        .run(
          project,
          target,
          row.generation,
          row.phase,
          row.controller,
          binding,
        );
      this.audit(row, "begin");
      return row;
    });
  }
  current(
    project: string,
    target: string,
    generation: number,
    binding?: string,
  ): CheckHandoff {
    const row = this.read(project, target);
    if (
      !row ||
      row.generation !== generation ||
      row.controller !== this.controller ||
      (binding !== undefined && row.binding !== binding)
    )
      throw new CheckAdmissionClosed();
    return row;
  }
  claim(
    project: string,
    target: string,
    generation: number,
    binding: string,
    holder: string,
    validate: () => void = () => {},
  ): CheckGrant {
    return this.store.uow.run(() => {
      const row = this.current(project, target, generation, binding);
      if (row.phase !== "draining") throw new CheckAdmissionClosed();
      validate();
      this.store.database
        .prepare(
          "UPDATE check_handoff SET phase='leased',holder=? WHERE project_id=? AND target=?",
        )
        .run(holder, project, target);
      this.audit(row, "claim");
      return { generation, binding, holder, controller: this.controller };
    });
  }
  hold(
    project: string,
    target: string,
    generation: number,
    evidence: string,
  ): void {
    this.store.uow.run(() => {
      const row = this.current(project, target, generation);
      if (row.phase === "open") throw new CheckAdmissionClosed();
      this.store.database
        .prepare(
          "UPDATE check_handoff SET phase='held',holder=NULL WHERE project_id=? AND target=?",
        )
        .run(project, target);
      this.audit(row, "hold", evidence);
    });
  }
  resume(
    project: string,
    target: string,
    generation: number,
    evidence: string,
    validate: () => void = () => {},
  ): CheckHandoff {
    return this.store.uow.run(() => {
      const row = this.current(project, target, generation);
      if (row.phase === "open") return row;
      if (row.phase === "leased") throw new CheckAdmissionClosed();
      validate();
      // A successful exact resource probe is supplied only by the controller.
      this.store.database
        .prepare(
          "UPDATE check_handoff SET phase='open',holder=NULL WHERE project_id=? AND target=?",
        )
        .run(project, target);
      this.audit(row, "resume", evidence);
      return { ...row, phase: "open", holder: null };
    });
  }
}
