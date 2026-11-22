import type { ProjectId } from "@cardigan/domain";
import {
  previewRunResources,
  type RuntimeTargets,
  resourceTarget,
} from "@cardigan/host";
import type { Store } from "@cardigan/store";
import { type LoopStartup, startTimerLoop } from "./loop.js";

export function resourceExpiry(
  value = process.env.CARDIGAN_RUN_RESOURCE_MAX_AGE_SECONDS,
) {
  if (value === undefined) return 24 * 3600;
  const age = Number(value);
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(age))
    throw new Error("Invalid Run resource expiry");
  return age;
}
/** Snapshot only IDs. Re-resolve status and target immediately before each preview. */
export function startRunResourceLoop(
  store: Store,
  targets: Pick<RuntimeTargets, "resolve">,
  audit: (text: string) => void,
  startup?: LoopStartup,
  intervalMs = 60000,
) {
  let pending: { project: ProjectId; id: string }[] = [];
  return startTimerLoop({
    name: "run_resource",
    startup,
    initialDelayMs: Math.min(intervalMs, 6500),
    intervalMs,
    continueSoon: () => pending.length > 0,
    onError: () => audit("run_resource observation_failed"),
    tick: async () => {
      if (!pending.length)
        pending = store.uow
          .read((tx) =>
            store.listProjects().flatMap(({ id: project }) =>
              tx.machines
                .list(project)
                .filter((m) =>
                  ["online", "degraded", "draining"].includes(m.status),
                )
                .map((m) => ({ project, id: m.id })),
            ),
          )
          .reverse();
      const next = pending.pop();
      if (next)
        await previewMachine(store, targets, next.project, next.id, audit);
    },
  });
}
/** No machine name fallback. An unavailable/changed target retains its resources. */
export async function previewMachine(
  store: Store,
  targets: Pick<RuntimeTargets, "resolve">,
  project: ProjectId,
  id: string,
  audit: (text: string) => void,
  worker = previewRunResources,
) {
  const age = resourceExpiry();
  const machine = store.uow.read((tx) => tx.machines.get(project, id));
  if (!machine || !["online", "degraded", "draining"].includes(machine.status))
    return;
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
