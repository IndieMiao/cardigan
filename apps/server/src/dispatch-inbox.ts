import type {
  AssignmentId,
  Clock,
  CommandState,
  Notification,
  ProjectId,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { type RoutedNotification, routeEvent } from "@cardigan/router";
import {
  advanceRouterCursor,
  moveNotification,
  projectEvents,
  recordNotification,
  type Store,
  unfinishedBellAttempts,
} from "@cardigan/store";

export const dispatcherClock: Clock = { now: () => new Date().toISOString() };
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
/** Commit each page and its cursor together, including events from different cards. */
export function routeProjectEvents(
  store: Store,
  project: ProjectId,
  options: { clock?: Clock; batchSize?: number } = {},
): number {
  return store.uow.run((tx) => {
    const events = projectEvents(
      store.database,
      project,
      store.routerCursor(project),
      options.batchSize ?? 100,
    );
    if (events.length === 0) return 0;
    const snapshot = loadCommandState(tx, project),
      at = (options.clock ?? dispatcherClock).now();
    for (const { position, event } of events) {
      const routed = routeEvent({ event, snapshot });
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
      advanceRouterCursor(store.database, project, position, at);
    }
    return events.length;
  });
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
  const sent = note.run_id && state.runs.find((r) => r.id === note.run_id);
  if (sent) return sent.assignment_id;
  const id = standing?.(state.project_id, note.recipient.kind, state);
  return state.assignments.some(
    (a) => a.id === id && a.scope === "standing" && a.status === "active",
  )
    ? id
    : undefined;
}
/** ACK wins over a late delivery failure; escalated terminal rows are left alone. */
export function acknowledgeInbox(
  store: Store,
  project: ProjectId,
  standing?: StandingResolver,
  clock: Clock = dispatcherClock,
): number {
  return store.uow.run((tx) => {
    const state = loadCommandState(tx, project);
    const attempts = unfinishedBellAttempts(store.database, project);
    let count = 0;
    for (const note of store.listNotifications({ project_id: project })) {
      if (
        !note.card_id ||
        !["pending", "belled", "delivery_failed"].includes(note.status)
      )
        continue;
      const owner =
        attempts.find((a) => a.notification_ids.includes(note.id))
          ?.assignment_id ?? notificationOwner(note, state, standing);
      if (!owner) continue;
      const cursor = tx.cursors.get(project, {
        assignment_id: owner,
        card_id: note.card_id,
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
