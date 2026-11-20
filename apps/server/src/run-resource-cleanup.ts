import type { ProjectId } from "@cardigan/domain";
import {
  previewRunResources,
  type RuntimeTargets,
  resourceTarget,
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
  worker = previewRunResources,
) {
  const age = resourceExpiry();
  for (const machine of store.uow.read((tx) => tx.machines.list(project))) {
    if (!["online", "degraded", "draining"].includes(machine.status)) continue;
    try {
      const { execution } = targets.resolve(project, machine.id);
      const tag = resourceTarget(project, machine.id, execution);
      const { expired, unknown, partial } = await worker(execution, tag, age);
      if (expired || unknown || partial)
        audit(
          `run_resource retained_preview ${machine.id} expired=${expired} unknown=${unknown} partial=${partial}`,
        );
    } catch {
      audit(`run_resource observation_failed ${machine.id}`);
    }
  }
}
