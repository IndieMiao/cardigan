import type { AssignmentId, ProjectId, RunId } from "@cardigan/domain";
import {
  type RuntimeTargets,
  resourceTarget,
  resourceWorker,
} from "@cardigan/host";
import type { Store } from "@cardigan/store";

export function resourceExpiry(
  value = process.env.CARDIGAN_RUN_RESOURCE_MAX_AGE_SECONDS,
) {
  if (value === undefined) return 24 * 3600;
  const age = Number(value);
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(age))
    throw new Error("Invalid Run resource expiry");
  return age;
}
/** No machine name fallback. An unavailable/changed target retains its resources. */
export async function reconcileRunResources(
  store: Store,
  targets: Pick<RuntimeTargets, "resolve">,
  project: ProjectId,
  audit: (text: string) => void,
  worker = resourceWorker,
  now = Date.now,
) {
  const age = resourceExpiry();
  for (const machine of store.uow.read((tx) => tx.machines.list(project))) {
    if (!["online", "degraded"].includes(machine.status)) continue;
    try {
      const { execution } = targets.resolve(project, machine.id);
      const tag = resourceTarget(project, machine.id, execution);
      const registrations = await worker(execution, tag, age);
      const ended = store.uow.read((tx) =>
        registrations.flatMap((item) => {
          const [assignment, session, run] = item.key.split(".");
          const owner = tx.assignments.get(project, assignment as AssignmentId);
          const launch = tx.runs.get(project, session as RunId);
          const task = tx.runs.get(project, run as RunId);
          if (
            !item.owned ||
            !owner ||
            owner.external ||
            owner.machine_id !== machine.id ||
            launch?.assignment_id !== assignment ||
            task?.assignment_id !== assignment ||
            (launch?.launch_publication &&
              launch.launch_publication.target.fingerprint !==
                execution.target?.fingerprint)
          ) {
            audit(`run_resource skipped_unknown ${machine.id} ${item.key}`);
            return [];
          }
          if (item.closed) {
            audit(`run_resource awaiting_reclaim ${machine.id} ${item.key}`);
            return [];
          }
          if (
            !task ||
            !["completed", "failed", "cancelled"].includes(task.status)
          )
            return [];
          const finished = Date.parse(task.finished_at ?? "");
          if (!Number.isFinite(finished)) {
            audit(`run_resource skipped_unknown ${machine.id} ${item.key}`);
            return [];
          }
          // A 2-day foreground task that just ended is an ordinary close, not
          // a legacy sweep. A missed old close needs *both* age proofs.
          const fallback = now() - finished > age * 1000;
          if (
            fallback &&
            (!item.expired ||
              process.env.CARDIGAN_RUN_RESOURCE_EXPIRED_EXECUTE !== "1")
          ) {
            audit(`run_resource expired_preview ${machine.id} ${item.key}`);
            return [];
          }
          return [{ ...item, expired: fallback }];
        }),
      );
      if (ended.length) {
        if (
          tag !==
          resourceTarget(
            project,
            machine.id,
            targets.resolve(project, machine.id).execution,
          )
        )
          throw new Error();
        await worker(execution, tag, age, ended);
        for (const item of ended)
          audit(`run_resource close_notified ${machine.id} ${item.key}`);
      }
    } catch {
      audit(`run_resource observation_failed ${machine.id}`);
    }
  }
}
