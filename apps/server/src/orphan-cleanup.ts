import type {
  Assignment,
  Clock,
  CommandState,
  ProjectId,
  RemoteWorkerLoss,
  Runtime,
} from "@cardigan/domain";
import { remoteWorkerLossReleased } from "@cardigan/domain";
import { idleRetirementPolicy } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { unfinishedRun } from "./dispatch-alert.js";

export type SnapshotOrphan = (
  project: ProjectId,
  a: Assignment,
  expected?: string,
) => Promise<string>;
const facts = (s: CommandState, loss: RemoteWorkerLoss) =>
  s.events.filter(
    (e) =>
      e.actor.kind === "system" &&
      (e.payload as { action_id?: string } | null)?.action_id ===
        loss.action_id,
  );

// A released owner cannot receive another bell. A finished Run on an active
// Assignment, even an idle one, is NOT an orphan. Fail closed on other owners.
function exclusive(s: CommandState, loss: RemoteWorkerLoss) {
  const a = s.assignments.find((a) => a.id === loss.assignment_id),
    ref = loss.runtime_ref,
    g = ref?.launch_generation;
  if (
    !a ||
    !g ||
    !ref ||
    !loss.process ||
    !remoteWorkerLossReleased(s.events, loss.action_id) ||
    a.status !== "released" ||
    a.runtime_ref ||
    a.external ||
    a.machine_id !== loss.machine_id ||
    a.machine_id !== ref.machine_id ||
    a.work_item_id !== loss.work_item_id ||
    ref.target?.project_id !== s.project_id ||
    loss.process.machine !== ref.target.fingerprint ||
    loss.process.terminal !== g.generation ||
    !a.worktree_path ||
    a.worktree_path !== ref.worktree_path ||
    !a.branch ||
    a.branch !== ref.branch
  )
    return;
  if (
    !s.runs.some(
      (r) => r.id === g.run_id && r.assignment_id === a.id && !unfinishedRun(r),
    )
  )
    return;
  const owners = s.assignments.filter(
    (b) => b.id === a.id || b.work_item_id === a.work_item_id,
  );
  if (
    s.runs.some(
      (r) => unfinishedRun(r) && owners.some((b) => b.id === r.assignment_id),
    )
  )
    return;
  if (
    s.assignments.some(
      (b) =>
        b.id !== a.id &&
        b.status === "active" &&
        b.machine_id === a.machine_id &&
        (b.worktree_path === a.worktree_path ||
          b.runtime_ref?.terminal_ref === ref.terminal_ref),
    )
  )
    return;
  return { ...a, runtime_ref: ref };
}

export async function cleanReleasedOrphan(options: {
  store: Store;
  clock: Clock;
  project: ProjectId;
  loss: RemoteWorkerLoss;
  alive: boolean;
  stopped: () => boolean;
  runtime: Pick<Runtime, "retire_idle">;
  snapshot?: SnapshotOrphan;
}) {
  const { store, project, clock, loss, runtime, snapshot } = options;
  const state = () => store.uow.read((tx) => loadCommandState(tx, project));
  const emit = (
    tx: StoreTransactionContext,
    type: string,
    reason: string,
    sha?: string,
  ) => {
    const card = tx.work_items.get(project, loss.work_item_id)?.card_id;
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project, card),
      ...(card ? { card_id: card } : {}),
      type,
      actor: { kind: "system", project_id: project },
      created_at: clock.now(),
      payload: {
        action_id: loss.action_id,
        assignment_id: loss.assignment_id,
        reason,
        ...(sha
          ? {
              sha,
              ref: `refs/cardigan/backups/orphans/${loss.assignment_id}/${loss.runtime_ref?.launch_generation?.generation}`,
            }
          : {}),
      },
    });
  };
  const audit = (reason: string, sha?: string) =>
    store.uow.run((tx) => {
      if (
        !facts(loadCommandState(tx, project), loss).some(
          (e) =>
            e.type === "remote_orphan_observed" &&
            (e.payload as { reason?: string }).reason === reason,
        )
      )
        emit(tx, "remote_orphan_observed", reason, sha);
    });
  const initial = state();
  if (
    !remoteWorkerLossReleased(initial.events, loss.action_id) ||
    options.stopped()
  )
    return;
  const terminalFact = (s: CommandState) =>
    facts(s, loss).some((e) =>
      ["remote_worker_exit_observed", "remote_orphan_stop_started"].includes(
        e.type,
      ),
    );
  if (terminalFact(initial)) return;
  if (!options.alive) return audit("process_unverified");
  const a = exclusive(initial, loss),
    receipt = loss.process;
  if (!a || !receipt) return audit("exclusive_owner_unverified");
  if (!runtime.retire_idle || !snapshot) return audit("unsupported");
  // No repeated IO after a failed backup/unsupported pidfd. Keep observing for exit.
  if (
    facts(initial, loss).some(
      (e) => e.type === "remote_orphan_cleanup_finished",
    )
  )
    return;
  const eligible = (s: CommandState) =>
    !options.stopped() && !terminalFact(s) && !!exclusive(s, loss);
  let sha: string | undefined,
    verified = false,
    backupFailed = false;
  const result = await runtime
    .retire_idle(a.runtime_ref, {
      ...idleRetirementPolicy(),
      system_finished_turn: true,
      project_id: project,
      assignment_id: a.id,
      expected_process: receipt,
      workspace_preflight: async () => {
        if (!eligible(state())) return false;
        try {
          sha = await snapshot(project, a);
          verified =
            eligible(state()) &&
            /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha) &&
            (await snapshot(project, a, sha)) === sha;
        } catch {
          backupFailed = true;
        }
        return verified;
      },
      before_signal: () =>
        store.uow.run((tx) => {
          if (!verified || !sha || !eligible(loadCommandState(tx, project)))
            return false;
          // A crash or uncertain result beyond this point is observe-only.
          emit(tx, "remote_orphan_stop_started", "term", sha);
          return true;
        }),
    })
    .catch(() => undefined);
  const reason = backupFailed
    ? "backup_failed"
    : result?.ok
      ? result.value.outcome === "exited"
        ? "await_process_confirmation"
        : result.value.evidence.reason
      : "result_unknown";
  store.uow.run((tx) =>
    emit(tx, "remote_orphan_cleanup_finished", reason, sha),
  );
}
