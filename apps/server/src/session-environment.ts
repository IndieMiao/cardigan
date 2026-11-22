import type { Assignment, ProjectId, RunId } from "@cardigan/domain";
import type { StoreTransactionContext } from "@cardigan/store";

/** Bound at admission, not a delivery receipt. A later edit must drain this Run again. */
export function recordSessionEnvironment(
  tx: StoreTransactionContext,
  project: ProjectId,
  owner: Assignment,
  runId: RunId,
  fingerprint: string,
  at: string,
) {
  const run = tx.runs.get(project, runId);
  if (
    !run ||
    run.assignment_id !== owner.id ||
    run.session_environment_binding === fingerprint
  )
    return;
  tx.runs.put(project, { ...run, session_environment_binding: fingerprint });
  const card =
    (owner.work_item_id &&
      tx.work_items.get(project, owner.work_item_id)?.card_id) ||
    run.bell_delivery?.card_id;
  const seq = tx.ids.nextEventSequence(project, card);
  const body = `${owner.id} 的 ${run.id} 续派目标为原会话；本会话仍用旧环境，新建会话使用新环境。`;
  tx.events.append(project, {
    id: tx.ids.nextEventId(),
    seq,
    type: "session_environment_retained",
    ...(card ? { card_id: card } : {}),
    actor: { kind: "system", project_id: project },
    created_at: at,
    payload: { assignment_id: owner.id, run_id: run.id, reason: body },
  });
  if (card) {
    const id = tx.ids.nextTimelineEntryId(project, card);
    tx.timeline.put(project, {
      id,
      short_id: id,
      card_id: card,
      event_seq: seq,
      type: "system",
      author: "system",
      refs: [],
      mentions: [],
      retracted: false,
      created_at: at,
      body,
    });
  }
}
