import type {
  Actor,
  CardId,
  CheckRecoveryOutcome,
  CheckRecoveryState,
  MergeCheckView,
  ProjectId,
} from "@cardigan/domain";
import { canRecheckRecovery } from "@cardigan/domain";
import type { Store } from "./store.js";

export interface RecoveryRegistration {
  registration_id: string;
  card_id: CardId;
  attempt_id: string;
  candidate_sha: string;
  executor_key: string;
  binding: unknown;
  state: CheckRecoveryState;
  result?: CheckRecoveryOutcome;
  evidence_key: string | null;
  next_inspection_at: string;
  revision: number;
}
function decode(row: Record<string, unknown>): RecoveryRegistration {
  return {
    ...row,
    binding: JSON.parse(row.binding as string),
    result: row.result ? JSON.parse(row.result as string) : undefined,
  } as RecoveryRegistration;
}
/** All writes participate in the caller's Store transaction. No event replay on patrol. */
export class CheckRecoveryJournal {
  constructor(private readonly store: Store) {}
  check(
    project: ProjectId,
    card: CardId,
    attempt: string,
  ): MergeCheckView | undefined {
    const row = this.store.database
      .prepare(
        "SELECT doc FROM check_recovery_attempts WHERE project_id=? AND card_id=? AND attempt_id=?",
      )
      .get(project, card, attempt);
    return row ? JSON.parse(row.doc as string) : undefined;
  }
  get(
    project: ProjectId,
    registration: string,
  ): RecoveryRegistration | undefined {
    const row = this.store.database
      .prepare(
        "SELECT * FROM check_recovery_registrations WHERE project_id=? AND registration_id=?",
      )
      .get(project, registration);
    return row ? decode(row) : undefined;
  }
  registered(project: ProjectId, card: CardId, attempt: string): boolean {
    return !!this.store.database
      .prepare(
        "SELECT 1 FROM check_recovery_registrations WHERE project_id=? AND card_id=? AND attempt_id=?",
      )
      .get(project, card, attempt);
  }
  due(
    project: ProjectId,
    executor: string,
    now: string,
  ): RecoveryRegistration[] {
    return this.store.database
      .prepare(`SELECT r.* FROM check_recovery_registrations r
      JOIN check_recovery_attempts a USING(project_id,card_id,attempt_id)
      WHERE r.project_id=? AND r.executor_key=? AND r.next_inspection_at<=?
      AND json_extract(a.doc,'$.candidate_sha')=r.candidate_sha
      AND json_extract(a.doc,'$.status') IN ('passed','failed','timed_out','interrupted','executor_unreachable')
      ORDER BY r.registration_id`)
      .all(project, executor, now)
      .map(decode);
  }
  claim(
    project: ProjectId,
    row: RecoveryRegistration,
    next: string,
  ): number | undefined {
    const result = this.store.database
      .prepare(`UPDATE check_recovery_registrations SET next_inspection_at=?,revision=revision+1
      WHERE project_id=? AND registration_id=? AND revision=? AND next_inspection_at=?`)
      .run(
        next,
        project,
        row.registration_id,
        row.revision,
        row.next_inspection_at,
      );
    return result.changes ? row.revision + 1 : undefined;
  }
  settle(
    project: ProjectId,
    row: RecoveryRegistration,
    revision: number,
    result: CheckRecoveryOutcome,
    evidence: string,
  ): boolean {
    return !!this.store.database
      .prepare(`UPDATE check_recovery_registrations SET state=?,result=?,evidence_key=?
      WHERE project_id=? AND registration_id=? AND revision=?`)
      .run(
        result.status,
        JSON.stringify(result),
        evidence,
        project,
        row.registration_id,
        revision,
      ).changes;
  }
  recheck(actor: Actor, project: ProjectId, registration: string): boolean {
    if (!canRecheckRecovery(actor, project))
      throw new Error("Unauthorized recovery recheck");
    return !!this.store.database
      .prepare(`UPDATE check_recovery_registrations SET state='pending',next_inspection_at='',revision=revision+1
      WHERE project_id=? AND registration_id=?`)
      .run(project, registration).changes;
  }
}
