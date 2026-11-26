import {
  type AssignmentId,
  type CardId,
  type Clock,
  type CommandState,
  cancelledQueueRelease,
  type DecisionId,
  DISPATCH_ATTENTION_STATUSES,
  DISPATCH_DIAGNOSTIC_EVENT_TYPES,
  type Event,
  eventById,
  type HumanActionId,
  NEEDS_YOU_ITEM_READY,
  type Notification,
  type NotificationStatus,
  needsYouItemReady,
  newPmNotification,
  type ProjectId,
  pmNotificationState,
  type RunId,
  readyNotices,
  runById,
  states,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  assignmentCanReadCard,
  mergeNotifications,
  type NotificationKind,
  type RoutedNotification,
  routeEvent,
  summarizeNotifications,
} from "@cardigan/router";
import {
  advanceRouterCursor,
  moveNotification,
  PROJECT_EVENT_STREAM,
  recordNotification,
  retireReconcileNotifications,
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
} from "@cardigan/store";

import type { StateLoader } from "./dispatch-state.js";

export const dispatcherClock: Clock = { now: () => new Date().toISOString() };

/** Both first delivery and recovery render the inbox stream, never the recipient's scope. */
export function notificationBell(
  project: ProjectId,
  assignment: AssignmentId,
  run: RunId,
  notes: readonly Notification[],
) {
  const first = notes[0];
  if (!first || notes.some((n) => n.card_id !== first.card_id))
    throw Error("A notification bell requires one non-empty stream");
  const notifications = notes.map((n) => ({
    seq: n.seq,
    kind: n.kind as NotificationKind,
    summary: "",
  }));
  if (first.card_id) {
    const bell = mergeNotifications({
      card_id: first.card_id,
      assignment_id: assignment,
      run_id: run,
      notifications,
    });
    if (!bell) throw Error("Missing bell");
    return bell.text;
  }
  const seqs = notifications.map((n) => n.seq);
  return `[bell] project=${project} asg=${assignment} run=${run} seq=${Math.min(...seqs)}..${Math.max(...seqs)} summary=${JSON.stringify(summarizeNotifications(notifications))}\n→ 请调用 get_updates 读取项目更新`;
}

/** The caller's transaction keeps the audit and its visible explanation together. */
function recordInboxNotice(
  tx: StoreTransactionContext,
  project: ProjectId,
  card: CardId,
  at: string,
  type: string,
  payload: Event["payload"],
  body: string,
) {
  const event: Event = {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project, card),
    card_id: card,
    type,
    actor: { kind: "system", project_id: project },
    payload,
    created_at: at,
  };
  tx.events.append(project, event);
  const id = tx.ids.nextTimelineEntryId(project, card);
  tx.timeline.put(project, {
    id,
    short_id: id,
    card_id: card,
    event_seq: event.seq,
    type: "system",
    author: "system",
    body,
    refs: [],
    mentions: [],
    retracted: false,
    created_at: at,
  });
}
/** A deliberate pre-launch move retires only the old owner's pre-release bells.
 * No ACK impersonation, deletion or suppression of later delivery failures. */
export function retireCancelledQueueNotes(
  store: Store,
  state: CommandState,
  owner: AssignmentId,
  notes: readonly Notification[],
  at: string,
) {
  const rest: Notification[] = [];
  for (const n of notes) {
    const release =
      n.status === "pending" &&
      n.card_id &&
      n.recipient.kind === "assignment" &&
      n.recipient.assignment_id === owner &&
      cancelledQueueRelease(state, n.card_id, owner);
    if (!release || n.seq >= release.seq) {
      rest.push(n);
      continue;
    }
    moveNotification(store.database, {
      project_id: state.project_id,
      id: n.id,
      event: "resolve",
      at,
      patch: { cancelled_queue_release_id: release.id },
    });
  }
  return rest;
}

/** Hand existing work to its new owner without forwarding private mentions,
 * reviving already-settled bells, or changing human assign's explicit-start rule. */
function routeQueueHandoff(
  store: Store,
  state: CommandState,
  event: Event,
  at: string,
) {
  if (event.type !== "work_item_assigned" || !event.card_id) return;
  const p = event.payload as {
    assignment_id?: AssignmentId;
    work_item_id?: string;
    recovery?: { previous_assignment_id?: AssignmentId };
  };
  if (!p?.recovery?.previous_assignment_id) return;
  const owner = state.assignments.find((a) => a.id === p.assignment_id);
  const previous = owner?.recovery?.previous_assignment_id;
  if (
    !previous ||
    previous !== p.recovery.previous_assignment_id ||
    owner?.status !== "active" ||
    owner.scope !== "work_item" ||
    !state.work_items.some(
      (w) =>
        w.id === owner.work_item_id &&
        w.id === p.work_item_id &&
        w.card_id === event.card_id &&
        w.assignment_id === owner.id,
    )
  )
    return;
  const release = cancelledQueueRelease(state, event.card_id, previous);
  if (!release || event.seq <= release.seq) return;
  const query = {
    project_id: state.project_id,
    card_id: event.card_id,
    assignment_id: previous,
  };
  retireCancelledQueueNotes(
    store,
    state,
    previous,
    store.listNotifications({ ...query, status: "pending" }),
    at,
  );
  for (const n of store.listNotifications({ ...query, status: "resolved" })) {
    if (n.cancelled_queue_release_id !== release.id) continue;
    const source = eventById(state.events, n.event_id);
    if (!source || source.card_id !== event.card_id) continue;
    const note = routeEvent({
      event: source,
      snapshot: state,
    }).notifications.find(
      (note) =>
        note.recipient.kind === "assignment" &&
        note.recipient.assignment_id === owner.id,
    );
    if (note) recordRoute(store, state.project_id, note, at);
  }
}
function recordReadyNotice(
  tx: StoreTransactionContext,
  project: ProjectId,
  at: string,
  notice: ReturnType<typeof readyNotices>[number],
) {
  const event: Event = {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project, notice.card_id),
    ...(notice.card_id ? { card_id: notice.card_id } : {}),
    type: NEEDS_YOU_ITEM_READY,
    actor: { kind: "system", project_id: project },
    payload: notice.payload,
    created_at: at,
  };
  tx.events.append(project, event);
  if (!notice.card_id) return;
  const id = tx.ids.nextTimelineEntryId(project, notice.card_id);
  const { human_action_id, decision_id, source_card_id } = notice.payload;
  tx.timeline.put(project, {
    id,
    short_id: id,
    card_id: notice.card_id,
    event_seq: event.seq,
    type: human_action_id ? "human_action" : "system",
    ...(human_action_id
      ? { human_action_id: human_action_id as HumanActionId }
      : {}),
    ...(decision_id ? { decision_id: decision_id as DecisionId } : {}),
    author: "system",
    body: notice.body,
    refs: [{ kind: "card", id: source_card_id }],
    mentions: [],
    retracted: false,
    created_at: at,
  });
}
export function recordRoute(
  store: Store,
  project: ProjectId,
  note: RoutedNotification,
  at: string,
) {
  if (note.recipient.kind === "assignment" && !note.recipient.assignment_id)
    throw new Error("Router returned an Assignment recipient without an id");
  return recordNotification(store.database, {
    project_id: project,
    event_id: note.event_id,
    seq: note.seq,
    kind: note.kind,
    at,
    ...(note.card_id ? { card_id: note.card_id } : {}),
    recipient:
      note.recipient.kind === "assignment"
        ? {
            kind: "assignment",
            assignment_id: note.recipient.assignment_id as AssignmentId,
          }
        : { kind: note.recipient.kind },
  });
}
interface RoutePageOptions {
  loadState?: StateLoader;
  clock?: Clock;
  batchSize?: number;
}
/** Each stream owns its transaction and seq cursor; no cross-card ordering is imposed. */
export function routeStreamEvents(
  store: Store,
  project: ProjectId,
  stream: string,
  options: RoutePageOptions = {},
): number {
  const size = options.batchSize ?? 100;
  if (!Number.isSafeInteger(size) || size < 1 || size > 1000)
    throw new Error("Invalid routing page size");
  return store.uow.run((tx) => {
    // LIMIT inside the indexed seek, not after decoding the entire backlog
    // under the stream write lock. Cursor and notifications still commit together.
    const events = store.database
      .prepare(
        `SELECT doc FROM events WHERE project_id=? AND stream=? AND seq>? ORDER BY seq LIMIT ?`,
      )
      .all(project, stream, store.routerCursor(project, stream), size)
      .map((row) => JSON.parse(String(row.doc)) as Event);
    if (events.length === 0) return 0;
    // C-639: routing reads the routed stream's own history even once closed.
    const snapshot = (options.loadState ?? loadCommandState)(
        tx,
        project,
        undefined,
        { targets: stream ? [stream] : [] },
      ),
      at = (options.clock ?? dispatcherClock).now();
    const announced = new Set<string>();
    for (const event of events) {
      routeQueueHandoff(store, snapshot, event, at);
      const routed = routeEvent({ event, snapshot });
      // C-212: a host action wakes host_ops once it is shown, unless it names
      // an external operator; a deferred one wakes it when it becomes ready.
      const named = (event.payload as { human_action_id?: string })
        .human_action_id;
      const internalHost =
        ((event.type === "human_action_requested" &&
          (event.payload as { disposition?: string }).disposition === "host") ||
          event.type === NEEDS_YOU_ITEM_READY) &&
        snapshot.human_actions.find(
          (h) =>
            h.id === named &&
            h.status === "open" &&
            h.triage === "host" &&
            h.host_operator !== "external" &&
            needsYouItemReady(snapshot, h),
        );
      const owner =
        internalHost &&
        (internalHost.host_assignment_id ??
          snapshot.assignments.find(
            (a) =>
              a.scope === "standing" &&
              a.role_id === "host_ops" &&
              a.status === "active",
          )?.id);
      if (owner)
        recordNotification(store.database, {
          project_id: project,
          event_id: event.id,
          seq: event.seq,
          kind: "human_action",
          at,
          recipient: { kind: "assignment", assignment_id: owner },
          ...(event.card_id ? { card_id: event.card_id } : {}),
        });
      // C-212: a deferred item this event made ready gets its own readable
      // event on its own card; the Router rings its audience from that event.
      for (const notice of readyNotices(snapshot, event)) {
        // The snapshot predates this page; keep one entry per item here too.
        const key = JSON.stringify([
          notice.payload.human_action_id ?? notice.payload.decision_id,
          notice.payload.condition,
        ]);
        if (announced.has(key)) continue;
        announced.add(key);
        recordReadyNotice(tx, project, at, notice);
      }
      const unreadable = routed.problems.filter(
        (p) => p.code === "assignment_cannot_read_card",
      );
      if (event.card_id && unreadable.length)
        recordInboxNotice(
          tx,
          project,
          event.card_id,
          at,
          "comment_mention_redirected",
          {
            source_event_id: event.id,
            source_seq: event.seq,
            problems: unreadable.map((p) => ({ ...p })),
          },
          `评论（事件 #${event.seq}）提及未送达：${unreadable.map((p) => p.detail).join("\n")}`,
        );
      // Ambiguous/unresolved routing must remain visible to Ops, even if no
      // concrete Assignment could be chosen. The source event retains details.
      if (routed.problems.length)
        recordRoute(
          store,
          project,
          {
            recipient: { kind: "pm_ops" },
            kind: "escalation",
            rule: routed.problems[0]?.rule ?? "7.2/unhandled exception",
            event_id: event.id,
            seq: event.seq,
            card_id: event.card_id,
            summary: "Routing requires clarification",
          },
          at,
        );
      for (const note of routed.notifications)
        recordRoute(store, project, note, at);
      advanceRouterCursor(store.database, project, stream, event.seq, at);
    }
    return events.length;
  });
}
/** Discover card streams on every pass, so newly created cards start at their own cursor. */
export function routeProjectEvents(
  store: Store,
  project: ProjectId,
  options: RoutePageOptions = {},
): number {
  const size = options.batchSize ?? 100;
  if (!Number.isSafeInteger(size) || size < 1 || size > 1000)
    throw new Error("Invalid routing page size");
  const streams = store.uow.read((tx) => {
    const candidates = [
      PROJECT_EVENT_STREAM,
      ...tx.cards.list(project).map((c) => c.id),
    ];
    // One indexed seek per stream, without a write transaction or decoding its
    // history when caught up. Use actual events, not allocator reservations.
    return store.database
      .prepare(`SELECT s.value AS stream FROM json_each(?) s
      LEFT JOIN router_cursors r ON r.project_id = ? AND r.stream = s.value
      WHERE EXISTS (SELECT 1 FROM events e WHERE e.project_id = ? AND e.stream = s.value
        AND e.seq > COALESCE(r.last_seq, 0)) ORDER BY CAST(s.key AS INTEGER)`)
      .all(JSON.stringify(candidates), project, project)
      .map((r) => String(r.stream));
  });
  let count = 0;
  for (const stream of streams)
    count += routeStreamEvents(store, project, stream, options);
  return count;
}
export type StandingResolver = (
  project: ProjectId,
  kind: "pm_ops" | "pm_office",
  state: CommandState,
) => AssignmentId | undefined;
/** Bind sent logical recipients to the Run's actual owner, even after reassignment. */
export function notificationOwner(
  note: Notification,
  state: CommandState,
  standing?: StandingResolver,
): AssignmentId | undefined {
  if (note.recipient.kind === "needs_you") return undefined;
  if (note.recipient.kind === "assignment") return note.recipient.assignment_id;
  // C-244: keyed lookup, same first match as runs.find.
  const sent = note.run_id && runById(state.runs, note.run_id);
  if (sent) return sent.assignment_id;
  return standingOwner(note.recipient.kind, state, standing);
}

/** Owner of a role-addressed row that no Run is pinned to. */
export function standingOwner(
  kind: "pm_ops" | "pm_office",
  state: CommandState,
  standing?: StandingResolver,
): AssignmentId | undefined {
  const id = standing?.(state.project_id, kind, state);
  return state.assignments.some(
    (a) => a.id === id && a.scope === "standing" && a.status === "active",
  )
    ? id
    : undefined;
}

const ACKABLE: readonly NotificationStatus[] = [
  "pending",
  "belled",
  "delivery_failed",
];
/** Every notification status except `acked` and `resolved` (C-244). */
export const UNSETTLED_NOTIFICATION_STATUSES: readonly NotificationStatus[] =
  states.notification.filter((s) => s !== "acked" && s !== "resolved");

/**
 * C-244: remember a standing PM resolution per (project, kind, state). The
 * resolver reads the state and the tokens table (legacy rows without
 * `standing_mode`), so use the memo only within one synchronous section that
 * writes neither tokens nor Assignments; a different state object recomputes.
 */
export function memoStanding(
  standing: StandingResolver | undefined,
): StandingResolver | undefined {
  if (!standing) return undefined;
  const memo = new Map<
    string,
    { readonly state: CommandState; readonly id: AssignmentId | undefined }
  >();
  return (project, kind, state) => {
    const key = `${project}\0${kind}`;
    const hit = memo.get(key);
    if (hit?.state === state) return hit.id;
    const id = standing(project, kind, state);
    memo.set(key, { state, id });
    return id;
  };
}

/** Retire legacy cross-card deliveries without impersonating an Agent ACK. */
export function resolveUnreadableNotifications(
  store: Store,
  project: ProjectId,
  clock: Clock = dispatcherClock,
  loadState: StateLoader = loadCommandState,
): number {
  return store.uow.run((tx) => {
    const state = loadState(tx, project),
      at = clock.now();
    let count = 0;
    // C-244: acked and resolved rows were skipped; do not decode them.
    // C-788: nor rows for another recipient kind (owner notices, PM roles)
    // or for standing Assignments, which can read every card.
    for (const note of store.listNotifications({
      project_id: project,
      statuses: UNSETTLED_NOTIFICATION_STATUSES,
      recipient_kind: "assignment",
      exclude_assignment_ids: state.assignments
        .filter((a) => a.scope === "standing")
        .map((a) => a.id),
    })) {
      if (
        !note.card_id ||
        note.recipient.kind !== "assignment" ||
        note.status === "acked" ||
        note.status === "resolved"
      )
        continue;
      const ownerId = note.recipient.assignment_id;
      const owner = state.assignments.find((a) => a.id === ownerId);
      if (
        !owner ||
        assignmentCanReadCard(owner, note.card_id, state.work_items)
      )
        continue;
      moveNotification(store.database, {
        project_id: project,
        id: note.id,
        event: "resolve",
        at,
      });
      recordInboxNotice(
        tx,
        project,
        note.card_id,
        at,
        "notification_resolved",
        {
          notification_id: note.id,
          source_event_id: note.event_id,
          assignment_id: owner.id,
          reason: "recipient_cannot_read_card",
          previous_status: note.status,
        },
        `${owner.id} 无权读取本卡，通知 ${note.id} 已收尾，停止重推；未代为确认。`,
      );
      count++;
    }
    return count;
  });
}
/**
 * C-788: unsettled rows that `obsoleteDispatchAttention` or
 * `settledHumanActionNeedsYou` may match, per the preconditions documented on
 * them: a delivery-problem status, a Run pin, a diagnostic source event, or an
 * owner notice whose source event names human actions. A superset; the caller
 * still applies both predicates to every row returned.
 */
export function listAttentionCandidates(
  store: Store,
  project: ProjectId,
): Notification[] {
  return store.database
    .prepare(
      `SELECT n.doc FROM notifications n
       LEFT JOIN events e ON e.project_id = n.project_id AND e.id = n.event_id
       WHERE n.project_id = ? AND n.status IN (SELECT value FROM json_each(?))
         AND (n.status IN (SELECT value FROM json_each(?))
           OR e.type IN (SELECT value FROM json_each(?))
           -- instr() first: a cheap byte search before parsing the JSON.
           OR (instr(n.doc, '"run_id"') > 0
             AND json_extract(n.doc, '$.run_id') IS NOT NULL)
           OR (n.recipient_kind = 'needs_you'
             AND ((instr(e.doc, '"human_action_id"') > 0
                 AND json_extract(e.doc, '$.payload.human_action_id') IS NOT NULL)
               OR (instr(e.doc, '"reminders"') > 0
                 AND json_type(e.doc, '$.payload.reminders') = 'array'))))
       ORDER BY n.seq, n.id`,
    )
    .all(
      project,
      JSON.stringify(UNSETTLED_NOTIFICATION_STATUSES),
      JSON.stringify(DISPATCH_ATTENTION_STATUSES),
      JSON.stringify(DISPATCH_DIAGNOSTIC_EVENT_TYPES),
    )
    .map((row) => JSON.parse(String(row.doc)) as Notification);
}

/** ACK wins over a late delivery failure; escalated terminal rows are left alone. */
export function acknowledgeInbox(
  store: Store,
  project: ProjectId,
  standing?: StandingResolver,
  clock: Clock = dispatcherClock,
  loadState: StateLoader = loadCommandState,
): number {
  return store.uow.run((tx) => {
    retireReconcileNotifications(store.database, project, clock.now());
    const state = loadState(tx, project);
    const attempts = unfinishedBellAttempts(store.database, project);
    // C-244: this loop only moves notification rows; tokens and Assignments
    // stay as read, so one standing PM resolution per kind serves every row.
    const standingOnce = memoStanding(standing);
    let count = 0;
    // C-244: decode only the statuses this loop handles. C-788: and only rows
    // whose owner's cursor may cover them; the unread backlog (owner
    // notices, external Office bells nobody ACKs) stays pending, unread.
    const pmOps = standingOwner("pm_ops", state, standingOnce),
      pmOffice = standingOwner("pm_office", state, standingOnce);
    for (const note of store.listAckCandidates({
      project_id: project,
      statuses: ACKABLE,
      held: attempts.flatMap((a) => a.notification_ids),
      role_owners: {
        ...(pmOps ? { pm_ops: pmOps } : {}),
        ...(pmOffice ? { pm_office: pmOffice } : {}),
      },
    })) {
      if (!ACKABLE.includes(note.status)) continue;
      const owner =
        attempts.find((a) => a.notification_ids.includes(note.id))
          ?.assignment_id ?? notificationOwner(note, state, standingOnce);
      if (!owner) continue;
      const cursor = tx.cursors.get(project, {
        assignment_id: owner,
        card_id: (note.card_id ?? PROJECT_EVENT_STREAM) as CardId,
      });
      if (cursor && cursor.acked_seq >= note.seq) {
        moveNotification(store.database, {
          project_id: project,
          id: note.id,
          event: "ack",
          at: clock.now(),
        });
        count++;
      }
    }
    return count;
  });
}

/** C3 request retirement is audited resolve, never an ACK or deletion. */
export function resolveObsoletePmNotifications(
  store: Store,
  project: ProjectId,
  clock: Clock,
  loadState: StateLoader,
  standing?: StandingResolver,
) {
  store.uow.run((tx) => {
    const state = loadState(tx, project);
    const held = new Set(
      unfinishedBellAttempts(store.database, project).flatMap(
        (a) => a.notification_ids,
      ),
    );
    // C-788: only rows whose owner can be PM Ops (an unpinned row for a role
    // resolved to Ops, or one addressed to an Ops Assignment); the owner's
    // notices and other inboxes are not decoded on every pass.
    const ops = state.assignments
      .filter(
        (a) =>
          a.scope === "standing" &&
          a.role_id === "pm" &&
          a.standing_mode === "ops",
      )
      .map((a) => a.id);
    if (!ops.length) return;
    const kinds = (["pm_ops", "pm_office"] as const).filter((kind) => {
      const owner = standingOwner(kind, state, standing);
      return !!owner && ops.includes(owner);
    });
    const notes = [
      ...kinds.flatMap((kind) =>
        store.listNotifications({
          project_id: project,
          status: "pending",
          recipient_kind: kind,
        }),
      ),
      ...ops.flatMap((assignment_id) =>
        store.listNotifications({
          project_id: project,
          status: "pending",
          recipient_kind: "assignment",
          assignment_id,
        }),
      ),
    ].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const note of notes) {
      if (held.has(note.id) || !newPmNotification(state, note)) continue;
      const owner = notificationOwner(note, state, standing);
      if (
        !state.assignments.some(
          (a) =>
            a.id === owner &&
            a.scope === "standing" &&
            a.role_id === "pm" &&
            a.standing_mode === "ops",
        )
      )
        continue;
      if (pmNotificationState(state, note) !== "obsolete" || !note.card_id)
        continue;
      moveNotification(store.database, {
        project_id: project,
        id: note.id,
        event: "resolve",
        at: clock.now(),
      });
      recordInboxNotice(
        tx,
        project,
        note.card_id,
        clock.now(),
        "notification_resolved",
        {
          notification_id: note.id,
          source_event_id: note.event_id,
          reason: "pm_request_resolved",
          previous_status: note.status,
        },
        "事项已解决，关闭旧处理请求；保留原事件和结果通知。",
      );
    }
  });
}
