import type {
  AssignmentId,
  CardId,
  Clock,
  CommandState,
  Event,
  Notification,
  ProjectId,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  assignmentCanReadCard,
  type RoutedNotification,
  routeEvent,
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
import { runById } from "./run-index.js";

export const dispatcherClock: Clock = { now: () => new Date().toISOString() };

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
  const card = stream === PROJECT_EVENT_STREAM ? undefined : (stream as CardId);
  return store.uow.run((tx) => {
    const events = tx.events
      .listAfter(project, card, store.routerCursor(project, stream))
      .slice(0, size);
    if (events.length === 0) return 0;
    const snapshot = (options.loadState ?? loadCommandState)(tx, project),
      at = (options.clock ?? dispatcherClock).now();
    for (const event of events) {
      const routed = routeEvent({ event, snapshot });
      if (
        event.type === "human_action_requested" &&
        (event.payload as { disposition?: string }).disposition === "host"
      ) {
        const ops = snapshot.assignments.find(
          (a) =>
            a.scope === "standing" &&
            a.role_id === "host_ops" &&
            a.status === "active",
        );
        const action = snapshot.human_actions.find(
          (h) =>
            h.id ===
            (event.payload as { human_action_id?: string }).human_action_id,
        );
        if (ops && action?.status === "open" && action.triage === "host")
          recordNotification(store.database, {
            project_id: project,
            event_id: event.id,
            seq: event.seq,
            kind: "human_action",
            at,
            recipient: { kind: "assignment", assignment_id: ops.id },
            ...(event.card_id ? { card_id: event.card_id } : {}),
          });
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
  const streams = store.uow.read((tx) => [
    PROJECT_EVENT_STREAM,
    ...tx.cards.list(project).map((card) => card.id),
  ]);
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
  const id = standing?.(state.project_id, note.recipient.kind, state);
  return state.assignments.some(
    (a) => a.id === id && a.scope === "standing" && a.status === "active",
  )
    ? id
    : undefined;
}

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
    for (const note of store.listNotifications({ project_id: project })) {
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
    for (const note of store.listNotifications({ project_id: project })) {
      if (!["pending", "belled", "delivery_failed"].includes(note.status))
        continue;
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
