import {
  type Assignment,
  type DeliveryId,
  type Event,
  eventById,
  eventsOfType,
  type Notification,
  parseCapabilityRequirement,
  type Run,
  type TimelineEntry,
  type WorkItem,
  type WorkItemRequirements,
} from "@cardigan/domain";
import type { ReadRepositories } from "@cardigan/store";
import { withAndroidDeviceResource } from "./android-devices.js";

function resourceKeys(capabilities: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const constraint of capabilities) {
    const parsed = parseCapabilityRequirement(constraint);
    if (!parsed.ok) throw new Error("Invalid stored capability requirement");
    keys.add(parsed.value.key);
  }
  // C-813: a device narrowed by serial or model still takes a device slot.
  return withAndroidDeviceResource([...keys]);
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

/** C-736: work item states in which a work order can actually start work. */
const EXECUTABLE_STATUSES: ReadonlySet<string> = new Set([
  "in_progress",
  "ready",
  "changes_requested",
]);

/** Explicit `@A-n` / `@W-n` targets written in a comment body. */
const EXPLICIT_MENTION =
  /(?<![\p{L}\p{N}\p{M}_@])@\s*([AaWw]-\d+)(?![\p{L}\p{N}\p{M}_-])/gu;

/**
 * C-736: a comment that orders this producer to work: it names this
 * Assignment or its work item (@A-n / @W-n), or comes from PM (Ops or
 * Office). Ordinary discussion stays a reply.
 */
function commentOrder(
  owner: Assignment,
  item: WorkItem,
  event: Event,
  timeline: readonly TimelineEntry[],
): string | undefined {
  if (event.actor.kind === "assignment" && event.actor.role_id === "pm")
    return "PM 评论";
  const entry = timeline.find(
    (t) => t.card_id === event.card_id && t.event_seq === event.seq,
  );
  const body = (event.payload as { body?: unknown } | null)?.body;
  const named = new Set(
    [
      ...(entry?.mentions ?? []),
      ...(typeof body === "string"
        ? [...body.matchAll(EXPLICIT_MENTION)].map((m) => `@${m[1]}`)
        : []),
    ].map((m) => m.replace(/^@/u, "").toUpperCase()),
  );
  if (named.has(owner.id)) return `评论点名 @${owner.id}`;
  if (named.has(item.id)) return `评论点名 @${item.id}`;
  return undefined;
}

interface Weight {
  readonly light: boolean;
  /** Why, for the Run diagnostics. */
  readonly why: string;
}

function eventWeight(
  tx: ReadRepositories,
  project: string,
  owner: Assignment,
  item: WorkItem,
  event: Event | undefined,
  timeline: readonly TimelineEntry[],
): Weight {
  if (!event) return { light: false, why: "唤起事件不在已加载历史中" };
  if (event.actor.project_id !== project || event.card_id !== item.card_id)
    return { light: false, why: `唤起事件 ${event.type} 不属于本卡` };
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
  const light = (ok: boolean): Weight =>
    ok
      ? { light: true, why: `${event.type} 只需提交或回帖` }
      : { light: false, why: `${event.type} 需要按工作项开工` };
  switch (event.type) {
    case "comment_posted": {
      const order = commentOrder(owner, item, event, timeline);
      if (!order) return { light: true, why: "普通讨论评论" };
      return EXECUTABLE_STATUSES.has(item.status)
        ? { light: false, why: `${order}，工作项处于 ${item.status}` }
        : {
            light: true,
            why: `${order}，但工作项处于 ${item.status}，不可开工`,
          };
    }
    case "precheck_finished":
      return light(
        event.actor.kind === "system" &&
          p.status === "passed" &&
          p.assignment_id === owner.id &&
          p.work_item_id === item.id,
      );
    case "review_submitted":
    case "completion_reviewed":
      return light(
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
          accepted(),
      );
    case "delivery_accepted":
      return light(accepted());
    default:
      return light(false);
  }
}

/** C-736: what a Run claims, and why, for admission and its diagnostics. */
export interface RunResourceClaim {
  readonly keys: string[];
  /** Why it claims or skips them; absent when nothing is required. */
  readonly reason?: string;
}

/**
 * C-721: the physical resources this Run claims. A producer follow-up whose
 * trigger and every pending notice only ask it to submit or reply claims none;
 * any other Run claims the work item's and role's resources. Pass the notices
 * the Run's bell will carry: a single heavy notice keeps the full set.
 * C-736: a comment ordering this producer to work (see `commentOrder`) while
 * its work item can start is not a reply; pass the timeline so explicit
 * mention targets are found.
 */
export function runResourceClaim(
  tx: ReadRepositories,
  project: string,
  owner: Assignment,
  events: readonly Event[],
  run: { readonly kind: Run["kind"]; readonly trigger_event_id?: string },
  notes: readonly Pick<Notification, "kind" | "event_id">[],
  timeline: readonly TimelineEntry[] = [],
): RunResourceClaim {
  const keys = assignmentResourceKeys(tx, project, owner);
  if (!keys.length) return { keys };
  const full = (reason: string) => ({ keys, reason });
  if (run.kind !== "followup") return full(`${run.kind} Run`);
  if (owner.scope !== "work_item") return full("非工作项指派");
  const item = owner.work_item_id
    ? tx.work_items.get(project, owner.work_item_id)
    : undefined;
  if (item?.kind !== "produce") return full("验证项跟进");
  const weigh = (id: string | undefined) =>
    eventWeight(tx, project, owner, item, eventById(events, id), timeline);
  const trigger = weigh(run.trigger_event_id);
  if (!trigger.light) return full(trigger.why);
  for (const n of notes) {
    if (!LIGHT_NOTE_KINDS.has(n.kind)) return full(`待读通知 ${n.kind}`);
    const note = weigh(n.event_id);
    if (!note.light) return full(`待读通知：${note.why}`);
  }
  return { keys: [], reason: trigger.why };
}

/** C-721: the keys of `runResourceClaim`. */
export function runResourceKeys(
  ...args: Parameters<typeof runResourceClaim>
): string[] {
  return runResourceClaim(...args).keys;
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
