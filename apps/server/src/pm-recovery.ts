import {
  type Clock,
  type ProjectId,
  pmRecoveryEligible,
  type Runtime,
  recoverStandingPm,
} from "@cardigan/domain";
import { revokeStoppedRunTokens, tryHostOpsLock } from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { type Store, unfinishedBellAttempts } from "@cardigan/store";

/** Uses the existing launch mutex and independent runtime observation; no forced stop. */
export async function recoverPmSession(
  store: Store,
  project: ProjectId,
  runtime: Runtime,
  clock: Clock,
  mayRecover = () => true,
) {
  const read = () => store.uow.read((tx) => loadCommandState(tx, project));
  const initial = read();
  const candidate = initial.assignments.find((a) =>
    pmRecoveryEligible(initial, a),
  );
  if (!candidate) return;
  const unlock = await tryHostOpsLock(store, project, candidate.id, "launch");
  if (!unlock) return;
  try {
    const state = read();
    const a = state.assignments.find((v) => v.id === candidate.id);
    if (
      !a ||
      !pmRecoveryEligible(state, a) ||
      unfinishedBellAttempts(store.database, project).some(
        (t) => t.assignment_id === a.id,
      )
    )
      return;
    const observed = a.runtime_ref
      ? await runtime.status(a.runtime_ref).catch(() => undefined)
      : undefined;
    const exited =
      !a.runtime_ref ||
      (observed?.ok
        ? observed.value.process === "exited"
        : observed?.error.code === "runtime_not_found");
    if (!exited || !mayRecover()) return;
    store.uow.run((tx) => {
      if (
        unfinishedBellAttempts(store.database, project).some(
          (t) => t.assignment_id === a.id,
        )
      )
        return;
      const effect = unwrap(
        recoverStandingPm(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          {
            assignment: a,
            runs: state.runs.filter((r) => r.assignment_id === a.id),
            exited: true,
          },
          { clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, project, effect);
      if (effect.data) revokeStoppedRunTokens(tx, project, a.id);
    });
  } finally {
    await unlock();
  }
}
