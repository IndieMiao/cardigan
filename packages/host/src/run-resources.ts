import {
  type Assignment,
  type DeliveryId,
  type Event,
  eventById,
  eventsOfType,
  type Notification,
  parseCapabilityRequirement,
  type Run,
  type WorkItem,
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

/**
 * C-721: notices that only ask the producer to submit or reply. Everything
 * else (rework, fix, decision or blocker resume, instructions, dependency
 * wakes) keeps the work item's resources.
 */
const LIGHT_NOTE_KINDS: ReadonlySet<string> = new Set([
  "comment",
  "completion",
  "instruction",
]);

function lightEvent(
  tx: ReadRepositories,
  project: string,
  owner: Assignment,
  item: WorkItem,
  event: Event | undefined,
): boolean {
  if (
    !event ||
    event.actor.project_id !== project ||
    event.card_id !== item.card_id
  )
    return false;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  // A pass routes exactly like an accepted delivery. A passed upstream item
  // starts this item's own work instead.
  const accepted = () => {
    const delivery =
      typeof p.delivery_id === "string"
        ? tx.deliveries.get(project, p.delivery_id as DeliveryId)
        : undefined;
    return (
      delivery !== undefined && !item.depends_on.includes(delivery.work_item_id)
    );
  };
  switch (event.type) {
    case "comment_posted":
      return true;
    case "precheck_finished":
      return (
        event.actor.kind === "system" &&
        p.status === "passed" &&
        p.assignment_id === owner.id &&
        p.work_item_id === item.id
      );
    case "review_submitted":
    case "completion_reviewed":
      return (
        p.verdict === "pass" &&
        p.rework_allowed !== true &&
        p.recheck_required !== true &&
        p.evidence_pending === undefined &&
        p.parallel_late !== true &&
        p.review_limit_wait !== true &&
        !(
          Array.isArray(p.issues) &&
          p.issues.some(
            (i) => (i as { must_fix?: unknown } | null)?.must_fix === true,
          )
        ) &&
        accepted()
      );
    case "delivery_accepted":
      return accepted();
    default:
      return false;
  }
}

/**
 * C-721: the physical resources this Run claims. A producer follow-up whose
 * trigger and every pending notice only ask it to submit or reply claims none;
 * any other Run claims the work item's and role's resources. Pass the notices
 * the Run's bell will carry: a single heavy notice keeps the full set.
 */
export function runResourceKeys(
  tx: ReadRepositories,
  project: string,
  owner: Assignment,
  events: readonly Event[],
  run: { readonly kind: Run["kind"]; readonly trigger_event_id?: string },
  notes: readonly Pick<Notification, "kind" | "event_id">[],
): string[] {
  const keys = assignmentResourceKeys(tx, project, owner);
  if (!keys.length || run.kind !== "followup" || owner.scope !== "work_item")
    return keys;
  const item = owner.work_item_id
    ? tx.work_items.get(project, owner.work_item_id)
    : undefined;
  if (item?.kind !== "produce") return keys;
  const light = (id: string | undefined) =>
    lightEvent(tx, project, owner, item, eventById(events, id));
  return light(run.trigger_event_id) &&
    notes.every((n) => LIGHT_NOTE_KINDS.has(n.kind) && light(n.event_id))
    ? []
    : keys;
}

/**
 * C-721: the work item's resources this admitted Run does not hold. Such a Run
 * gets no device at launch and is told so in every bell. Legacy Runs without
 * an admission snapshot report none.
 */
export function unclaimedResourceKeys(
  tx: ReadRepositories,
  project: string,
  owner: Assignment,
  run: Pick<Run, "resource_keys"> | undefined,
): string[] {
  const held = run?.resource_keys;
  return held
    ? assignmentResourceKeys(tx, project, owner).filter(
        (k) => !held.includes(k),
      )
    : [];
}

function runEvent(history: readonly Event[], run: Run, type: string) {
  return eventsOfType(history, type).find(
    (e) => (e.payload as { run_id?: string }).run_id === run.id,
  );
}

export function wasDispatched(history: readonly Event[], run: Run) {
  return (
    run.status !== "queued" &&
    (run.started_at !== undefined || !!runEvent(history, run, "run_dispatched"))
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
  // Withdrawal reuses the Run ID without emitting a second run_queued. A
  // queued startup has not dispatched *this attempt*: its latest dispatch is
  // a lower bound, not a cutoff. After redispatch the claim lies between the
  // previous and latest dispatches. Order by stream sequence, not wall time.
  const dispatches = eventsOfType(history, "run_dispatched").filter(
    (e) => (e.payload as { run_id?: string }).run_id === run.id,
  );
  const lower = dispatches.at(run.status === "queued" ? -1 : -2) ?? queued;
  // Cancellation is possible on either side of dispatch. If a publication
  // was cancelled before acknowledgment, keep both possibilities open.
  const upper =
    run.status === "queued" ||
    (run.status === "cancelled" && run.launch_publication && !run.started_at)
      ? undefined
      : dispatches.at(-1);
  const capabilities = [...(role.required_capabilities ?? [])];
  for (const event of eventsOfType(history, "work_item_updated")) {
    if (event.seq <= lower.seq) continue;
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
    if (upper && event.seq > upper.seq) return resourceKeys(capabilities);
  }
  return resourceKeys([
    ...capabilities,
    ...(item.requirements?.capabilities ?? []),
  ]);
}
