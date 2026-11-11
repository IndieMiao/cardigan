/**
 * `@cardigan/router` — M3.1.
 *
 * Pure routing: one event plus a project snapshot become the recipients and
 * notification kinds of development plan §6.4/§6.5/§7.2, and an Assignment's
 * pending notifications become one merged bell (§6.7, M3 plan §3.2).
 */

export { assignmentCanReadCard } from "@cardigan/domain";
export {
  type BellMessage,
  mergeNotifications,
  summarizeNotifications,
} from "./merge.js";
export {
  type EscalationReason,
  escalation,
  routeBellFailure,
  routeEvent,
  routeRuntimeLost,
  routeWatchdog,
} from "./route.js";
export {
  type NotificationKind,
  payloadObject,
  payloadString,
  payloadStrings,
  type Recipient,
  type RecipientKind,
  type RouteCheck,
  type RoutedNotification,
  type RouteInput,
  type RouteProblem,
  type RouteResult,
  type RouterSnapshot,
  type RuleId,
  recipient,
} from "./types.js";
