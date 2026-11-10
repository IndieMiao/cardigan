import type { ReactNode } from "react";
import { type STATUS_LABELS, statusLabel } from "../status.js";

// Original geometry, shared by every status surface. No icon-font dependency.
const ring = <circle cx="10" cy="10" r="7.5" />;
const solid = (
  <circle cx="10" cy="10" r="8.5" fill="currentColor" stroke="none" />
);
const shapes = {
  backlog: <circle cx="10" cy="10" r="7.5" strokeDasharray="3 3" />,
  pending: ring,
  dispatched: <circle cx="10" cy="10" r="7.5" strokeDasharray="0.5 3.4" />,
  progress: (
    <>
      {ring}
      <path d="M10 10V2.5A7.5 7.5 0 0 1 17.5 10Z" fill="currentColor" />
    </>
  ),
  review: (
    <>
      {ring}
      <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  merge: (
    <>
      {ring}
      <path d="M6 14v-2a4 4 0 0 1 4-4h4M6 6v2h8m-3-3 3 3-3 3" />
    </>
  ),
  success: (
    <>
      {solid}
      <path className="status-cutout" d="m5.5 10 3 3 6-6" />
    </>
  ),
  error: (
    <>
      {solid}
      <path className="status-cutout" d="M10 5.5v5m0 3v.1" />
    </>
  ),
  cancelled: (
    <>
      {ring}
      <path d="m5 15 10-10" />
    </>
  ),
  idle: <circle cx="10" cy="10" r="5.5" strokeWidth="1.5" />,
  paused: (
    <>
      {ring}
      <path d="M7.5 6.5v7m5-7v7" />
    </>
  ),
  unknown: (
    <>
      <path d="m10 1.5 8.5 8.5-8.5 8.5L1.5 10Z" />
      <path d="M8 7.5a2 2 0 1 1 3.2 1.6c-.8.5-1.2.9-1.2 1.9m0 2.5v.1" />
    </>
  ),
} satisfies Record<string, ReactNode>;

type StatusShape = keyof typeof shapes;
const statusShapes = {
  backlog: "backlog",
  todo: "pending",
  in_progress: "progress",
  review: "review",
  awaiting_merge: "merge",
  done: "success",
  cancelled: "cancelled",
  ready: "pending",
  delivered: "review",
  accepted: "success",
  passed: "success",
  failed: "error",
  changes_requested: "error",
  blocked: "error",
  waiting_decision: "review",
  submitted: "review",
  rejected: "error",
  superseded: "cancelled",
  open: "review",
  provisional: "review",
  resolved: "success",
  withdrawn: "cancelled",
  revoked: "cancelled",
  active: "success",
  suspended: "paused",
  released: "cancelled",
  not_provisioned: "pending",
  provisioning: "progress",
  idle: "idle",
  running: "progress",
  unknown: "unknown",
  lost: "error",
  queued: "pending",
  dispatched: "dispatched",
  acked: "dispatched",
  completed: "success",
  online: "success",
  offline: "error",
  draining: "paused",
  degraded: "error",
  pass: "success",
  approve: "success",
  reject: "error",
  conditional: "review",
  pending: "pending",
  belled: "dispatched",
  delivery_failed: "error",
  needs_attention: "unknown",
  timed_out: "error",
  interrupted: "paused",
  skipped: "cancelled",
} satisfies Record<keyof typeof STATUS_LABELS, StatusShape>;

export function statusShape(status: string): StatusShape {
  return Object.hasOwn(statusShapes, status)
    ? statusShapes[status as keyof typeof statusShapes]
    : "unknown";
}

/** Standalone icons are named; beside a visible label they are decorative. */
export function StatusIcon({
  status,
  decorative = false,
}: {
  status: string;
  decorative?: boolean;
}) {
  const shape = statusShape(status);
  return (
    <svg
      className={`status-icon status-shape-${shape}`}
      viewBox="0 0 20 20"
      width="16"
      height="16"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : statusLabel(status)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shapes[shape]}
    </svg>
  );
}
