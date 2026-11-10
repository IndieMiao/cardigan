import { expect, test } from "vitest";
import {
  isEscalatedNotification,
  isTerminalNotification,
  nextNotificationStatus,
} from "./notification.js";
import { states } from "./states.js";
import { transition } from "./transitions.js";

/** M3.2: the notification state machine of development plan §4.4. */

const allowed: ReadonlyArray<[from: string, event: string, to: string]> = [
  ["pending", "bell", "belled"],
  ["pending", "ack", "acked"],
  ["pending", "deliver_failed", "delivery_failed"],
  ["pending", "needs_attention", "needs_attention"],
  ["belled", "ack", "acked"],
  ["belled", "retry", "pending"],
  ["belled", "deliver_failed", "delivery_failed"],
  ["belled", "needs_attention", "needs_attention"],
  // A failed wake may still have landed (§6.8), so an ACK is accepted.
  ["delivery_failed", "ack", "acked"],
  ["delivery_failed", "needs_attention", "needs_attention"],
  ["delivery_failed", "retry", "pending"],
  ["delivery_failed", "bell", "belled"],
  ["delivery_failed", "deliver_failed", "delivery_failed"],
  ...["pending", "belled", "delivery_failed", "needs_attention"].map(
    (from): [string, string, string] => [from, "resolve", "resolved"],
  ),
];

test("every allowed notification transition is in the shared table", () => {
  for (const [from, event, to] of allowed) {
    const result = transition("notification", from as never, event);
    expect(result, `${from} --${event}--> ${to}`).toMatchObject({
      ok: true,
      value: to,
    });
  }
});

test("answered, escalated and resolved states never ring again", () => {
  expect(states.notification.filter(isTerminalNotification)).toEqual([
    "acked",
    "needs_attention",
    "resolved",
  ]);
  // Escalation is what the dispatcher and PM Ops watch for.
  expect(states.notification.filter(isEscalatedNotification)).toEqual([
    "delivery_failed",
    "needs_attention",
  ]);
});

test("an acked notification never rings, retries or fails again", () => {
  for (const event of ["bell", "retry", "deliver_failed", "needs_attention"]) {
    const result = nextNotificationStatus("acked", event as never);
    expect(result.ok, `acked --${event}`).toBe(false);
    if (result.ok) continue;
    expect(result.error.code).toBe("validation_failed");
    expect(result.error.message).toContain(`acked`);
  }
});

test("an escalated notification never rings again", () => {
  for (const event of ["bell", "retry"]) {
    expect(nextNotificationStatus("needs_attention", event as never).ok).toBe(
      false,
    );
  }
  expect(nextNotificationStatus("delivery_failed", "retry")).toEqual({
    ok: true,
    value: "pending",
  });
  expect(nextNotificationStatus("resolved", "retry").ok).toBe(false);
});

test("a pending notification cannot be acknowledged only after a bell was tried out of order", () => {
  // `ack` is allowed from pending (the Agent may poll on its own), but a
  // notification that was never created cannot be belled: unknown rows have no
  // state at all, which the table expresses as a missing row.
  expect(transition("notification", "acked", "ack").ok).toBe(false);
  expect(transition("notification", "pending", "unknown_event").ok).toBe(false);
});

test("the notification table has a row for every state", () => {
  for (const status of states.notification) {
    // Every state is reachable or terminal; none is silently missing.
    const row = transition("notification", status, "ack");
    expect(row.ok || isTerminalNotification(status)).toBe(true);
  }
});
