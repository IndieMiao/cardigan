import {
  type Assignment,
  type Event,
  eventsOfType,
  parseCapabilityRequirement,
  type Run,
  type WorkItemRequirements,
} from "@cardigan/domain";
import type { ReadRepositories } from "@cardigan/store";

function resourceKeys(capabilities: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const constraint of capabilities) {
    const parsed = parseCapabilityRequirement(constraint);
    if (!parsed.ok) throw new Error("Invalid stored capability requirement");
    keys.add(parsed.value.key);
  }
  return [...keys];
}

/** New admission: template defaults are already on the item; use the pinned role. */
export function assignmentResourceKeys(
  tx: ReadRepositories,
  project: string,
  owner: Assignment,
) {
  if (!owner.work_item_id) return [];
  const item = tx.work_items.get(project, owner.work_item_id);
  const role = tx.roles.get(project, owner);
  return resourceKeys([
    ...(item?.requirements?.capabilities ?? []),
    ...(role?.required_capabilities ?? []),
  ]);
}

function runEvent(history: readonly Event[], run: Run, type: string) {
  return eventsOfType(history, type).find(
    (e) => (e.payload as { run_id?: string }).run_id === run.id,
  );
}

export function wasDispatched(history: readonly Event[], run: Run) {
  return (
    run.started_at !== undefined || !!runEvent(history, run, "run_dispatched")
  );
}

/**
 * Before MC-4 the claim itself had no snapshot. The immutable work_item_updated
 * before-images recover the requirements in force at the time, not today's edit.
 * The claim could be anywhere between queue and dispatch, so keep the union over
 * that interval. With no provable lower bound, hold one of each configured slot.
 */
export function legacyResourceKeys(
  tx: ReadRepositories,
  project: string,
  owner: Assignment,
  run: Run,
  history: readonly Event[],
  configuredKeys: Iterable<string>,
): Iterable<string> {
  if (!owner.work_item_id) return [];
  const item = tx.work_items.get(project, owner.work_item_id);
  const role = tx.roles.get(project, {
    role_id: owner.role_id,
    role_version: run.role_version,
  });
  const queued = runEvent(history, run, "run_queued");
  if (!item || !role || !queued) return configuredKeys;
  const dispatch = runEvent(history, run, "run_dispatched");
  const capabilities = [...(role.required_capabilities ?? [])];
  for (const event of eventsOfType(history, "work_item_updated")) {
    if (event.seq <= queued.seq) continue;
    const edit = event.payload as {
      work_item_id?: string;
      requirements?: WorkItemRequirements;
      previous_requirements?: WorkItemRequirements;
    };
    if (edit.work_item_id !== item.id || edit.requirements === undefined)
      continue;
    if (!edit.previous_requirements) return configuredKeys;
    capabilities.push(...(edit.previous_requirements.capabilities ?? []));
    // The first edit after dispatch records the last possible admission set.
    if (dispatch && event.seq > dispatch.seq) return resourceKeys(capabilities);
  }
  return resourceKeys([
    ...capabilities,
    ...(item.requirements?.capabilities ?? []),
  ]);
}
