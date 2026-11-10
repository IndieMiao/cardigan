// Shared vocabulary for entity types and the transition tables.
export const states = {
  member: ["active", "inactive"],
  employee: ["active", "inactive"],
  card: [
    "backlog",
    "todo",
    "in_progress",
    "review",
    "awaiting_merge",
    "done",
    "cancelled",
  ],
  produce: [
    "todo",
    "ready",
    "in_progress",
    "delivered",
    "accepted",
    "changes_requested",
    "blocked",
    "waiting_decision",
    "cancelled",
  ],
  verify: [
    "todo",
    "ready",
    "in_progress",
    "passed",
    "failed",
    "blocked",
    "waiting_decision",
    "cancelled",
  ],
  assignment: ["active", "suspended", "released"],
  runtime: [
    "not_provisioned",
    "provisioning",
    "idle",
    "running",
    "unknown",
    "lost",
    "released",
  ],
  run: [
    "queued",
    "dispatched",
    "acked",
    "running",
    "completed",
    "failed",
    "cancelled",
    "unknown",
  ],
  delivery: ["submitted", "accepted", "rejected", "superseded"],
  decision: [
    "open",
    "resolved",
    "provisional",
    "withdrawn",
    "superseded",
    "revoked",
  ],
  human_action: ["open", "done", "cancelled"],
  machine: ["online", "degraded", "offline", "draining"],
  approval: ["pending", "approved", "revoked"],
  verdict: ["pass", "reject", "conditional"],
  // M3.2: one inbox row per (event, recipient); see development plan §4.4.
  notification: [
    "pending",
    "belled",
    "acked",
    "delivery_failed",
    "needs_attention",
  ],
} as const;
export type CardStatus = (typeof states.card)[number];
export type EmployeeStatus = (typeof states.employee)[number];
export type ProduceStatus = (typeof states.produce)[number];
export type VerifyStatus = (typeof states.verify)[number];
export type AssignmentStatus = (typeof states.assignment)[number];
export type RuntimeState = (typeof states.runtime)[number];
export type RunStatus = (typeof states.run)[number];
export type NotificationStatus = (typeof states.notification)[number];
export type DeliveryStatus = (typeof states.delivery)[number];
export type DecisionStatus = (typeof states.decision)[number];
export type HumanActionStatus = (typeof states.human_action)[number];
export type MachineStatus = (typeof states.machine)[number];
export type ApprovalStatus = (typeof states.approval)[number];
export type ReviewVerdict = (typeof states.verdict)[number];
export type MemberStatus = (typeof states.member)[number];
